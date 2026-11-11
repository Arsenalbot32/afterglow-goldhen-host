# GoldHEN host for PS4 14.00 / 14.02

Static GitHub Pages host for the supplied afterglow browser exploit, fixed to
the normal **GoldHEN** loader.

Hosted URL after Pages finishes deploying:

<https://ktmwilson23.github.io/afterglow-goldhen-host/>

Open that address in the PS4 browser. GoldHEN starts after a five-second
countdown, or immediately when the start button is selected.

## Published runtime

Only the files needed by the standard GoldHEN route are deployed from
`site/`. The HEN payload, ISO, and `kpstep` diagnostic routes are deliberately
excluded.

The landing page navigates to:

```text
launch.html?v=1402s&log=1&afterglow=run&mode=goldhen
```

Do not open `launch.html` directly. The exploit checks that it was reached
from `index.html` on the same origin before arming.

## Updating

Pushing to `main` deploys `site/` through GitHub Actions. If JavaScript is
changed later, also change the `?v=` values used by the HTML and module
imports so the console cannot reuse an older GitHub Pages response.

## Safety

The kernel patch lasts until the console reboots. A failed exploit run can
freeze or crash the console; do not run it while anything is unsaved.

Licensed under the GNU Affero General Public License v3.0 or later. See
`LICENSE`.
