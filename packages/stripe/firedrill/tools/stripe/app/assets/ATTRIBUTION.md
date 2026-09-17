# Third-party assets used by the Stripe Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Stripe, Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `stripe-s.svg` | `../site/assets/stripe-s.svg` | https://logos.lndev.me/logos/stripe-s.svg (library: https://github.com/ln-dev7/logos-apps) | The current Stripe "S" icon (single path, `currentColor`), used as the favicon and rendered in brand purple `#635BFF` |
| `stripe.svg` | `../site/assets/stripe.svg` | https://logos.lndev.me/logos/stripe.svg (library: https://github.com/ln-dev7/logos-apps) | The current flat "stripe" wordmark in brand purple `#635BFF` (the post-2016 lowercase wordmark that Stripe uses today) |

Downloaded on 2026-09-14 and used unmodified. The library also offers `cc-stripe.svg` (a card-badge style mark
for payment-method pickers); it is not the product logo and is not used. The Dashboard itself shows the account
name rather than the logo in its sidebar, so the app does the same; the wordmark is bundled for the favicon/brand
context only.

Stripe and the Stripe logo are trademarks of Stripe, Inc. They identify the simulated service inside a test
environment only; this package is not affiliated with or endorsed by Stripe.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight 400–700, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400..700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt) |

Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter). The real Stripe Dashboard renders in
Stripe's proprietary "Söhne" typeface, which cannot be bundled; Inter is the closest permissively licensed match
(same humanist-grotesque proportions, tabular figures for amounts) and is the face this app uses.

## Interface glyphs

The monochrome 16 px glyphs in `../site/icons.js` (navigation, status, actions) are original SVG paths drawn for
this package in the solid, rounded style of the Dashboard's icon set. No third-party icon font or brand asset is
embedded. Card brands are shown as text chips ("Visa •••• 4242") rather than as card-network logos.
