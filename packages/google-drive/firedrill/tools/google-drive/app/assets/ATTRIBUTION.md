# Third-party assets used by the Google Drive Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

All files were downloaded on 2026-09-14 and are used unmodified.

## Logos (trademarks of Google LLC)

| file | served copy | source URL | brand version |
|---|---|---|---|
| `google-drive-2026.svg` | `../site/assets/google-drive-2026.svg` | https://logos.lndev.me/logos/google-drive-2026.svg (library: https://github.com/ln-dev7/logos-apps) | The Google Drive mark in use since 19 May 2026 — the rounded triangle with the blue/green/yellow gradient. Corroborated against Wikimedia Commons `File:Google Drive icon (2026).svg` (https://upload.wikimedia.org/wikipedia/commons/5/5f/Google_Drive_icon_%282026%29.svg, described there as "Logo for Google Drive since May 19, 2026, replacing Google Drive icon (2020).svg"): same geometry and gradients. |
| `google-docs-2026.svg` | `../site/assets/google-docs-2026.svg` | https://upload.wikimedia.org/wikipedia/commons/1/18/Google_Docs_icon_%282026%29.svg (Wikimedia Commons, `File:Google Docs icon (2026).svg`) | The 2026 Google Docs mark, used as the file-type icon for `application/vnd.google-apps.document` rows, exactly as Drive shows the product icon in its file list. |
| `google-sheets-2026.svg` | `../site/assets/google-sheets-2026.svg` | https://upload.wikimedia.org/wikipedia/commons/d/d6/Google_Sheets_icon_%282026%29.svg (Wikimedia Commons, `File:Google Sheets icon (2026).svg`) | The 2026 Google Sheets mark, used for `application/vnd.google-apps.spreadsheet` rows. |
| `google-slides-2026.svg` | `../site/assets/google-slides-2026.svg` | https://upload.wikimedia.org/wikipedia/commons/4/4f/Google_Slides_icon_%282026%29.svg (Wikimedia Commons, `File:Google Slides icon (2026).svg`) | The 2026 Google Slides mark, used for `application/vnd.google-apps.presentation` rows. |
| `google-forms-2026.svg` | `../site/assets/google-forms-2026.svg` | https://logos.lndev.me/logos/google-forms-2026.svg (downloaded 2026-09-15) | The 2026 Google Forms mark (purple/blue gradient); used in the New menu and apps launcher. The library's older `google-forms.svg` was not used. |
| `google-calendar-2026.svg` | `../site/assets/google-calendar-2026.svg` | https://logos.lndev.me/logos/google-calendar-2026.svg (downloaded 2026-09-15) | The 2026 Google Calendar mark; used in the right side panel and apps launcher. |
| `google-keep-2026.svg` | `../site/assets/google-keep-2026.svg` | https://logos.lndev.me/logos/google-keep-2026.svg (downloaded 2026-09-15) | The 2026 Google Keep mark; the library's older flat `google-keep.svg` was not used. |
| `google-tasks-2026.svg` | `../site/assets/google-tasks-2026.svg` | https://logos.lndev.me/logos/google-tasks-2026.svg (downloaded 2026-09-15) | The 2026 Google Tasks mark; the library's older `google-tasks.svg` was not used. |
| `google-contacts.svg` | `../site/assets/google-contacts.svg` | https://logos.lndev.me/logos/google-contacts.svg (downloaded 2026-09-15) | The Google Contacts mark (blue person). No 2026 variant exists in the library (`google-contacts-2026.svg` answers 404) and none was found on Wikimedia Commons, so this is the newest available official file. |

SHA-256 of the served copies:

```
043894bcca12a0dbac2ca15eff47feaeba1d94c23c86f571fe0ed378366a8d92  google-drive-2026.svg
b1f3fe6215b713aecb906aa3707a1c599d357f5ff5977433b22ec9500ddb2207  google-docs-2026.svg
cb193fb01d10b571d195e0ddef5398279a6590f225792ac8023153dbf756e412  google-sheets-2026.svg
1332ed1977951a2fa4a31dd513fc424f1ee5bcc77c6704f9c44b115ced61f524  google-slides-2026.svg
90934e52a988a29a363655f9d7a72101ff00d225ed3e31a35aef45e0c2952bfa  google-forms-2026.svg
83cf9db71b4150fcbf84342e483298ebcea0d261b56dda29821d92743bc7d7c3  google-calendar-2026.svg
e61844731d298e5acf4e10280fbc2f051ba8b8fccf2ee172ddaa32005c88e004  google-keep-2026.svg
5fba48b3fdc8e0290e0d9bd3234885b308b5627c0100a6863bc14f56c79e2b53  google-tasks-2026.svg
3bac4e978450be6eb149fb106998144e4f1ff3a38466a8ee380bd50af130ffbb  google-contacts.svg
```

Superseded marks in the same logo library were inspected and deliberately **not** used: `google-drive.svg` (the flat 2020
triangle, fills `#0066da`/`#ea4335`/`#00832d`/`#2684fc`/`#00ac47`/`#ffba00`) and `google-drive-old.svg` (the 2014–2020
triangle). The library's `google-drive-wordmark.svg` was also inspected and not used: it is the old icon stacked above the
words "Google Drive", which is not what the web client shows — Drive's header pairs the product mark with the single word
"Drive" set in the interface font, so the app renders that word as page text (Roboto, grey `#5f6368`), matching the product.

The four-colour plus on the "New" button, the folder/PDF/image/text glyphs and every other icon are interface glyphs drawn
as SVG paths in `../site/icons.js` in the Material Symbols visual language; they are not logo files.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/roboto-latin.woff2` | https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBHMdazQ.woff2 (Roboto v51, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt) |

Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic). SHA-256 of the served file:
`0a44e0bb6ba5c8537e8814c148ef7755f1bce12112361231f595ecc584a18d7a`. Roboto is Drive's interface font; Google Sans (used by
Google for the "Drive" wordmark and large headings) is not publicly licensed, so Roboto carries those strings here.

## Trademarks

Google Drive, Google Docs, Google Sheets, Google Slides, Google Forms, Google Calendar, Google Keep, Google Tasks, Google Contacts, Google Workspace, Google and the logos above are trademarks of
Google LLC. They are used only to identify the service this package simulates inside a test environment. This package is an
independent Firedrill Tool and is not affiliated with, sponsored by or endorsed by Google.
