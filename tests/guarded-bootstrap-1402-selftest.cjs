"use strict";

/* Executes the guarded 14.02 bootstrap's generated machine code in a small
 * offline x86-64 interpreter against simulated kernel images. This validates
 * the actual code (register use, branch targets, write order), not just the
 * specification: the v1 builder derived kbase into RDX but addressed memory
 * through [r8+rva], and only executing the code catches that class of bug.
 * The instruction subset is exactly what the builder emits. */

const assert = require("node:assert/strict");
const path = require("node:path");
const guarded = require(path.join(__dirname, "..", "tools", "build-guarded-bootstrap-1402.cjs"));

/* ------------------------------------------------------------------ emulator */

function makeEmulator(code, image, opts) {
  opts = opts || {};
  const veto = opts.vetoWritesAt || []; /* RVAs where writes silently fail */
  const vetoRollback = opts.vetoRollbackWritesAt || []; /* RVAs where ROLLBACK writes fail (apply-final writes still stick) */
  /* write brackets open with this exact prologue; the second one is the rollback */
  const PROLOGUE = Buffer.from("9cfa0f20c0504825fffffeff0f22c0", "hex");
  const bracketStarts = [];
  for (let i = 0; i + PROLOGUE.length <= code.length; i++) {
    if (Buffer.from(code.slice(i, i + PROLOGUE.length)).equals(PROLOGUE)) bracketStarts.push(i);
  }
  const KBASE = 0xffffffff96810000n;
  const LSTAR = KBASE + 0x1c0n;
  const regs = { rax: 0n, rcx: 0n, rdx: 0n };
  const stack = [];
  let zf = false;
  let rip = 0;
  let steps = 0;

  const fetch = (off) => code[off];
  const u32 = (rva) => { let v = 0; for (let i = 0; i < 4; i++) v |= image[Number(rva) + i] << (8 * i); return v >>> 0; };
  const u64 = (rva) => { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(image[Number(rva) + i]) << BigInt(8 * i); return v; };
  const write = (rva, bytes) => {
    const inRollback = bracketStarts.length === 2 && rip >= bracketStarts[1];
    const activeVeto = inRollback ? veto.concat(vetoRollback) : veto;
    if (activeVeto.includes(Number(rva))) return; /* silently drop */
    for (let i = 0; i < bytes.length; i++) image[Number(rva) + i] = bytes[i];
  };
  const imm32 = () => { let v = 0; for (let i = 0; i < 4; i++) v |= fetch(rip + i) << (8 * i); rip += 4; return v >>> 0; };
  const imm64 = () => { let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(fetch(rip + i)) << BigInt(8 * i); rip += 8; return v; };
  const rel32 = () => { let v = 0; for (let i = 0; i < 4; i++) v |= fetch(rip + i) << (8 * i); rip += 4; return v | 0; };
  const cmpEq = (a, b) => { zf = a === b; };

  function step() {
    steps++;
    if (steps > 200000) throw new Error("emulator: step limit exceeded (runaway branch?)");
    const at = rip;
    const op = fetch(rip++);
    if (op === 0xb9) { regs.rcx = BigInt(imm32()); return; }                    /* mov ecx, imm32 */
    if (op === 0xb8) { regs.rax = BigInt(imm32()); return; }                     /* mov eax, imm32 */
    if (op === 0x31 && fetch(rip) === 0xc0) { rip++; regs.rax = 0n; zf = true; return; } /* xor eax,eax */
    if (op === 0x9c) { stack.push(zf); return; }                                 /* pushfq */
    if (op === 0x9d) { zf = stack.pop(); return; }                               /* popfq */
    if (op === 0xfa) return;                                                     /* cli */
    if (op === 0x50) { stack.push(regs.rax); return; }                           /* push rax */
    if (op === 0x58) { regs.rax = stack.pop(); return; }                         /* pop rax */
    if (op === 0xc3) return "ret";                                              /* ret */
    if (op === 0xe9) { const d = rel32(); rip = at + 5 + d; return; }            /* jmp rel32 */
    if (op === 0x66) { /* word-size prefix: mov word [rcx+d], imm16 */
      assert.equal(fetch(rip), 0xc7); rip++;
      assert.equal(fetch(rip), 0x81); rip++;
      const rva = imm32();
      const imm = fetch(rip) | (fetch(rip + 1) << 8); rip += 2;
      write(rva, [imm & 255, (imm >>> 8) & 255]);
      return;
    }
    if (op === 0x0f) {
      const op2 = fetch(rip++);
      if (op2 === 0x32) { /* rdmsr: edx:eax = LSTAR */
        regs.rax = LSTAR & 0xffffffffn; regs.rdx = LSTAR >> 32n; return;
      }
      if (op2 === 0x20) { /* mov rax, cr0 */
        assert.equal(fetch(rip), 0xc0); rip++; return; /* cr0 tracked implicitly */
      }
      if (op2 === 0x22) { /* mov cr0, rax */
        assert.equal(fetch(rip), 0xc0); rip++; return;
      }
      if (op2 === 0xae) { /* mfence */
        assert.equal(fetch(rip), 0xf0); rip++; return;
      }
      if (op2 === 0x84) { const d = rel32(); if (zf) rip = at + 6 + d; return; } /* je */
      if (op2 === 0x85) { const d = rel32(); if (!zf) rip = at + 6 + d; return; } /* jne */
      throw new Error("emulator: unsupported 0f " + op2.toString(16) + " at " + at.toString(16));
    }
    if (op === 0x48) {
      const op2 = fetch(rip++);
      if (op2 === 0xc1) { /* shl rdx, 32 */
        assert.equal(fetch(rip), 0xe2); rip++;
        assert.equal(fetch(rip), 0x20); rip++;
        regs.rdx = (regs.rdx << 32n) & 0xffffffffffffffffn; return;
      }
      if (op2 === 0x89) { /* mov [rcx+d], rdx */
        assert.equal(fetch(rip), 0x91); rip++;
        const rva = imm32();
        let v = regs.rdx;
        const b = []; for (let i = 0; i < 8; i++) { b.push(Number(v & 255n)); v >>= 8n; }
        write(rva, b); return;
      }
      if (op2 === 0x09) { /* or rdx, rax */
        assert.equal(fetch(rip), 0xc2); rip++;
        regs.rdx = (regs.rdx | regs.rax) & 0xffffffffffffffffn; return;
      }
      if (op2 === 0x25) { regs.rax &= BigInt(imm32() | 0); return; }  /* and rax, imm32 (sign-ext) */
      if (op2 === 0x0d) { regs.rax |= BigInt(imm32() >>> 0); return; } /* or rax, imm32 */
      if (op2 === 0x8d) { /* lea */
        const modrm = fetch(rip++);
        const d = imm32();
        const reg = (modrm >> 3) & 7, rm = modrm & 7;
        assert.equal(modrm & 0xc0, 0x80, "lea expects disp32");
        const base = rm === 1 ? regs.rcx : rm === 2 ? regs.rdx : null;
        if (base === null) throw new Error("lea base must be rcx or rdx, got rm=" + rm);
        const src = (base + BigInt(d | 0)) & 0xffffffffffffffffn;
        if (reg === 0) regs.rax = src; else if (reg === 1) regs.rcx = src; else if (reg === 2) regs.rdx = src;
        else throw new Error("lea to unsupported reg " + reg);
        return;
      }
      if (op2 === 0xb8) { regs.rax = imm64(); return; }                         /* mov rax, imm64 */
      if (op2 === 0x39) { /* cmp [rcx+d], rax */
        assert.equal(fetch(rip), 0x81); rip++;
        const rva = imm32();
        cmpEq(u64(rva), regs.rax); return;
      }
      if (op2 === 0x83) { /* cmp qword [rcx+d], imm8 */
        assert.equal(fetch(rip), 0xb9); rip++;
        const rva = imm32();
        const imm = BigInt(fetch(rip) << 24 >> 24); rip++;
        cmpEq(u64(rva), imm); return;
      }
      throw new Error("emulator: unsupported 48 " + op2.toString(16) + " at " + at.toString(16));
    }
    if (op === 0x89) { /* mov eax, eax (zero-extend) */
      assert.equal(fetch(rip), 0xc0); rip++;
      regs.rax &= 0xffffffffn; return;
    }
    if (op === 0xc6) { /* mov byte [rcx+d], imm8 */
      assert.equal(fetch(rip), 0x81); rip++;
      const rva = imm32();
      write(rva, [fetch(rip)]); rip++; return;
    }
    if (op === 0xc7) { /* mov dword [rcx+d], imm32 */
      assert.equal(fetch(rip), 0x81); rip++;
      const rva = imm32();
      const imm = imm32();
      write(rva, [imm & 255, (imm >>> 8) & 255, (imm >>> 16) & 255, (imm >>> 24) & 255]); return;
    }
    if (op === 0x81) { /* cmp dword [rcx+d], imm32 */
      assert.equal(fetch(rip), 0xb9); rip++;
      const rva = imm32();
      const imm = imm32();
      cmpEq(BigInt(u32(rva)), BigInt(imm)); return;
    }
    throw new Error("emulator: unsupported opcode " + op.toString(16) + " at " + at.toString(16));
  }

  return {
    run() {
      for (;;) {
        const r = step();
        if (r === "ret") return Number(regs.rax & 0xffffffffn);
      }
    },
  };
}

