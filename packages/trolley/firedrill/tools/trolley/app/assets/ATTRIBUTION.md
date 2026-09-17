# Third-party assets used by the Trolley Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads. The framework serves only html/css/js/json/image/font files, so this Markdown file and the licence
text cannot live inside the served root. Served copies are byte-identical to the originals here (renamed only).

## Logos (trademarks of Trolley, Inc.)

Trolley is not part of the logos.lndev.me library, so the marks were downloaded from the vendor's own website on
2026-09-15 and are used unmodified.

| original file | served copy | source | brand version |
|---|---|---|---|
| `cropped-Site-Icon-512x512-px-1-192x192.png` | `../site/assets/trolley-icon.png` | https://trolley.com/wp-content/uploads/2023/11/cropped-Site-Icon-512x512-px-1-192x192.png (the site's `<link rel="icon">`) | Current Trolley app icon (white lowercase "t" with the blue underline bar on a near-black tile, published 2023-11). Used in the navigation rail tile and as the favicon |
| `full-logo.svg` | `../site/assets/trolley-logo.svg` | https://trolley.com/wp-content/uploads/2023/08/full-logo.svg (header logo of https://trolley.com/) | Current "trolley" wordmark (ink `#0C0E12`, underline bar `#0092FF`, published 2023-08). Shown when the rail is expanded |
| `logo-black.svg` | not served | https://trolley.com/wp-content/uploads/2021/11/logo-black.svg | Earlier (2021) export of the same wordmark with ink `#191819`; kept for provenance only, superseded by `full-logo.svg` |

Trolley and the Trolley logo are trademarks of their owner. They identify the simulated service inside a test
environment only; this package is not affiliated with or endorsed by Trolley.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight 400–700, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400..700) | SIL Open Font License 1.1: `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt) |

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). Trolley's web properties use the
proprietary Circular Std typeface, which cannot be bundled; Inter is the closest permissively licensed geometric
sans with tabular figures.

## Interface glyphs

The monochrome glyphs in `../site/icons.js` (rail navigation, payout methods, actions) are original SVG paths drawn
for this package in the solid, rounded style of the dashboard's rail icons. No third-party icon font or brand asset
is embedded; PayPal and Venmo are shown by name and generic glyphs, not by their logos.
