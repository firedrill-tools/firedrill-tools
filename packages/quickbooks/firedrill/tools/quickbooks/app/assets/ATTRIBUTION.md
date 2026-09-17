# Third-party assets used by the QuickBooks Online Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Intuit Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `quickbooks.svg` | `../site/assets/quickbooks.svg` | https://logos.lndev.me/logos/quickbooks.svg (library: https://github.com/ln-dev7/logos-apps) | The current QuickBooks product mark: the green `#2CA01C` circle with the white "qb" glyph, used unchanged since the 2019 rebrand. Used as the favicon and on transaction forms. |
| `intuit-quickbooks.svg` | `../site/assets/intuit-quickbooks.svg` | https://upload.wikimedia.org/wikipedia/commons/7/79/Intuit_QuickBooks_logo.svg (file page: https://commons.wikimedia.org/wiki/File:Intuit_QuickBooks_logo.svg, marked public domain / trademark) | The current "intuit quickbooks" lockup (green circle mark with the black lowercase wordmark) shown at the top of the QuickBooks Online navigation. The logo library has no QuickBooks wordmark, so the lockup was taken from Wikimedia Commons. |

Downloaded on 2026-09-15 and used unmodified. The library's `intuit.svg` (the blue Intuit corporate wordmark) is
not the product logo and is not used.

QuickBooks, Intuit and their logos are trademarks of Intuit Inc. They identify the simulated service inside a test
environment only; this package is not affiliated with or endorsed by Intuit.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/figtree-latin.woff2` | https://fonts.gstatic.com/s/figtree/v9/_Xms-HUzqDCFdgfMm4S9DaRvzig.woff2 (Figtree v9, latin subset, variable weight 400–700, as served by https://fonts.googleapis.com/css2?family=Figtree:wght@400..700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/figtree/OFL.txt) |

Copyright 2022 The Figtree Project Authors (https://github.com/erikdkennedy/figtree). QuickBooks Online renders in
Intuit's proprietary "Avenir Next forINTUIT" typeface, which cannot be bundled; Figtree is a permissively licensed
geometric sans with the same round, open proportions and is the face this app uses.

## Interface glyphs

The monochrome 24 px line glyphs in `../site/icons.js` (navigation, actions, status) are original SVG paths drawn
for this package in the rounded line style of the QuickBooks Online icon set. No third-party icon font is embedded.
