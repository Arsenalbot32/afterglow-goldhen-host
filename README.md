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
| 14.00 | Existing GoldHEN implementation |
| 14.02 | Experimental, disabled and unverified |

The 14.02 launch path remains disabled.

A reconstructed 14.02 candidate caused a hardware kernel panic during testing on November 11, 2026. No subsequent work has established a reliable or safe 14.02 launch.

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

The offline preflight and bootstrap prototypes are research tools only. They are not connected to an operational 14.02 launch path.

No hardware validation or release certification is claimed.

## Safety and stability

A kernel panic can cause data loss or require a console restart.

The previous 14.02 kernel panic is a significant warning and must not be treated as an acceptable validation result.

The 14.02 launch remains disabled. No instructions or assurances for running the experimental candidate on physical hardware are provided.

## Development and contributions

Changes should preserve the separation between:

- Existing firmware-specific functionality.
- Offline diagnostic utilities.
- Experimental research artifacts.

Passing local tests must never be presented as proof of compatibility or hardware safety.

## License

Licensed under the GNU Affero General Public License v3.0 or later.

See `LICENSE` for details.
