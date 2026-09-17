# Third-party assets used by the Dropbox Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Dropbox, Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `dropbox.svg` | `../site/assets/dropbox.svg` | https://logos.lndev.me/logos/dropbox.svg (library: https://github.com/ln-dev7/logos-apps) | The current Dropbox glyph: the flat five-diamond open box in `#0061FF`, introduced with the 2017 rebrand and still the favicon, app icon and top-left mark of the web app. Used as the favicon, the product-rail home mark and the empty-state art. |
| `dropbox-logo-2017.svg` | `../site/assets/dropbox-logo-2017.svg` | https://upload.wikimedia.org/wikipedia/commons/c/cb/Dropbox_logo_2017.svg (Wikimedia Commons file page: https://commons.wikimedia.org/wiki/File:Dropbox_Logo_2017.svg) | The current horizontal logo (blue glyph plus the black "Dropbox" wordmark) from the 2017 rebrand, as shown on dropbox.com. Used on the access-denied screen. |
| `dropbox-wordmark-legacy.svg` | not served | https://logos.lndev.me/logos/dropbox-wordmark.svg | Downloaded for comparison and **rejected**: it is the superseded pre-2017 lockup (outlined glyph with the older lettering in `#007EE5`). Kept only as the record of that decision. |

Downloaded on 2026-09-15 and used unmodified. Dropbox and the Dropbox logo are trademarks of Dropbox, Inc. They
identify the simulated service inside a test environment only; this package is not affiliated with or endorsed by
Dropbox, Inc.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/inter-latin.woff2` | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight axis, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt); the licence stays here because the UI bundle accepts no `.txt` files, and it ships in the same package as the served font |

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). The Dropbox web app renders its interface in
the proprietary Atlas Grotesk / Sharp Grotesk families, which cannot be redistributed; Inter is the closest permissively
licensed neo-grotesque, so the app declares `Inter, "Atlas Grotesk", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`.

## Icons

All interface icons (`../site/icons.js`) and file-type thumbnails are original SVG line drawings made for this package in
the visual language of the product (24 px grid, 1.5 px rounded strokes, pale-blue folders). No third-party icon set is used.
