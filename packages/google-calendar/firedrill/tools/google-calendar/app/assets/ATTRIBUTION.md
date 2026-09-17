# Third-party assets used by the Google Calendar Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logo (trademark of Google LLC)

| file | served copy | source | brand version |
|---|---|---|---|
| `google-calendar-2026.svg` | `../site/assets/google-calendar-2026.svg` | https://logos.lndev.me/logos/google-calendar-2026.svg (library: https://github.com/ln-dev7/logos-apps) | The Google Calendar mark in use since 19 May 2026: the blue rounded tile with a light-blue top band and the white "31". Corroborated by Wikimedia Commons `File:Google Calendar icon (2026).svg` — https://commons.wikimedia.org/wiki/File:Google_Calendar_icon_(2026).svg ("Logo for Google Calendar since May 19, 2026, replacing Google Calendar icon (2020).svg"; original file https://upload.wikimedia.org/wikipedia/commons/f/fa/Google_Calendar_icon_%282026%29.svg, 800×859) — same geometry and colours (`#bbe2ff` band, `#3c90ff` body). |

Downloaded on 2026-09-14 and used unmodified (SHA-256 `83cf9db71b4150fcbf84342e483298ebcea0d261b56dda29821d92743bc7d7c3`). The
superseded mark in the same library was inspected and deliberately not used: `google-calendar.svg` (the four-colour
2020 tile with the blue "31", fills `#4285f4`/`#34a853`/`#fbbc04`/`#ea4335`/`#1967d2`/`#188038`). The library has no
Google Calendar wordmark; the "Calendar" product name beside the mark is rendered as page text (Roboto, grey `#444746`),
the way the web client shows it. The four-colour plus on the "Create" button is an interface glyph drawn in
`../site/icons.js`, not a logo file.

Google Calendar, Google Meet and the Google Calendar logo are trademarks of Google LLC. They identify the simulated
service inside a test environment only; this package is not affiliated with or endorsed by Google.

## Font

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/roboto-latin.woff2` | https://fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBHMdazQ.woff2 (Roboto v51, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700) | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/roboto/OFL.txt) |

Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic). SHA-256 of the served file:
`0a44e0bb6ba5c8537e8814c148ef7755f1bce12112361231f595ecc584a18d7a`.

## Icons

All other glyphs (menu, search, chevrons, pencil, bin, people, video camera, pin, bell, …) are monochrome SVG paths
drawn in the Material Symbols visual language inside `../site/icons.js`; no icon font or remote resource is used.