/* ------------------------------------------------------------------ images */

const MEM_SIZE = 0x1200000;
function blankImage() { return new Uint8Array(MEM_SIZE); }
function hexToBytes(h) { return [...Buffer.from(h, "hex")]; }
function plant(image, rva, h) { const b = hexToBytes(h); for (let i = 0; i < b.length; i++) image[rva + i] = b[i]; }

const KB = "ffffffff96810000";
function stockImage(overrides) {
  const image = blankImage();
  for (const site of guarded.SITES) {
    let hex = site.stock;
    if (site.dynamic) hex = guarded.expected(site, "stock", KB);
    plant(image, site.rva, hex);
  }
  if (overrides) for (const [id, hex] of Object.entries(overrides)) {
    const site = guarded.SITES.find((s) => s.id === id);
    plant(image, site.rva, hex);
  }
  return image;
}
function finalImage() {
  const image = blankImage();
  for (const site of guarded.SITES) {
    let hex = site.final;
    if (site.dynamic) hex = guarded.expected(site, "final", KB);
    plant(image, site.rva, hex);
  }
  return image;
}
function readSite(image, site) {
  const len = site.length || hexToBytes(site.stock || "00000000").length;
  let out = "";
  for (let i = 0; i < len; i++) out += ("0" + image[site.rva + i].toString(16)).slice(-2);
  return out;
}
function siteById(id) { return guarded.SITES.find((s) => s.id === id); }

