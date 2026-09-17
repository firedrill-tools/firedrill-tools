# Third-party assets used by the Check Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads (the framework serves only html/css/js/json/image/font files, so this Markdown file and the licence
text cannot live inside the served root). Both PNGs here are byte-identical to their served copies
(`check-icon-256.png` = `../site/assets/check-icon.png`, `check-favicon-32.png` = `../site/assets/check-favicon.png`);
the Inter woff2 is kept only under `../site/assets/fonts/`, with its licence (`fonts/OFL.txt`) here.
`check-wordmark.svg` is the one file that differs: the served copy keeps the identical path data but replaces the page's
`width="100%" … class="contain-image brand"` root attributes with `width="71" height="17"` so it renders at its natural
size inside an `<img>`; everything below the root `<svg>` element is unchanged.

## Logo (trademark of Check Technologies, Inc.)

The logo library at https://logos.lndev.me (https://github.com/ln-dev7/logos-apps) has no Check entry, so all three
files come from the vendor's own website, https://www.checkhq.com (fetched 2026-09-16). Nothing is redrawn,
recoloured or approximated.

| file | served copy | source | brand version |
|---|---|---|---|
| `check-wordmark.svg` | `../site/assets/check-wordmark.svg` | The inline `<svg width="100%" viewBox="0 0 71 17">` logo in the site header of https://www.checkhq.com | Current Check wordmark (the lower-case "check" lettering used across checkhq.com today). The path data is used unmodified; only the page's `class` attribute was kept and the file saved standalone so it renders in an `<img>`. |
| `check-icon-256.png` | `../site/assets/check-icon.png` | https://cdn.prod.website-files.com/66bc5326faf12d39519ab28f/66bc53ab898100af8617a01e_Frame%20(2).png — linked from the homepage as `<link rel="apple-touch-icon">` | Current 256×256 Check app icon, used unmodified as the sidebar brand tile. SHA-256 `4b4265b839142b209f4edc71ee41a612e1d0824f3cde4de96bf4e17c3c419f5b`. |
| `check-favicon-32.png` | `../site/assets/check-favicon.png` | https://cdn.prod.website-files.com/66bc5326faf12d39519ab28f/66bc53a84fbf06a1965415e9_Frame%20(1).png — linked from the homepage as `<link rel="shortcut icon">` | Current 32×32 Check favicon, used unmodified as the page icon. SHA-256 `59ed0df5e3a4221ad689268279c9d38295bb96f900fa0fbefc27416797cf6e63`. |

Both PNG downloads were re-fetched and compared byte for byte against the copies in this directory on 2026-09-16, and
the wordmark's path data was matched against the live homepage markup, to confirm they are the official current marks.

Check and the Check logo are trademarks of their owner. They identify the simulated service inside a test environment
only; this package is not affiliated with or endorsed by Check.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/inter-latin.woff2` | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight 400–700, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt) |

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). SHA-256 of the woff2:
`c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4`.

checkhq.com sets its interface in **FT Regola Neue** (`font-family: Ftregolaneue, Arial, sans-serif` in the site's
stylesheet), a commercial face that is not distributed under an open licence and therefore cannot be
bundled. Inter (OFL) is used instead: it is the closest permissively licensed neo-grotesque with the same low contrast,
tall x-height and near-vertical terminals, so the Console's typographic colour is preserved. The substitution is
recorded here and in `specs/check/VERIFICATION.md`.

## Icons

All interface glyphs (`../site/icons.js`) are original SVG paths drawn for this package on a 24 px grid, in the light
stroke weight of the Console's navigation. No third-party icon set, icon font or brand asset is embedded in them.

## Colours

The palette in `../site/base.css` (`--ink`, `--muted`, `--line`, `--wash`, `--blue` …) was sampled from the CSS custom
properties published by https://www.checkhq.com (`--dark--900 #131415`, `--dark--600 #425466`, `--light--200 #e2e8f0`,
`--light--50 #f8fafc`, `--blue--default #0c8ce9`), so the greys and the action blue match the product.
