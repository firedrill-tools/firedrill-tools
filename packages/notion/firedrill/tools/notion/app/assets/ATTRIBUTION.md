# Third-party assets used by the Notion Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Notion Labs, Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `notion.svg` | `../site/assets/notion.svg` | https://logos.lndev.me/logos/notion.svg (library: https://github.com/ln-dev7/logos-apps) | The current Notion product mark: the black "N" glyph on a white page with the folded top-left corner, in use since the 2018 rebrand and unchanged today (favicon, app icon, login page). |
| `notion-wordmark.svg` | `../site/assets/notion-wordmark.svg` | https://logos.lndev.me/logos/notion-wordmark.svg (library: https://github.com/ln-dev7/logos-apps) | The same mark followed by the "Notion" wordmark in the brand's serif-free lettering, as shown on notion.com. |

Downloaded on 2026-09-14 and used unmodified (no other `notion*` variants exist in the library's name list, so no
superseded mark had to be rejected). Where they appear: `notion.svg` is the page favicon and the mark in the workspace
switcher menu and the help popover; `notion-wordmark.svg` is shown on the "not connected" screen and in the help
popover. Inside the app itself the sidebar shows the *workspace* icon and name, exactly as the real product does.

Notion and the Notion logo are trademarks of Notion Labs, Inc. They identify the simulated service inside a test
environment only; this package is not affiliated with or endorsed by Notion Labs, Inc.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/inter-latin.woff2` | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight axis, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt) |

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). Notion's web client renders its UI with the
platform's system sans-serif stack; Inter is the closest permissively licensed match and is the face Notion itself
lists in that stack, so the app declares `Inter, ui-sans-serif, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`.

## Icons

All interface icons in `../site/icons.js` are original monochrome SVG paths drawn for this package in the visual style
of the product (1.5–2 px strokes, 20 px grid); none are copied from Notion.
