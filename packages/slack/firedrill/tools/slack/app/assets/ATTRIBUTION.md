# Third-party assets used by the Slack Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Slack Technologies, LLC, a Salesforce company)

| file | served copy | source | brand version |
|---|---|---|---|
| `slack.svg` | `../site/assets/slack.svg` | https://logos.lndev.me/logos/slack.svg (library: https://github.com/ln-dev7/logos-apps) | The current Slack mark introduced in January 2019: the four-colour "octothorpe" of two lozenges and two speech-bubble bars in `#e01e5a` (red), `#36c5f0` (blue), `#2eb67d` (green) and `#ecb22e` (yellow). SHA-256 `b35d0faf5b8b1c404d73e45b2f00c87442e8fcd55b568b77aca66c22f38cd085`. |
| `slack-wordmark.svg` | `../site/assets/slack-wordmark.svg` | https://logos.lndev.me/logos/slack-wordmark.svg (same library) | The current lowercase "slack" wordmark (black text) that accompanies the 2019 mark. SHA-256 `3651702f4f091ac8adc9122eaffb9533130f2c7318e18fce1eeeef39c559e3f5`. |

Downloaded on 2026-09-14 and used unmodified, referenced with `<img>`. The only other Slack-named entry in the library
(`slackware`) is an unrelated Linux distribution and was not used. The mark appears as the app favicon, on the
workspace tile in the workspace switcher rail and in the "About this workspace" panel; the wordmark appears in that
panel next to the mark.

Slack and the Slack logo are trademarks of Slack Technologies, LLC. They identify the simulated service inside a test
environment only; this package is not affiliated with, sponsored by or endorsed by Slack or Salesforce.

## Font

Slack's own interface faces (Slack-Lato, Slack-Circular) are proprietary and are not bundled. The app uses **Lato**, the
open typeface Slack's UI face was derived from, in the three weights the client uses (regular 400, bold 700, black 900).

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/lato-latin-400.woff2` | `../site/assets/fonts/lato-latin-400.woff2` | https://fonts.gstatic.com/s/lato/v25/S6uyw4BMUTPHjx4wXiWtFCc.woff2 (Lato v25, latin subset, as served by https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900) — SHA-256 `d4ae5188a65370ecfe28f42293bbee8297cfd5712c6aadfdb270d48f2bcd88b0` | SIL Open Font License 1.1 — `fonts/OFL.txt` |
| `fonts/lato-latin-700.woff2` | `../site/assets/fonts/lato-latin-700.woff2` | https://fonts.gstatic.com/s/lato/v25/S6u9w4BMUTPHh6UVSwiPGQ3q5d0.woff2 — SHA-256 `7a7ce1a34f3e9944fe88fc61abbc93b6db383afa2b90815fd7ccea456fbce4e5` | SIL Open Font License 1.1 — `fonts/OFL.txt` |
| `fonts/lato-latin-900.woff2` | `../site/assets/fonts/lato-latin-900.woff2` | https://fonts.gstatic.com/s/lato/v25/S6u9w4BMUTPHh50XSwiPGQ3q5d0.woff2 — SHA-256 `bd9a6192274f8f2f3ce31cd3d2cae5ebe32e2fa86fc7c4f60a3c28556e496d56` | SIL Open Font License 1.1 — `fonts/OFL.txt` |

`fonts/OFL.txt` was copied from https://raw.githubusercontent.com/google/fonts/main/ofl/lato/OFL.txt.
Copyright (c) 2010-2014 by tyPoland Lukasz Dziedzic (team@latofonts.com) with Reserved Font Name "Lato".

## Icons and emoji

The monochrome interface glyphs in `../site/icons.js` are original SVG paths drawn for this package in the outlined
style of the Slack client; they are not Slack's icon files. Reactions and `:shortcodes:` render as Unicode emoji from
the viewer's system font; no emoji image set is bundled.
