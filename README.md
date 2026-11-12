# Afterglow GoldHEN Host — PS4

Static GitHub Pages host and offline research project for PlayStation 4 firmware 14.00 and 14.02.

Published site:
https://arsenalbot32.github.io/afterglow-goldhen-host/

## Project overview

This repository contains the Afterglow browser host, firmware-specific research files, and offline diagnostic utilities.

The project distinguishes between the existing 14.00 implementation and the experimental 14.02 research work.

**Firmware 14.02 compatibility has not been established.**

## Current status

| Firmware | Status |
|---|---|
| 14.00 | Existing GoldHEN implementation (hardware-proven, unchanged) |
| 14.02 | Experimental — enabled behind a guarded bootstrap |

The 14.02 kernel exploit chain is proven on this firmware: the `kernel_1402.bin`
reference dump was produced by this host's own `?dump=kernel` feature, which
runs the full chain (leak, gadget scan, mapping walk, ring-0 bootstrap write,
syscall-11 gate) to dump the kernel — so every stage up to and including the
kernel writes works on 14.02.

What is NOT proven on 14.02 is the GoldHEN payload itself: the first run of
the reconstructed `goldhen-1402-experimental.bin` ended in a hardware kernel
panic on November 11, 2026. The 14.02 route is therefore re-enabled with a
guarded bootstrap (see below) that refuses and rolls back instead of writing
into an unexpected kernel, plus a live `sysent[11]` read-out before anything
is written. A panic or refusal is recovered by a cold boot (power off 30
seconds).

The 14.02 experimental artifacts must not be considered console-ready.

## Diagnostic tools

The repository includes offline utilities for research and local validation:

- `site/preflight-1402.js` — classifies supplied byte snapshots.
- `tools/check-1402-snapshot.cjs` — checks local snapshot data.
- `tools/build-guarded-bootstrap-1402.cjs` — generates an offline prototype.
- `site/teardown-verify-1402.js` — checks supplied structural snapshots.
- `tests/` — contains local self-tests.

These utilities do not establish firmware compatibility, authenticate a complete kernel image, or certify hardware safety.

A successful self-test only confirms that the tested local logic behaves as expected.

## Storage diagnostic

The separate `/d1/` diagnostic checks whether a browser storage marker survives a page reload.

Passing this diagnostic does not demonstrate:

- WebKit exploit compatibility.
- Kernel access.
- GoldHEN compatibility.
- Successful jailbreak execution.

## Research limitations

The available 14.02 reference artifacts have known limitations and cannot all be treated as pristine stock firmware data.

Previous investigations identified inconsistencies in supplied binary references and incomplete validation of the reconstructed candidate.

The 14.02 route now embeds the generated guarded bootstrap
(`tools/build-guarded-bootstrap-1402.cjs`, version `guarded-bootstrap-1402-v2`,
1679 bytes) in `site/afterglow-g.js`: it derives the kernel base itself,
refuses any site that is not exactly stock (or, on a re-run, exactly final),
checks the teardown padding, brackets every write with `cli`/`CR0.WP` off,
and rolls the kernel back if the read-back disagrees. Its return value is
captured and every non-success status aborts the run before the payload
stage. The 14.00 route is byte-for-byte untouched.

No hardware validation of the 14.02 payload or release certification is
claimed; the guarded route limits damage, it does not certify safety.

## Safety and stability

A kernel panic can cause data loss or require a console restart.

The previous 14.02 kernel panic is a significant warning and must not be treated as an acceptable validation result.

The 14.02 route is experimental. A refusal or kernel panic on 14.02 is
recovered by a cold boot (power off 30 seconds). No assurance is provided
that the experimental GoldHEN 14.02 payload will run.

## Development and contributions

Changes should preserve the separation between:

- Existing firmware-specific functionality.
- Offline diagnostic utilities.
- Experimental research artifacts.

Passing local tests must never be presented as proof of compatibility or hardware safety.

## License

Licensed under the GNU Affero General Public License v3.0 or later.

See `LICENSE` for details.
