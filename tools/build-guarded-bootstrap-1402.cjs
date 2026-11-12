#!/usr/bin/env node
"use strict";

/* Offline generator for the guarded 14.02 bootstrap.
 *
 * v2 changes against v1 (2026-11-12):
 *   - Codegen bug fixed: v1 derived kbase into RDX but addressed every check
 *     and write through [r8+rva]. The ioctl path leaves no kernel base in r8,
 *     so the v1 code could never have worked on hardware. All addressing is
 *     now through RCX, exactly like the hardware-proven raw BOOTSTRAP_1400.
 *   - sysent[11].sy_call stock acceptance now covers BOTH the inferred retail
 *     handler (kbase+0x1c07a0) and a genuinely unused slot (NULL). The 14.02
 *     self-dump cannot contain the sysent segment (the dumper only walks text
 *     and the data segment), so the retail value is not offline-verifiable;
 *     a NULL call is the expected shape of an unused PS4 syscall slot.
 *   - sysent[11].sy_thrcnt stock acceptance covers {0,1,4} for the same
 *     reason. narg must remain exactly 0.
 *   - The generated machine code is executed by a small offline interpreter
 *     (tests/guarded-bootstrap-1402-selftest.cjs) against simulated kernel
 *     images before anything ships, so register/base consistency is now
 *     tested, not assumed.
 */
const crypto = require("node:crypto");

const HOST_FREE = 0x130730;
const HOST_LAST = 0x131000;
const HOST_ROOM = HOST_LAST - HOST_FREE;
const TEARDOWN_START = 0x00b3a400;
const TEARDOWN_LENGTH = 0xc8;
const STATUS = Object.freeze({
  PATCHED: 0,
  ALREADY_FINAL: 1,
  REFUSED_MIXED_OR_UNKNOWN: 2,
  TEARDOWN_PADDING_DIRTY: 3,
  READBACK_FAILED_ROLLED_BACK: 4,
  READBACK_FAILED_ROLLBACK_FAILED: 5,
});

/* Hex is in increasing memory-address order. */
const SITES = Object.freeze([
  { id: "bootstrap-mmap-maxprot", rva: 0x490, stock: "ffffffff498b8740", final: "00000000498b8740" },
  { id: "bootstrap-mmap-branches-a", rva: 0x4b5, stock: "720f85c9750b483b", final: "eb0085c9eb00483b" },
  { id: "bootstrap-mmap-branches-b", rva: 0x4b9, stock: "750b483b90f00000", final: "eb00483b90f00000" },
  { id: "bootstrap-mmap-branch-c", rva: 0x4c2, stock: "7269eb0485c97463", final: "eb69eb0485c97463" },
  { id: "bootstrap-syscall-gate", rva: 0xab4, stock: "9090909090909090", final: "ff26909090909090" },
  { id: "bootstrap-mmap-prot-immediates", rva: 0x1faeda, stock: "3341b23331c04531", final: "3741b23731c04531" },
  { id: "sysent11-narg", rva: 0x1102d80, stock: "00000000", final: "02000000" },
  { id: "sysent11-call", rva: 0x1102d88, dynamic: true, stockTargetRva: 0x1c07a0, finalTargetRva: 0xab4, length: 8, stockAltNull: true },
  { id: "sysent11-thrcnt", rva: 0x1102dac, stock: "04000000", final: "01000000", stockAlts: ["00000000", "01000000"] },
]);

const WRITES = Object.freeze([
  { id: "bootstrap-mmap-maxprot", rva: 0x490, width: 4, stock: "ffffffff", final: "00000000" },
  { id: "bootstrap-mmap-branches-a", rva: 0x4b5, width: 2, stock: "720f", final: "eb00" },
  { id: "bootstrap-mmap-branches-b", rva: 0x4b9, width: 2, stock: "750b", final: "eb00" },
  { id: "bootstrap-mmap-branch-c", rva: 0x4c2, width: 1, stock: "72", final: "eb" },
  { id: "bootstrap-syscall-gate", rva: 0xab4, width: 2, stock: "9090", final: "ff26" },
  { id: "sysent11-narg", rva: 0x1102d80, width: 4, stock: "00000000", final: "02000000" },
  { id: "sysent11-call", rva: 0x1102d88, width: 8, dynamic: true, stockTargetRva: 0x1c07a0, finalTargetRva: 0xab4 },
  { id: "sysent11-thrcnt", rva: 0x1102dac, width: 4, stock: "04000000", final: "01000000" },
  { id: "bootstrap-mmap-prot-immediates-a", rva: 0x1faeda, width: 1, stock: "33", final: "37" },
  { id: "bootstrap-mmap-prot-immediates-b", rva: 0x1faedd, width: 1, stock: "33", final: "37" },
]);

function bytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new Error("bad hex");
  return [...Buffer.from(hex, "hex")];
}
function addressHex(kbase, rva) {
  const base = typeof kbase === "string" ? BigInt(kbase.startsWith("0x") ? kbase : "0x" + kbase) : BigInt(kbase);
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt.asUintN(64, base + BigInt(rva)));
  return out.toString("hex");
}
function expected(site, state, kbase) {
  if (!site.dynamic) return site[state];
  if (kbase === undefined) throw new Error("kbase required");
  return addressHex(kbase, state === "stock" ? site.stockTargetRva : site.finalTargetRva);
}

/* Minimal fixed-width assembler. Everything is RCX-relative, matching the
   hardware-proven raw bootstrap: kbase is derived into RCX and every check
   and write addresses [rcx + rva]. */
class Assembler {
  constructor() { this.b = []; this.labels = {}; this.fixups = []; this.trace = []; }
  get offset() { return this.b.length; }
  emit(...xs) { for (const x of xs) { if (!Number.isInteger(x) || x < 0 || x > 255) throw new Error("bad byte"); this.b.push(x); } }
  hex(x) { this.emit(...bytes(x)); }
  u32(x) { x = Number(x) >>> 0; this.emit(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255); }
  label(name) { if (name in this.labels) throw new Error("duplicate label"); this.labels[name] = this.offset; this.trace.push({ type: "label", name, offset: this.offset }); }
  rel(op, label, reason) { this.hex(op); const at = this.offset; this.u32(0); this.fixups.push({ at, label, reason }); }
  jne(label, reason) { this.rel("0f85", label, reason); }
  je(label, reason) { this.rel("0f84", label, reason); }
  jmp(label, reason) { this.rel("e9", label, reason); }
  finish() {
    const out = Buffer.from(this.b);
    for (const f of this.fixups) {
      if (!(f.label in this.labels)) throw new Error("undefined label " + f.label);
      out.writeInt32LE(this.labels[f.label] - (f.at + 4), f.at);
    }
    return out;
  }
}

/* hex-byte string (memory order) -> 32-bit LE value */
function le32(bs) {
  let v = 0;
  for (let i = 0; i < 4; i++) v |= bs[i] << (8 * i);
  return v >>> 0;
}

function emitKbase(a) {
  const start = a.offset;
  a.hex("b9820000c0");            /* mov ecx, 0xc0000082 (MSR_LSTAR) */
  a.hex("0f32");                  /* rdmsr -> edx:eax = LSTAR */
  a.hex("48c1e220");              /* shl rdx, 32 */
  a.hex("89c0");                  /* mov eax, eax */
  a.hex("4809c2");                /* or rdx, rax */
  a.hex("488d8a40feffff");        /* lea rcx, [rdx-0x1c0] -> kbase */
  a.trace.push({ type: "derive-kbase", start, end: a.offset, into: "rcx", subtract: 0x1c0 });
}

/* cmp qword [rcx+rva], rax ; jcc */
function emitCmpRax(a, rva) { a.hex("483981"); a.u32(rva); }
/* cmp dword [rcx+rva], imm32 */
function emitCmpDwordImm32(a, rva, imm) { a.hex("81b9"); a.u32(rva); a.u32(imm); }
/* cmp qword [rcx+rva], 0 */
function emitCmpQwordZero(a, rva) { a.hex("4883b9"); a.u32(rva); a.emit(0); }

/* Emits: for every accepted value V of this site in this state,
 *   cmp [rcx+rva], V ; je L_ok
 * followed by an unconditional jump to the fail label. L_ok falls through to
 * the next check. Stock-only alternates (NULL unused slot, thrcnt variants)
 * are simply additional accepted values. */
