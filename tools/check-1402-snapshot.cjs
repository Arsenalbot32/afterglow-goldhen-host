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
  const result = preflight.evaluate((rva, length) => {
    if (rva < 0 || rva + length > bytes.length) return null;
    return bytes.subarray(rva, rva + length);
  }, { kbase });

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

  process.exitCode = result.state === "all-stock" || result.state === "all-final" ? 0 : 2;
}
