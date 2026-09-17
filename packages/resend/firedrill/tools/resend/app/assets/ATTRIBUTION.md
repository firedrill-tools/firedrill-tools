# Third-party assets used by the Resend Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licences and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so Markdown and licence text cannot live inside the served root).

## Logos (trademarks of Resend, Inc.)

| file | served copy | source | notes |
|---|---|---|---|
| `resend.svg` | `../site/assets/resend.svg` | https://logos.lndev.me/logos/resend.svg (library: https://github.com/ln-dev7/logos-apps) | Current Resend "R" icon, black fill. The library has no wordmark (`resend-wordmark.svg` answers 404). Kept as the library reference copy. |
| `resend-icon-white.svg` | `../site/assets/resend-icon-white.svg` | https://cdn.resend.com/brand/resend-icon-white.svg (linked from https://resend.com/brand) | Same path data as the library icon with fill `#FDFDFD`, the variant the dark dashboard uses. Page favicon. |
| `resend-wordmark-white.svg` | `../site/assets/resend-wordmark-white.svg` | https://cdn.resend.com/brand/resend-wordmark-white.svg (linked from https://resend.com/brand) | Current "Resend" wordmark, white, shown at the top of the sidebar. |

Downloaded on 2026-09-15 and used unmodified.

## Fonts (SIL Open Font License 1.1)

| file | source | licence |
|---|---|---|
| `fonts/inter-latin-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2 (Inter by The Inter Project Authors, https://github.com/rsms/inter) | `fonts/Inter-OFL.txt` |
| `fonts/jetbrains-mono-latin-400-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2 (JetBrains Mono by The JetBrains Mono Project Authors, https://github.com/JetBrains/JetBrainsMono) | `fonts/JetBrainsMono-OFL.txt` |

Inter matches the dashboard's UI typeface; JetBrains Mono stands in for its monospace face (ids, DNS values, tokens).
Only the Latin subsets are bundled; other scripts fall back to the system font stack.

## Icons

The line icons in `../site/icons.js` are drawn for this app in a generic thin-stroke style; they are not copied from
any icon set.
