# Third-party assets used by the Datadog Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Datadog, Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `datadog.svg` | `../site/assets/datadog.svg` | https://logos.lndev.me/logos/datadog.svg (library: https://github.com/ln-dev7/logos-apps) | The current Datadog "Bits" dog mark, single fill `#632ca6` (Datadog purple). |
| `datadog-wordmark.svg` | `../site/assets/datadog-wordmark.svg` | https://logos.lndev.me/logos/datadog-wordmark.svg | The current mark with the "DATADOG" wordmark, single fill `#632ca6`. Bundled for completeness; the app's left navigation shows the icon only, as the web app does. |

Downloaded on 2026-09-15 and used unmodified; SHA-1 re-checked against the library on 2026-09-15
(`datadog.svg` fcf35cd571401fcf8a0fe201d51c881d9d37ac77, `datadog-wordmark.svg` 92c95c8ffc95c99cd6be2d828a487f515f63c719).
They identify the simulated service in a test environment only; no affiliation with or endorsement by Datadog, Inc.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/noto-sans-latin.woff2` | `../site/assets/fonts/noto-sans-latin.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-sans@5.3.0/files/noto-sans-latin-wght-normal.woff2 (Fontsource packaging of Noto Sans, latin subset, variable weight; upstream https://github.com/notofonts/latin-greek-cyrillic) | SIL Open Font License 1.1, `fonts/OFL.txt` |

Noto Sans is the typeface of Datadog's web application. SHA-1 c916a8117ba03f6810cbca86fa9427660a9e4c24.

## Icons

The monochrome navigation and toolbar glyphs in `../site/icons.js` were drawn for this app in a 16 px stroke style;
they are not copied from Datadog.
