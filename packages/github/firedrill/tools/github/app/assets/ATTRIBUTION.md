# Third-party assets used by the GitHub Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the licence texts and the
original downloads; the copies under `../site/assets/` are byte-identical (the framework serves only
html/css/js/json/image/font files, so Markdown and licence text cannot live inside the served root).

## Logos (trademarks of GitHub, Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `github.svg` | `../site/assets/github.svg` | https://logos.lndev.me/logos/github.svg (library: https://github.com/ln-dev7/logos-apps) | The current "Invertocat" mark (single-colour `#161614` cat silhouette in a circle) as shown in github.com's global header and footer today. SHA-256 `c25fe198ee965048948cb890df51aeab9d9affd16ae952a23ff6dccdbba290a3`. |
| `github-wordmark.svg` | `../site/assets/github-wordmark.svg` | https://logos.lndev.me/logos/github-wordmark.svg (same library) | The current "GitHub" wordmark (`#11110f`), used on the sign-in-less "Bad credentials" screen. SHA-256 `8aeb167d5a502149286a0adf50a7281eb938aa5b959efbbd28b528223e70998a`. |

Downloaded on 2026-09-14 and used unmodified. Other marks in the same library were inspected and deliberately
not used: `github-octocat.svg` (the multi-colour Octocat mascot, not the product mark), `github-alt.svg` and
`square-github.svg` (third-party redraws). The mark is referenced with `<img>` only; nothing is redrawn.

GitHub and the GitHub logo are trademarks of GitHub, Inc. They identify the simulated service inside a test
environment only; this package is not affiliated with or endorsed by GitHub.

## Icons

The interface glyphs in `../site/icons.js` are 16 px **Octicons** (`primer/octicons`, MIT licence, © GitHub Inc.),
path data copied unmodified from `https://raw.githubusercontent.com/primer/octicons/main/icons/<name>-16.svg` on
2026-09-14 (83 icons: `repo`, `issue-opened`, `issue-closed`, `skip`, `git-pull-request`, `git-pull-request-draft`,
`git-merge`, `git-branch`, `git-commit`, `file`, `file-directory-fill`, `code`, `search`, `plus`, `bell`,
`triangle-down`, `check`, `x`, `comment`, `tag`, `person`, `gear`, `pencil`, `history`, `kebab-horizontal`, `lock`,
`dot-fill`, `chevron-*`, `mark-github`, …). Licence text: `octicons-LICENSE.txt` (copied from
https://raw.githubusercontent.com/primer/octicons/main/LICENSE).

## Font

github.com renders its interface in the system font stack `-apple-system, BlinkMacSystemFont, "Segoe UI",
"Noto Sans", Helvetica, Arial, sans-serif`. The app uses exactly that stack and bundles the one member of it that is
freely licensed, so the rendering is the same on machines without a system UI font:

| file | served copy | source | licence |
|---|---|---|---|
| — | `../site/assets/fonts/noto-sans-latin.woff2` | https://fonts.gstatic.com/s/notosans/v42/o-0bIpQlx3QUlC5A4PNB6Ryti20_6n1iPHjc5a7du3mhPy0.woff2 (Noto Sans v42, latin subset, variable weight 100–900, as served by https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700) — SHA-256 `afc7a910f4ff04ee2ff7b3a2ef8b24f8340b8ea8d8125f2779f1f0b69d1b56b9` | SIL Open Font License 1.1 — `fonts/OFL.txt` (copied from https://raw.githubusercontent.com/google/fonts/main/ofl/notosans/OFL.txt) |

Copyright 2022 The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic). Monospace text uses
GitHub's own stack `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`; no
monospace font is bundled.
