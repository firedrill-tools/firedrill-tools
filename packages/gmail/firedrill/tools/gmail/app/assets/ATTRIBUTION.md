# Third-party assets used by the Gmail Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logo (trademark of Google LLC)

| file | served copy | source | brand version |
|---|---|---|---|
| `google-gmail-2026.svg` | `../site/assets/google-gmail-2026.svg` | https://logos.lndev.me/logos/google-gmail-2026.svg (library: https://github.com/ln-dev7/logos-apps) | The Gmail "M" mark in use since 19 May 2026: Google's gradient Workspace icon (pink→red→orange→yellow "M", red left flap, green→teal→blue right flap). Corroborated by Wikimedia Commons `File:Gmail icon (2026).svg` — https://commons.wikimedia.org/wiki/File:Gmail_icon_(2026).svg ("Logo for Gmail since May 19, 2026, replacing Gmail icon (2020).svg"; original file https://upload.wikimedia.org/wikipedia/commons/8/8f/Gmail_icon_%282026%29.svg) — whose path data and gradient stops are identical to the library file. |

Downloaded on 2026-09-14 and used unmodified. Superseded marks in the same library were inspected and deliberately
not used: `gmail.svg` / `gmail-old.svg` / `gmail-wordmark.svg` (the pre-2020 red envelope, fills `#d44c3d`/`#f2f2f2`)
and `google-gmail.svg` (the flat four-colour "M" of October 2020 – May 2026, fills `#4285f4`/`#34a853`/`#fbbc04`/
`#ea4335`/`#c5221f`). The "Gmail" wordmark beside the mark is rendered as page text (Roboto, grey `#5f6368`), the
way the web client shows its product name next to the icon; no wordmark image is bundled.

## Side panel logos (trademarks of Google LLC)

The right-hand side panel shows the Google product marks Gmail places there. The buttons only open a "not simulated by
this Tool" panel; the logos identify the Gmail chrome and nothing else.

| file | served copy | source | brand version |
|---|---|---|---|
| `google-calendar-2026.svg` | `../site/assets/google-calendar-2026.svg` | https://logos.lndev.me/logos/google-calendar-2026.svg | 2026 Google Calendar mark (the library also holds the 2020 `google-calendar.svg`, not used) |
| `google-keep-2026.svg` | `../site/assets/google-keep-2026.svg` | https://logos.lndev.me/logos/google-keep-2026.svg | 2026 Google Keep mark (2020 `google-keep.svg` not used) |
| `google-tasks-2026.svg` | `../site/assets/google-tasks-2026.svg` | https://logos.lndev.me/logos/google-tasks-2026.svg | 2026 Google Tasks mark (2020 `google-tasks.svg` not used) |
| `google-contacts.svg` | `../site/assets/google-contacts.svg` | https://logos.lndev.me/logos/google-contacts.svg | Google Contacts mark; the library holds no newer version |

Downloaded on 2026-09-15 from the same library (https://github.com/ln-dev7/logos-apps) and used unmodified.

Gmail, the Gmail logo, Google Calendar, Google Keep, Google Tasks, Google Contacts and their logos are trademarks of
Google LLC. They identify the simulated service inside a test environment only; this package is not affiliated with or
endorsed by Google.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/roboto-latin.woff2` | https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBHMdazQ.woff2 (Roboto v51, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt) |

Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic).
