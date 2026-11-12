#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const preflight = require(path.join(__dirname, "..", "site", "preflight-1402.js"));

const file = process.argv[2];
const kbase = process.argv[3];
if (!file || !kbase) {
  console.error("usage: node tools/check-1402-snapshot.cjs RAW_KERNEL.bin KBASE_HEX");
  process.exitCode = 64;
} else {
  const bytes = fs.readFileSync(path.resolve(file));

  /* The host's ?dump=kernel feature writes two of the three ELF segments
     flat, at file offset == RVA: the executable text (PH2, RVA
     0x00000000..0x00cfe9a0) and the regular data tail (PH4, RVA
     0x01520000..0x01b265f0).  Sony's own segment (PH3, RVA
     0x010ff000..0x0111fcc0 -- where sysent lives) is NOT dumped, and the
     blank file bytes there must not be mistaken for zeroed kernel memory:
     read those RVAs as absent instead. */
  const DUMPED = [[0x0000000, 0xcfe9a0], [0x1520000, Math.min(bytes.length, 0x1b26690)]];
  const inDump = (rva, length) =>
    DUMPED.some(([a, b]) => rva >= a && rva + length <= b);

  const result = preflight.evaluate((rva, length) => {
    if (rva < 0 || rva + length > bytes.length) return null;
    if (!inDump(rva, length)) return null; /* segment absent from the dump */
    return bytes.subarray(rva, rva + length);
  }, { kbase });

  const absent = result.sites.filter((s) => /missing-or-invalid/.test(s.error || ""));
  console.error(
    "dump segments: PH2 text 0x0..0x" + (0xcfe9a0).toString(16) +
    " and PH4 data 0x1520000..0x1b265f0 present; PH3 (Sony, sysent) absent" +
    (absent.length ? " -- " + absent.length + " site(s) read as not-present, not zeroed" : "")
  );
  console.log(JSON.stringify({
    version: preflight.version,
    snapshot: path.resolve(file),
    size: bytes.length,
    state: result.state,
    counts: result.counts,
    groups: result.groups,
    sites: result.sites.map((site) => ({
      id: site.id,
      rva: "0x" + site.rva.toString(16),
      status: site.status,
      actual: site.actual,
      error: site.error,
    })),
  }, null, 2));

    if (result.state === "all-stock") {
    process.exitCode = 0;
  } else if (result.state === "all-final") {
    process.exitCode = 3;
  } else {
    process.exitCode = 2;
  }
}