/* ------------------------------------------------------------------ build */

const built = guarded.build();
assert.ok(built.size <= guarded.HOST_ROOM, "bootstrap fits the libc tail room");
assert.ok(built.size > 1200, "bootstrap is not suspiciously small");
assert.equal(built.code[0], 0xb9, "entry starts with mov ecx, MSR index");

/* the generated code must execute: stock (primary) image -> PATCHED */
{
  const image = stockImage();
  const rc = makeEmulator(built.code, image).run();
  assert.equal(rc, guarded.STATUS.PATCHED, "stock image patches cleanly, rc=" + rc);
  for (const site of guarded.SITES) {
    const want = site.dynamic ? guarded.expected(site, "final", KB) : site.final;
    assert.equal(readSite(image, site), want, "site " + site.id + " final after patch");
  }
}

/* stock with a NULL unused sysent[11] slot -> still PATCHED */
{
  const image = stockImage({ "sysent11-call": "0000000000000000", "sysent11-thrcnt": "00000000" });
  const rc = makeEmulator(built.code, image).run();
  assert.equal(rc, guarded.STATUS.PATCHED, "NULL sysent slot accepted, rc=" + rc);
}

/* stock with thrcnt 1 -> still PATCHED */
{
  const image = stockImage({ "sysent11-thrcnt": "01000000" });
  const rc = makeEmulator(built.code, image).run();
  assert.equal(rc, guarded.STATUS.PATCHED, "thrcnt=1 accepted, rc=" + rc);
}

/* all-final -> ALREADY_FINAL, memory untouched */
{
  const image = finalImage();
  const rc = makeEmulator(built.code, image).run();
  assert.equal(rc, guarded.STATUS.ALREADY_FINAL, "final image reports already-final, rc=" + rc);
  for (const site of guarded.SITES) {
    const want = site.dynamic ? guarded.expected(site, "final", KB) : site.final;
    assert.equal(readSite(image, site), want, "final image untouched at " + site.id);
  }
}

