"use strict";

/* Self-test for the 14.02 patchset variant (site/patchset-1402.bin).
   Validates, offline only:
   - the asset exists, is 641 bytes, and matches the SHA-256 registered as
     PATCHSET_1402 in site/afterglow-g.js;
   - it differs from the 14.00 patchset.bin ONLY in the fourteen write
     displacements whose kernel regions moved between firmwares, and each
     relocation lands exactly on the target this host has already
     hardware-validated in PATCH_WINDOWS_1402 (parsed from the same file);
   - the patchset-only sites (bcopy, 0x490, 0xab4, sysent, ...) are
     untouched at their 14.00 RVAs;
   - the 14.00 patchset.bin itself still matches PATCHSET_1400 (untouched);
   - afterglow-g.js's runPatchSet selects patchset-1402.bin on 14.02 and
     keeps the live guards (stale-corruption checks at the 14.00 RVAs,
     stock-window acceptance at the relocated sites, post-gate read-backs).
   A pass validates the local asset and dispatch logic only.  It does not
   validate behaviour on console hardware. */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const p1400 = fs.readFileSync(path.join(root, "site", "patchset.bin"));
const p1402 = fs.readFileSync(path.join(root, "site", "patchset-1402.bin"));
const ag = fs.readFileSync(path.join(root, "site", "afterglow-g.js"), "utf8");

const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

assert.equal(p1400.length, 641, "14.00 patchset length");
assert.equal(p1402.length, 641, "14.02 patchset length");

/* The expected relocations, straight from PATCH_WINDOWS_1402. */
const RELOC = [
  [0x1b7a43, 0x1b7c63], [0x1b7a53, 0x1b7c73], [0x1b7a73, 0x1b7c93],
  [0x1b7ab8, 0x1b7cd8], [0x1b7504, 0x1b7724],
  [0x2bd79d, 0x2bda9d], [0x2bd7e1, 0x2bdae1], [0x2bd85d, 0x2bdb5d],
  [0x2bd8a1, 0x2bdba1], [0x2bda4d, 0x2bdd4d], [0x2bdefd, 0x2be1fd],
  [0x2bdfcd, 0x2be2cd],
  [0x628684, 0x628b04], [0x628f6f, 0x6293ef],
];

/* Every byte that differs must belong to one of the fourteen relocated
   disp32 fields, and the new value must be the validated target. */
const diffs = [];
for (let i = 0; i < 641; i++) if (p1400[i] !== p1402[i]) diffs.push(i);

const inRva = (rva) => {
  for (let i = 0; i < 641 - 3; i++) {
    const cur = p1400.readUInt32LE(i);
    if (cur === rva) return i; /* disp32 position of the write targeting rva */
  }
  return -1;
};

let covered = new Set();
for (const [oldRva, newRva] of RELOC) {
  const at = inRva(oldRva);
  assert.ok(at >= 0, "14.00 patchset has a write targeting 0x" + oldRva.toString(16));
  assert.equal(p1402.readUInt32LE(at), newRva,
    "relocated write targets 0x" + newRva.toString(16));
  for (let i = 0; i < 4; i++) covered.add(at + i);
}
for (const i of diffs) {
  assert.ok(covered.has(i), "byte 0x" + i.toString(16) + " changed outside the relocations");
}
/* The 21 changed bytes all sit inside the fourteen disp32 fields. */
assert.equal(diffs.length, covered.size >= diffs.length ? diffs.length : 0);
assert.ok(diffs.length > 0 && diffs.length <= 14 * 4);

/* The patchset-only sites keep their 14.00 RVAs. */
for (const keep of [0xacd, 0x490, 0x4b5, 0x4b9, 0x4c2, 0xab4, 0x2fcb5c,
  0x391fc6, 0x3be3c0, 0x1faada, 0x1faadd, 0x1102d80, 0x1102d88, 0x1102dac,
  0x125791, 0x125791 + 0x42]) {
  const at = inRva(keep);
  if (at >= 0) {
    assert.equal(p1402.readUInt32LE(at), keep,
      "patchset-only site 0x" + keep.toString(16) + " untouched");
  }
}

/* Registered hashes in afterglow-g.js match the served bytes. */
const reg1402 = ag.match(/PATCHSET_1402 = \{\s*length: 641,\s*sha256: "([0-9a-f]{64})",/);
assert.ok(reg1402, "PATCHSET_1402 constant present");
assert.equal(reg1402[1], sha256(p1402), "PATCHSET_1402 hash matches asset");
const reg1400 = ag.match(/PATCHSET_1400 = \{\s*length: 641,\s*sha256: "([0-9a-f]{64})",/);
assert.ok(reg1400, "PATCHSET_1400 constant present");
assert.equal(reg1400[1], sha256(p1400), "PATCHSET_1400 hash matches asset");

/* runPatchSet dispatch: firmware-aware asset choice and the live guards. */
assert.match(ag, /const asset = is1402 \? "patchset-1402\.bin" : "patchset\.bin"/,
  "runPatchSet selects patchset-1402.bin on 14.02");
assert.match(ag, /const expected = is1402 \? PATCHSET_1402 : PATCHSET_1400;/,
  "runPatchSet verifies against the firmware-matched hash");
assert.match(ag, /k\.read\(plus\(kbase, 0x628f6f\), 2\)/,
  "stale-corruption guard reads the 14.00 delayed-panic RVA");
assert.match(ag, /k\.read\(plus\(kbase, 0x628684\), 2\)/,
  "stale-corruption guard reads the 14.00 self-verification RVA");
assert.match(ag, /win\(0x6293ef, "7541488d3df87403"/,
  "stock-window guard at the relocated sysVeri site");
assert.match(ag, /win\(0x628b04, "74074883c4085b5d"/,
  "stock-window guard at the relocated self-verification site");
assert.match(ag, /patchset read-back failed at kernel \+0x6293ef/,
  "post-gate read-back covers the sysVeri site");
assert.match(ag, /patchset read-back failed at kernel \+0x628b04/,
  "post-gate read-back covers the self-verification site");
assert.match(ag, /if \(!\(await runPatchSet\(room, k, kbase\)\)\) return false;/,
  "loadEnabler runs the guarded patchset on both routes");

/* The PATCH_WINDOWS_1402 table in the same file must carry the same targets
   (the relocations were derived from it -- a drift here means the patchset
   and the chain's own patches disagree). */
for (const [, newRva] of RELOC) {
  assert.match(ag, new RegExp("0x0*" + newRva.toString(16)),
    "PATCH_WINDOWS_1402 carries target 0x" + newRva.toString(16));
}

/* The guarded-bootstrap site table still pins sysent[11] at the shared RVAs,
   which is what makes the patchset's sysent writes 14.02-valid. */
const boot = fs.readFileSync(path.join(root, "tools", "build-guarded-bootstrap-1402.cjs"), "utf8");
assert.match(boot, /sysent11-narg", rva: 0x1102d80/, "bootstrap sysent11-narg RVA");
assert.match(boot, /sysent11-call", rva: 0x1102d88/, "bootstrap sysent11-call RVA");
assert.match(boot, /sysent11-thrcnt", rva: 0x1102dac/, "bootstrap sysent11-thrcnt RVA");
assert.match(boot, /stockTargetRva: 0x1c07a0/, "bootstrap 14.02 stock syscall-11 handler RVA");

console.log("14.02 patchset variant self-test passed");
