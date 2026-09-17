# Third-party assets used by the Google Sheets Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original download of the logo; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

All files were downloaded on 2026-09-14 and are used unmodified.

## Logo (trademark of Google LLC)

| file | served copy | source URL | brand version |
|---|---|---|---|
| `google-sheets-2026.svg` | `../site/assets/google-sheets-2026.svg` | https://logos.lndev.me/logos/google-sheets-2026.svg (library: https://github.com/ln-dev7/logos-apps) | The current (2026) Google Sheets product mark: the green rounded tile with the white cross, over a darker green tile behind it. Corroborated against Wikimedia Commons `File:Google Sheets icon (2026).svg` (https://upload.wikimedia.org/wikipedia/commons/d/d6/Google_Sheets_icon_%282026%29.svg): rendered side by side, the two files have the same geometry and gradients (the byte difference is whitespace and attribute formatting only). |

SHA-256 of the served copy: `10b7eca40be01cdd7326881a80734e6f118972906372ee8b0aaa57a70a307b35`.

Main-menu drawer marks (trademarks of Google LLC), downloaded unmodified on 2026-09-15 from the same library and served
from `../site/assets/` (byte-identical copies kept here):

| file | source URL | SHA-256 |
|---|---|---|
| `google-docs-2026.svg` | https://logos.lndev.me/logos/google-docs-2026.svg | `484f583dbbb62a325dffba63530189601aea2d3310d26062bb74cd5e7bcd3437` |
| `google-slides-2026.svg` | https://logos.lndev.me/logos/google-slides-2026.svg | `5752616d996c0cda6027fe1bf41216331442173516bf570ba886286affbb620e` |
| `google-forms-2026.svg` | https://logos.lndev.me/logos/google-forms-2026.svg | `90934e52a988a29a363655f9d7a72101ff00d225ed3e31a35aef45e0c2952bfa` |
| `google-drive-2026.svg` | https://logos.lndev.me/logos/google-drive-2026.svg | `043894bcca12a0dbac2ca15eff47feaeba1d94c23c86f571fe0ed378366a8d92` |

Inspected and deliberately **not** used: `google-sheets.svg` from the same library (https://logos.lndev.me/logos/google-sheets.svg),
the superseded 2020 mark — a green page with a folded corner and a white table — which is no longer what the product shows.
The library has no `google-sheets-wordmark.svg` (HTTP 404). The Sheets home header pairs the product mark with the single
word "Sheets" set in the interface font, so the app renders that word as page text (Roboto, grey `#5f6368`), matching the product.

The four-colour plus on the "Blank spreadsheet" tile, the toolbar glyphs and every other icon are interface glyphs drawn as
CSS or SVG paths in `../site/icons.js` and `../site/styles.css` in the Material Symbols visual language; they are not logo files.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/roboto-latin.woff2` | https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBHMdazQ.woff2 (Roboto v51, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt) |

Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic). SHA-256 of the served file:
`0a44e0bb6ba5c8537e8814c148ef7755f1bce12112361231f595ecc584a18d7a`; `fonts/OFL.txt`:
`061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41`. Google Sans (used by Google for the product chrome)
is not openly licensed, so Roboto carries the interface text. Cell text uses the viewer's installed Arial (Sheets' default
cell font) with Liberation Sans / Helvetica fallbacks; no cell font is bundled.

## Trademarks

Google Sheets, Google Drive, Google Workspace, Google and the logo above are trademarks of Google LLC. They are used only to
identify the service this package simulates inside a test environment. This package is an independent Firedrill Tool and is
not affiliated with, sponsored by or endorsed by Google.
