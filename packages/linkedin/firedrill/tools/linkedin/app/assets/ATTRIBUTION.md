# Asset attribution

## Logos

LinkedIn, the "in" logo and the LinkedIn wordmark are trademarks of their owner. They are used only to identify
the simulated service in a local test environment. No affiliation with or endorsement by the owner is implied.

| File | Source URL | Notes |
|---|---|---|
| `app/site/assets/linkedin.svg` (copy: `app/assets/linkedin.svg`) | https://logos.lndev.me/logos/linkedin.svg | Current mark: rounded square "in" bug in `#0a66c2`. Used in the global navigation, favicon and profile cards. Unmodified. |
| `app/site/assets/linkedin-wordmark.svg` (copy: `app/assets/linkedin-wordmark.svg`) | https://logos.lndev.me/logos/linkedin-wordmark.svg | Current "Linked[in]" wordmark in `#0a66c2`. Used on the loading and signed-out screens. Unmodified. |
| `app/assets/linkedin-in.svg` | https://logos.lndev.me/logos/linkedin-in.svg | Monochrome "in" glyph (currentColor), downloaded for reference, not served. |

Logo library source repository: https://github.com/ln-dev7/logos-apps (downloaded 2026-09-15).

## Fonts

| Files | Source | Licence |
|---|---|---|
| `app/site/assets/fonts/fira-sans-latin-{400,600,700}-normal.woff2`, `fira-sans-latin-ext-{400,600,700}-normal.woff2` | npm package `@fontsource/fira-sans@5.3.0` (https://github.com/fontsource/font-files, originally https://github.com/mozilla/Fira) | SIL Open Font License 1.1, text in `app/assets/fonts/OFL.txt` |

The web client of the real product renders with the operating system UI font stack, which lists Fira Sans. The app
uses the same stack and bundles Fira Sans as the offline fallback where no platform UI font from the stack exists.

## Icons

All interface glyphs in `app/site/icons.js` are original SVG paths drawn for this package in a similar monochrome
24 px style. No icon files were copied.