function emitCompare(a, site, state, fail, phase) {
  const start = a.offset;
  const okLabel = "ok_" + phase + "_" + site.id;
  const accepted = [];

  const cmpQwordValue = function (hex8) {
    const v = bytes(hex8);
    a.hex("48b8"); a.emit(...v);            /* mov rax, imm64 */
    emitCmpRax(a, site.rva);                /* cmp [rcx+rva], rax */
    a.je(okLabel, phase + ":" + site.id);
  };

  if (site.dynamic) {
    a.hex("488d81"); a.u32(state === "stock" ? site.stockTargetRva : site.finalTargetRva); /* lea rax,[rcx+X] */
    emitCmpRax(a, site.rva);
    a.je(okLabel, phase + ":" + site.id + ":primary");
    accepted.push("kbase+" + (state === "stock" ? site.stockTargetRva : site.finalTargetRva).toString(16));
    if (state === "stock" && site.stockAltNull) {
      emitCmpQwordZero(a, site.rva);
      a.je(okLabel, phase + ":" + site.id + ":null-alt");
      accepted.push("null");
    }
  } else {
    const value = bytes(site[state]);
    if (value.length === 8) {
      cmpQwordValue(site[state]);
      accepted.push(site[state]);
    } else if (value.length === 4) {
      emitCmpDwordImm32(a, site.rva, le32(value));
      a.je(okLabel, phase + ":" + site.id);
      accepted.push(site[state]);
    } else throw new Error("bad compare width");
    if (state === "stock" && site.stockAlts) {
      for (const alt of site.stockAlts) {
        const altBytes = bytes(alt);
        if (altBytes.length === 4) emitCmpDwordImm32(a, site.rva, le32(altBytes));
        else if (altBytes.length === 8) cmpQwordValue(alt);
        else throw new Error("bad alt width");
        a.je(okLabel, phase + ":" + site.id + ":alt");
        accepted.push(alt);
      }
    }
  }
  a.jmp(fail, phase + ":" + site.id);
  a.label(okLabel);
  a.trace.push({ type: "check", phase, state, id: site.id, rva: site.rva, length: site.length || (site.dynamic ? 8 : bytes(site[state]).length), start, end: a.offset, fail, accepted });
}

function emitChecks(a, state, fail, phase) { for (const site of SITES) emitCompare(a, site, state, fail, phase); }

function emitPadding(a, fail) {
  a.hex("31c0");
  for (let off = 0; off < TEARDOWN_LENGTH; off += 8) {
    const start = a.offset;
    emitCmpQwordZero(a, TEARDOWN_START + off);
    a.jne(fail, "padding:" + off);
    a.trace.push({ type: "padding-check", rva: TEARDOWN_START + off, length: 8, start, end: a.offset, fail });
  }
}

function emitWrite(a, spec, state, phase) {
  const start = a.offset;
  if (spec.dynamic) {
    a.hex("488d91"); a.u32(state === "stock" ? spec.stockTargetRva : spec.finalTargetRva); /* lea rdx,[rcx+X] */
    a.hex("488991"); a.u32(spec.rva);                                               /* mov [rcx+rva], rdx */
  } else {
    const value = bytes(spec[state]);
    if (value.length !== spec.width) throw new Error("write width mismatch");
    if (spec.width === 1) { a.hex("c681"); a.u32(spec.rva); a.emit(...value); }
    else if (spec.width === 2) { a.hex("66c781"); a.u32(spec.rva); a.emit(...value); }
    else if (spec.width === 4) { a.hex("c781"); a.u32(spec.rva); a.emit(...value); }
    else throw new Error("bad write width");
  }
  a.trace.push({ type: "write", phase, state, id: spec.id, rva: spec.rva, width: spec.width, start, end: a.offset });
}

function emitFence(a, phase, purpose) {
  const start = a.offset;
  a.hex("0faef0");
  a.trace.push({ type: "barrier", phase, purpose, start, end: a.offset });
}

function emitBracket(a, state, phase) {
  const start = a.offset;
  a.hex("9cfa0f20c0504825fffffeff0f22c0"); /* pushfq; cli; save CR0; clear WP */
  const writesStart = a.offset;
  const activation = WRITES.find((spec) => spec.id === "sysent11-call");
  const dependencies = WRITES.filter((spec) => spec !== activation);
  if (state === "final") {
    for (const spec of dependencies) emitWrite(a, spec, state, phase);
    emitFence(a, phase, "publish-before-activation");
    emitWrite(a, activation, state, phase);
  } else {
    emitWrite(a, activation, state, phase);
    emitFence(a, phase, "publish-deactivation");
    for (const spec of dependencies) emitWrite(a, spec, state, phase);
  }
  const writesEnd = a.offset;
  emitFence(a, phase, "flush-before-wp-restore");
  a.hex("580f22c09d");                     /* pop rax; mov cr0, rax; popfq */
  a.trace.push({ type: "write-bracket", phase, state, start, writesStart, writesEnd, end: a.offset });
}

function emitReturn(a, name) {
  const start = a.offset;
  a.hex("b8"); a.u32(STATUS[name]); a.hex("c3");
  a.trace.push({ type: "return", status: name, value: STATUS[name], start, end: a.offset });
}

