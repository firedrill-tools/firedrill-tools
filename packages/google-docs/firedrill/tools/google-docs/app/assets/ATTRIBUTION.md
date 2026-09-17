# Third-party assets used by the Google Docs Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

All files were downloaded on 2026-09-14 and are used unmodified.

## Logo (a trademark of Google LLC)

| file | served copy | source URL | brand version |
|---|---|---|---|
| `google-docs-2026.svg` | `../site/assets/google-docs-2026.svg` | https://logos.lndev.me/logos/google-docs-2026.svg (library: https://github.com/ln-dev7/logos-apps) | The Google Docs mark in use since 2026 — the rounded blue sheet with the folded corner and three white lines. |
| `google-docs-2026-wikimedia.svg` | not served (corroboration only) | https://upload.wikimedia.org/wikipedia/commons/1/18/Google_Docs_icon_%282026%29.svg (Wikimedia Commons, `File:Google Docs icon (2026).svg`) | Same artwork, pretty-printed: the two files have identical geometry, masks, gradients and colours, which is how the 2026 mark was confirmed as the current one. |

SHA-256:

```
484f583dbbb62a325dffba63530189601aea2d3310d26062bb74cd5e7bcd3437  google-docs-2026.svg          (= ../site/assets/google-docs-2026.svg)
b1f3fe6215b713aecb906aa3707a1c599d357f5ff5977433b22ec9500ddb2207  google-docs-2026-wikimedia.svg
```

## Side-panel app marks (trademarks of Google LLC)

The Docs editor keeps a rail of Workspace side-panel apps to the right of every document. None of those products is
simulated by this Tool — each button opens a short "not simulated" panel — but the rail is part of the chrome a daily
Docs user sees, so the buttons carry the products' real marks rather than a redrawn substitute. All five were downloaded
on 2026-09-16 from the same logo library and are used unmodified.

| file | served copy | source URL | brand version |
|---|---|---|---|
| `google-calendar-2026.svg` | `../site/assets/google-calendar-2026.svg` | https://logos.lndev.me/logos/google-calendar-2026.svg | The 2026 Calendar mark (the library also carries the older `google-calendar.svg`, which is not what users see today). |
| `google-keep-2026.svg` | `../site/assets/google-keep-2026.svg` | https://logos.lndev.me/logos/google-keep-2026.svg | The 2026 Keep mark. |
| `google-tasks-2026.svg` | `../site/assets/google-tasks-2026.svg` | https://logos.lndev.me/logos/google-tasks-2026.svg | The 2026 Tasks mark. |
| `google-contacts.svg` | `../site/assets/google-contacts.svg` | https://logos.lndev.me/logos/google-contacts.svg | The current Contacts mark; the library has no `google-contacts-2026.svg` (404). |
| `google-maps.svg` | `../site/assets/google-maps.svg` | https://logos.lndev.me/logos/google-maps.svg | The current Maps pin; the library has no `google-maps-2026.svg` (404). |

SHA-256 (each file is byte-identical to its served copy):

```
83cf9db71b4150fcbf84342e483298ebcea0d261b56dda29821d92743bc7d7c3  google-calendar-2026.svg
e61844731d298e5acf4e10280fbc2f051ba8b8fccf2ee172ddaa32005c88e004  google-keep-2026.svg
5fba48b3fdc8e0290e0d9bd3234885b308b5627c0100a6863bc14f56c79e2b53  google-tasks-2026.svg
3bac4e978450be6eb149fb106998144e4f1ff3a38466a8ee380bd50af130ffbb  google-contacts.svg
2a36a4a2a49e3ea944de0b26e8c813e57db0c7542894b4b45a82840f8df14dd9  google-maps.svg
```

The superseded mark in the same logo library was inspected and deliberately **not** used: `google-docs.svg` (282 bytes) is
the older flat blue page with `#3086f6`/`#0c67d6` fills, which is not what users see in the product today. The library has
no `google-docs-wordmark.svg` (404), which matches the product: Docs' header pairs the product mark with the single word
"Docs" set in the interface font, so the app renders that word as page text (Roboto, grey `#5f6368`).

## Interface icons

| files | source | licence |
|---|---|---|
| the path data in `../site/icons.js` (89 glyphs) | Material Symbols Outlined, 24 px, downloaded one glyph at a time from `https://fonts.gstatic.com/s/i/short-term/release/materialsymbolsoutlined/<name>/default/24px.svg` (and `/fill1/24px.svg` for the filled star and comment) | Apache License 2.0 — https://github.com/google/material-design-icons (`LICENSE`) |

Material Symbols is the icon set the Docs web client draws its toolbar, menus and header from. The glyphs are embedded as
path data so the app ships no icon font and makes no remote request; none of them is a logo.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/roboto-latin.woff2` | `../site/assets/fonts/roboto-latin.woff2` | https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBHMdazQ.woff2 (Roboto v51, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt) |

Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic). SHA-256 of the served file:
`0a44e0bb6ba5c8537e8814c148ef7755f1bce12112361231f595ecc584a18d7a`. Roboto is the Docs interface font; Google Sans (which
Google uses for the product name and large headings) is not publicly licensed, so Roboto carries those strings here. The
document surface itself is set in Arial — the family the Docs default named styles declare — with Helvetica and the generic
sans-serif as fallbacks; no Arial file is bundled.

## Trademarks

Google Docs, Google Drive, Google Workspace, Google Calendar, Google Keep, Google Tasks, Google Contacts, Google Maps, Google and the logos above are trademarks of Google LLC. They are used only to
identify the service this package simulates inside a test environment. This package is an independent Firedrill Tool and is
not affiliated with, sponsored by or endorsed by Google.
