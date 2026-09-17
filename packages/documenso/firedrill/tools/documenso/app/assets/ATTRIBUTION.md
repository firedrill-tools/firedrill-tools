# Third-party assets used by the Documenso Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licences and the original
downloads; the copies under `../site/assets/` are byte-identical (the framework serves only html/css/js/json/image/font files,
so this Markdown file and the licence texts cannot live inside the served root). Everything was downloaded on 2026-09-15.

## Logos (trademarks of Documenso, Inc.)

| file | served copy | source | notes |
|---|---|---|---|
| `documenso-logo.svg` | `../site/assets/documenso-logo.svg` | https://raw.githubusercontent.com/documenso/documenso/main/apps/remix/app/components/general/branding-logo.tsx | The current Documenso wordmark (seal mark + "Documenso") exactly as the web app renders it in its header (`viewBox 0 0 2248 320`, `fill="currentColor"`). The `<svg>` element was taken verbatim from the vendor's own source file; only the React `{...props}` spread was removed so it is a standalone SVG. Path data is unmodified. Shown in the app header at 24 px height. |
| `documenso-logo-icon.svg` | `../site/assets/documenso-logo-icon.svg` | https://raw.githubusercontent.com/documenso/documenso/main/apps/remix/app/components/general/branding-logo-icon.tsx | The current Documenso seal icon from the same vendor source, extracted the same way. Used as the page favicon. |
| `documenso.svg` | `../site/assets/documenso.svg` | https://logos.lndev.me/logos/documenso.svg (library: https://github.com/ln-dev7/logos-apps) | The logo library's Documenso icon (black seal, `viewBox 0 0 256 256`), the same current mark as `documenso-logo-icon.svg`. Kept as the library copy; the library has no `documenso-wordmark.svg` (HTTP 404), which is why the wordmark comes from the vendor's source. |

All three are the mark in use on app.documenso.com today; no historical or redrawn version is bundled.

## Fonts (SIL Open Font License 1.1)

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/inter-latin.woff2` | `../site/assets/fonts/inter-latin.woff2` | https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 (Inter v20, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700) | `fonts/Inter-OFL.txt` from https://raw.githubusercontent.com/google/fonts/main/ofl/inter/OFL.txt — Copyright 2020 The Inter Project Authors |
| `fonts/caveat-latin.woff2` | `../site/assets/fonts/caveat-latin.woff2` | https://fonts.gstatic.com/s/caveat/v23/WnznHAc5bAfYB2QRah7pcpNvOx-pjfJ9eIWpYT5KmgqHsA.woff2 (Caveat v23, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Caveat:wght@400..700) | `fonts/Caveat-OFL.txt` from https://raw.githubusercontent.com/google/fonts/main/ofl/caveat/OFL.txt — Copyright 2014 The Caveat Project Authors |

The web app's interface is set in Inter and typed signatures and signature fields use Caveat, so both faces match the product
directly. SHA-256: inter-latin.woff2 `c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4`, caveat-latin.woff2
`52022c3f829bce385c80657374c70602c5093cea4ec2433e5b555175bd50d1f9`.

## Icons and colours

All interface icons (`../site/icons.js`) are original line drawings made for this package in the same 24 px, 2 px-stroke outline
style the web app uses; no third-party icon set is bundled. Colour values (lime-green primary `hsl(95.08 71.08% 67.45%)`, slate
foreground, borders, recipient colours) were read from the public theme tokens in
https://raw.githubusercontent.com/documenso/documenso/main/packages/ui/styles/theme.css and re-typed as CSS custom properties.