function build() {
  const a = new Assembler();
  a.label("entry"); emitKbase(a);
  emitChecks(a, "stock", "check-final", "preflight-stock");
  emitPadding(a, "padding-dirty");
  emitBracket(a, "final", "apply-final");
  emitChecks(a, "final", "rollback", "readback-final");
  emitReturn(a, "PATCHED");
  a.label("rollback");
  emitBracket(a, "stock", "rollback-stock");
  emitChecks(a, "stock", "rollback-failed", "readback-stock");
  emitReturn(a, "READBACK_FAILED_ROLLED_BACK");
  a.label("rollback-failed"); emitReturn(a, "READBACK_FAILED_ROLLBACK_FAILED");
  a.label("check-final");
  emitChecks(a, "final", "refused", "preflight-final");
  emitReturn(a, "ALREADY_FINAL");
  a.label("padding-dirty"); emitReturn(a, "TEARDOWN_PADDING_DIRTY");
  a.label("refused"); emitReturn(a, "REFUSED_MIXED_OR_UNKNOWN");
  const code = a.finish();
  if (code.length > HOST_ROOM) throw new Error("bootstrap exceeds host room");
  return Object.freeze({ code, hex: code.toString("hex"), sha256: crypto.createHash("sha256").update(code).digest("hex"), size: code.length, room: HOST_ROOM, labels: Object.freeze({ ...a.labels }), fixups: Object.freeze(a.fixups.map(Object.freeze)), trace: Object.freeze(a.trace.map(Object.freeze)) });
}

function matchesAny(site, memory, state, kbase) {
  const primary = expected(site, state, kbase);
  if (memory[site.id] === primary) return true;
  if (state === "stock" && site.stockAltNull && memory[site.id] === "0000000000000000") return true;
  if (state === "stock" && site.stockAlts) for (const alt of site.stockAlts) if (memory[site.id] === alt) return true;
  return false;
}
function snapshot(state, kbase) { return Object.fromEntries(SITES.map((s) => [s.id, expected(s, state, kbase)])); }
function snapshotWith(state, kbase, overrides) { return Object.assign(snapshot(state, kbase), overrides || {}); }
/* Specification simulator only; it does not execute native code. */
function simulate(input, options = {}) {
  const memory = { ...input }, writes = [], kbase = options.kbase;
  const ok = (state) => SITES.every((s) => matchesAny(s, memory, state, kbase));
  if (ok("final")) return { status: STATUS.ALREADY_FINAL, memory, writes };
  if (!ok("stock")) return { status: STATUS.REFUSED_MIXED_OR_UNKNOWN, memory, writes };
  if (options.paddingZero === false) return { status: STATUS.TEARDOWN_PADDING_DIRTY, memory, writes };
  for (const s of SITES) { memory[s.id] = expected(s, "final", kbase); writes.push({ phase: "apply-final", id: s.id }); }
  for (const id of options.failFinalIds || []) memory[id] = "bad";
  if (ok("final")) return { status: STATUS.PATCHED, memory, writes };
  for (const s of SITES) { memory[s.id] = expected(s, "stock", kbase); writes.push({ phase: "rollback-stock", id: s.id }); }
  for (const id of options.failRollbackIds || []) memory[id] = "bad";
  return { status: ok("stock") ? STATUS.READBACK_FAILED_ROLLED_BACK : STATUS.READBACK_FAILED_ROLLBACK_FAILED, memory, writes };
}

function manifest(r) {
  return { version: "guarded-bootstrap-1402-v2", offlineOnly: true, integrated: true, baseRegister: "rcx", hostFree: "0x" + HOST_FREE.toString(16), hostLast: "0x" + HOST_LAST.toString(16), room: r.room, size: r.size, sha256: r.sha256, statuses: STATUS, sites: SITES, writes: WRITES, teardown: { startRva: "0x" + TEARDOWN_START.toString(16), length: TEARDOWN_LENGTH, endRvaInclusive: "0x" + (TEARDOWN_START + TEARDOWN_LENGTH - 1).toString(16) }, labels: r.labels, hex: r.hex };
}

module.exports = Object.freeze({ HOST_FREE, HOST_LAST, HOST_ROOM, TEARDOWN_START, TEARDOWN_LENGTH, STATUS, SITES, WRITES, expected, snapshot, snapshotWith, matchesAny, simulate, build, manifest });
if (require.main === module) process.stdout.write(JSON.stringify(manifest(build()), null, 2) + "\n");
