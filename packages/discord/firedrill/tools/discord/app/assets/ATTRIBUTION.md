# Third-party assets used by the Discord Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the font licence and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so this Markdown file and the licence text cannot live inside the served root).

## Logos (trademarks of Discord Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `discord.svg` | `../site/assets/discord.svg` | https://logos.lndev.me/logos/discord.svg (library: https://github.com/ln-dev7/logos-apps) | The current Discord symbol ("Clyde") introduced in 2021, in Blurple `#5865f2`. SHA-256 `83c5ec4398810f97fb23af227811ca0fe5992abd49358b65a0f505c5980e7080`. |
| `discord-wordmark.svg` | `../site/assets/discord-wordmark.svg` | https://logos.lndev.me/logos/discord-wordmark.svg (same library) | The current symbol-plus-"DISCORD" wordmark lock-up (2021), Blurple `#5865f2`. SHA-256 `5ee7b1bc0b9692f7b89267018026c200b1c8850c2bf32e20609c13a277d6166a`. |

Downloaded on 2026-09-15 and used unmodified, referenced with `<img>`. The other Discord-named entries in the library
(`discord-js`, `js-discord`, `js-discord-wordmark`, `betterdiscord`) are third-party projects and were not used.

Where the symbol appears: favicon, loading screen, the Direct Messages (Home) button in the server rail, the default
avatars (the symbol on one of the six default avatar colours, as the client renders accounts without an uploaded
avatar), the "Member Since" line of profile cards, and the wordmark on the access-error card. On dark surfaces the
unmodified file is rendered monochrome white or grey with a CSS `filter`, matching the single-colour symbol Discord
itself uses on those surfaces; the path data is never redrawn or altered.

Discord, the Discord logo and Clyde are trademarks of Discord Inc. They identify the simulated service inside a test
environment only; this package is not affiliated with, sponsored by or endorsed by Discord Inc.

## Font

Discord's interface face (gg sans) is proprietary and is not bundled. The app uses **Noto Sans**, an open humanist
sans-serif with similar proportions, as one variable file covering the weights the client uses (400-800).

| file | served copy | source | licence |
|---|---|---|---|
| `fonts/noto-sans-latin-variable.woff2` | `../site/assets/fonts/noto-sans-latin-variable.woff2` | https://fonts.gstatic.com/s/notosans/v42/o-0bIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjc5a7du3mhPy0.woff2 (Noto Sans v42, latin subset, variable weight, as served by https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700;800) — SHA-256 `afc7a910f4ff04ee2ff7b3a2ef8b24f8340b8ea8d8125f2779f1f0b69d1b56b9` | SIL Open Font License 1.1 — `fonts/OFL.txt` |

`fonts/OFL.txt` was copied from https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/OFL.txt
(SHA-256 `cee9892f9f0cc8fe882c9e9537ee6a89621d86ee7ceaf70b02e2b2b1c25c061a`).
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic).

## Icons and emoji

The monochrome interface glyphs in `../site/icons.js` are original SVG paths drawn for this package in the filled,
rounded style of the Discord client; they are not Discord's icon files. Reactions and emoji render as Unicode emoji
from the viewer's system font; guild custom emoji have no image in state and are shown as `:name:` chips. No emoji
image set is bundled.