/* mixed -> REFUSED, nothing written */
{
  const image = stockImage({ "bootstrap-syscall-gate": "ff26909090909090" });
  const rc = makeEmulator(built.code, image).run();
  assert.equal(rc, guarded.STATUS.REFUSED_MIXED_OR_UNKNOWN, "mixed image refused, rc=" + rc);
  const site = siteById("bootstrap-mmap-maxprot");
  assert.equal(readSite(image, site), site.stock, "refused run wrote nothing");
}

/* dirty teardown padding -> TEARDOWN_PADDING_DIRTY, nothing written */
{
  const image = stockImage();
  plant(image, guarded.TEARDOWN_START + 0x40, "deadbeefdeadbeef");
  const rc = makeEmulator(built.code, image).run();
  assert.equal(rc, guarded.STATUS.TEARDOWN_PADDING_DIRTY, "dirty padding refused, rc=" + rc);
}

/* a final write that does not stick -> rollback to stock -> rc 4 */
{
  const image = stockImage();
  const rc = makeEmulator(built.code, image, { vetoWritesAt: [siteById("sysent11-thrcnt").rva] }).run();
  assert.equal(rc, guarded.STATUS.READBACK_FAILED_ROLLED_BACK, "failed write rolls back, rc=" + rc);
  for (const site of guarded.SITES) {
    const want = site.dynamic ? guarded.expected(site, "stock", KB) : site.stock;
    assert.equal(readSite(image, site), want, "rollback restored " + site.id);
  }
}

/* rollback that also fails -> rc 5 */
{
  const image = stockImage();
  const rc = makeEmulator(built.code, image, {
    vetoWritesAt: [siteById("sysent11-thrcnt").rva],
    vetoRollbackWritesAt: [siteById("bootstrap-syscall-gate").rva],
  }).run();
  assert.equal(rc, guarded.STATUS.READBACK_FAILED_ROLLBACK_FAILED, "double failure reported, rc=" + rc);
}

/* specification simulator agreement on the classic cases */
{
  const kbase = KB;
  let r = guarded.simulate(guarded.snapshot("stock", kbase), { kbase });
  assert.equal(r.status, guarded.STATUS.PATCHED);
  r = guarded.simulate(guarded.snapshot("final", kbase), { kbase });
  assert.equal(r.status, guarded.STATUS.ALREADY_FINAL);
  r = guarded.simulate(guarded.snapshotWith("stock", kbase, { "sysent11-call": "0000000000000000" }), { kbase });
  assert.equal(r.status, guarded.STATUS.PATCHED);
  r = guarded.simulate(guarded.snapshotWith("stock", kbase, { "bootstrap-syscall-gate": "ff26909090909090" }), { kbase });
  assert.equal(r.status, guarded.STATUS.REFUSED_MIXED_OR_UNKNOWN);
}

/* the hex embedded in site/afterglow-g.js must be exactly what this builder
   emits -- regenerate with `node tools/build-guarded-bootstrap-1402.cjs`
   whenever the sites change, and keep both in sync */
{
  const fs = require("node:fs");
  const src = fs.readFileSync(require("node:path").join(__dirname, "..", "site", "afterglow-g.js"), "utf8");
  const m = src.match(/const BOOTSTRAP_1402 =\n([\s\S]*?);/);
  assert.ok(m, "BOOTSTRAP_1402 definition found in site/afterglow-g.js");
  const embedded = m[1].replace(/"[^"]*"/g, "").replace(/[\s+]/g, "");
  const pieces = m[1].match(/"([0-9a-fA-F]*)"/g) || [];
  const hex = pieces.map((q) => q.replace(/"/g, "")).join("");
  assert.equal(hex, built.hex,
    "site/afterglow-g.js BOOTSTRAP_1402 is out of sync with the builder -- regenerate it");
  assert.ok(/guarded-bootstrap-1402-v2/.test(src), "afterglow-g.js documents the guarded bootstrap version");
}

console.log(JSON.stringify({ ok: true, version: "guarded-bootstrap-1402-v2", size: built.size, room: guarded.HOST_ROOM, sha256: built.sha256, sites: guarded.SITES.length, intendedWrites: guarded.WRITES.length }));
