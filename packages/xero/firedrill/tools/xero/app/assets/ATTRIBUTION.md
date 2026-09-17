# Third-party assets used by the Xero Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Xero Limited)

| file | served copy | source | brand version |
|---|---|---|---|
| `xero.svg` | `../site/assets/xero.svg` | https://logos.lndev.me/logos/xero.svg (library: https://github.com/ln-dev7/logos-apps) | The current Xero mark: the blue circle with the white lowercase "xero" wordmark inside, in use since the 2012 rebrand and still the app icon and header mark today. Used in the top navigation bar and as the favicon. SHA-256 `2d48c957b9adad058109fd4ef7ff96c24e6ccf0958809995ca823fbbf4acbc4a`. |
| `xero-wordmark.svg` | `../site/assets/xero-wordmark.svg` | https://logos.lndev.me/logos/xero-wordmark.svg | The blue "xero" wordmark without the circle. Kept for completeness; the product header uses the circle mark, so the app does not currently display it. SHA-256 `425dc4326d5c2fbe85a0e61528f58ebd42af114bce8db667c9213433ec183099`. |

Downloaded on 2026-09-15 and used unmodified.

Xero and the Xero logo are trademarks of Xero Limited. They identify the simulated service inside a test environment
only; this package is not affiliated with or endorsed by Xero.

## Font

| served copy | source | licence |
|---|---|---|
| `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight 400–700, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400..700) | SIL Open Font License 1.1 — `fonts/OFL.txt` |
| `../site/assets/fonts/inter-latin-ext.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2 (latin-ext subset, needed for macrons such as "Kōwhai" and "Mākoha") | SIL Open Font License 1.1 — `fonts/OFL.txt` |

`fonts/OFL.txt` was copied from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt.
Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). The Xero web app uses a proprietary
typeface that cannot be bundled; Inter is a permissively licensed neo-grotesque with the same clean, open UI
proportions and is the face this app uses.

## Interface glyphs

The monochrome 24 px line glyphs in `../site/icons.js` (menu, search, notifications, help, create, chevrons, actions)
are original SVG paths drawn for this package in the simple rounded line style of the Xero web app. No third-party
icon font is embedded.
