# Third-party assets used by the Attio Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logo (trademark of Attio Ltd)

The logo library at https://logos.lndev.me (https://github.com/ln-dev7/logos-apps) has no Attio entry, so both files
come from the vendor's own website.

| file | served copy | source | brand version |
|---|---|---|---|
| `attio-wordmark.svg` | `../site/assets/attio-wordmark.svg` | The inline `<svg width="103" height="26" viewBox="0 0 103 26">` logo in the site header of https://attio.com (fetched 2026-09-15). | Current Attio lockup: the two-shape mark followed by the lower-case "attio" wordmark, all paths `fill="currentColor"`. The path data is used unmodified; only the page's CSS `class` attribute was removed and the `xmlns` attribute added so the file renders standalone in an `<img>` (where `currentColor` resolves to black, the mark's default colour on light backgrounds). SHA-256 `d06ecfb967fd04003801ccb5de84cd11ee42a87ea487ca3f4fa1527bc48aca11`. |
| `attio-favicon.ico` | `../site/assets/attio-favicon.ico` | https://attio.com/favicon.ico (linked from the homepage as `<link rel="icon" href="/favicon.ico?favicon.0t61hvyp-jaev.ico" sizes="32x32">`, fetched 2026-09-15) | Current 32×32 Attio app icon, used unmodified as the page icon. SHA-256 `110c4835a7232c746368f6b58849e92e43d58bb4833e57762a211add1692b93e`. |

Candidates inspected and deliberately not used: `https://a.storyblok.com/f/234930/18x18/cfb7753a31/attio.svg` (an 18 px
outline navigation glyph of the mark with a `#232529` stroke, not the logo itself).

Attio and the Attio logo are trademarks of their owner. They identify the simulated service inside a test environment
only; this package is not affiliated with or endorsed by Attio.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/inter-latin.woff2` | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight 400–700, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt) |

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). The web app's interface is set in Inter, so
the bundled face matches the product's typography directly. SHA-256 of the woff2:
`c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4`.

## Icons

All interface icons (`../site/icons.js`) are original line drawings made for this package; no third-party icon set is
bundled.
