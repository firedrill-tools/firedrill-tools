# Third-party assets used by the NetSuite Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Oracle Corporation)

| file | served copy | source | brand version |
|---|---|---|---|
| `oracle-netsuite.svg` | `../site/assets/oracle-netsuite.svg` | https://logos.lndev.me/logos/oracle-netsuite.svg (library: https://github.com/ln-dev7/logos-apps) | The current stacked **ORACLE NETSUITE** lockup (Oracle wordmark with the registered mark over "NETSUITE"), the mark Oracle has used for the product since the 2016 acquisition and the one a NetSuite user sees in the application bar today. Drawn with `fill="currentColor"`, so the app renders it white on the dark application bar with a CSS filter; the file itself is used unmodified. SHA-256 `1af8e382d5cc413cb324c831c24432940759eb6a7c963128ef9437bb3a16598f`, 2,613 bytes. |
| `oracle.svg` | `../site/assets/oracle.svg` | https://logos.lndev.me/logos/oracle.svg | The red Oracle wordmark (`#ea1b22`), the current corporate mark. Used as the app's favicon. SHA-256 `8c31cc34cb7b0cc9200e07218c79cb22cf76508cf486b5dbd2386cd5b94353b6`, 1,326 bytes. |

Downloaded on 2026-09-16 and used unmodified. The logo library has no standalone `netsuite` entry; `oracle-netsuite`
is the product lockup and is what the real application bar shows, so nothing was redrawn or substituted.

Oracle, NetSuite and the Oracle NetSuite logo are trademarks of Oracle Corporation. They identify the simulated
service inside a test environment only; this package is not affiliated with, endorsed by, or connected to Oracle.

## Font

| served copy | source | licence |
|---|---|---|
| `../site/assets/fonts/open-sans-latin.woff2` | https://fonts.gstatic.com/s/opensans/v44/memvYaGs126MiZpBA-UvWbX2vVnXBbObj2OVTS-mu0SC55I.woff2 (Open Sans v44, latin subset, variable weight 300–800, as served by https://fonts.googleapis.com/css2?family=Open+Sans:wght@400..700) | SIL Open Font License 1.1 — `fonts/LICENSE.txt` |
| `../site/assets/fonts/open-sans-latin-ext.woff2` | https://fonts.gstatic.com/s/opensans/v44/memvYaGs126MiZpBA-UvWbX2vVnXBbObj2OVTSGmu0SC55K5gw.woff2 (latin-ext subset, needed for names such as "Émile Thibault") | SIL Open Font License 1.1 — `fonts/LICENSE.txt` |

`fonts/LICENSE.txt` was copied from https://raw.githubusercontent.com/google/fonts/main/ofl/opensans/OFL.txt.
Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans). The NetSuite web
application uses Oracle Sans and Helvetica Neue, both proprietary and not redistributable; Open Sans is a
permissively licensed humanist sans with the same open, slightly condensed UI proportions and is the face this
app bundles as `NS Sans`.

## Interface glyphs

The monochrome line glyphs in `../site/icons.js` (search, recent records, create, shortcuts, help, chevrons,
record actions) are original SVG paths drawn for this package in the plain, square-ended style of the NetSuite
application bar and list toolbars. No third-party icon font is embedded.
