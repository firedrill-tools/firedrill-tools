# Third-party assets used by the GitLab Tool app

The browser app is served from `../site/`. This directory keeps the attribution record, the licence texts and the
original downloads. The copies under `../site/assets/` are byte-identical. The framework serves only
html/css/js/json/image/font files, so Markdown and licence text cannot live inside the served root.

## Logos (trademarks of GitLab Inc.)

| file | served copy | source | brand version |
|---|---|---|---|
| `gitlab.svg` | `../site/assets/gitlab.svg` | https://logos.lndev.me/logos/gitlab.svg (library: https://github.com/ln-dev7/logos-apps) | The current (2022 rebrand) rounded tanuki in `#e24329` / `#fc6d26` / `#fca326`, as shown at the top of GitLab's left sidebar today. SHA-256 `feaf673c60048608bfcf77c2901f1f32dfe06aa18c69dd44b8c666c69c472b69`. |
| `gitlab-wordmark.svg` | `../site/assets/gitlab-wordmark.svg` | https://logos.lndev.me/logos/gitlab-wordmark.svg (same library) | The current "GitLab" wordmark in the 2022 brand dark `#171321`. It is bundled for completeness; the interface itself shows only the tanuki, as GitLab's signed-in UI does. SHA-256 `1c3ed147d7bca0bb2a04ba51de7ebd18ce06cd60feebc88e3c8a7e0fdb1ae0f5`. |

- **Download:** 2026-09-15, used unmodified.
- **Rejected candidate:** `square-gitlab.svg` from the same library, a third-party square redraw rather than the
  product mark.
- **Use:** the mark is referenced only with `<img>` and `<link rel="icon">`. Nothing is redrawn or recoloured.

GitLab, the GitLab logo and the tanuki are trademarks of GitLab Inc. They identify the simulated service inside a
test environment only. This package is not affiliated with, sponsored by or endorsed by GitLab Inc.

## Icons

- **What:** the interface glyphs in `../site/icons.js` are the 16 px **GitLab SVG icons** used by the Pajamas design
  system.
- **Source:** npm package `@gitlab/svgs` 3.164.0, `dist/sprite_icons/<name>.svg`, fetched from
  `https://cdn.jsdelivr.net/npm/@gitlab/svgs@3.164.0/dist/sprite_icons/<name>.svg` on 2026-09-15.
- **Licence:** MIT, © GitLab Inc.; the text is in `gitlab-svgs-LICENSE.txt`, copied from
  `https://cdn.jsdelivr.net/npm/@gitlab/svgs@3.164.0/LICENSE`.
- **Changes:** path data is copied unmodified. Only the `fill-rule` attribute is kept, as a one-character prefix.
- **Set:** 141 icons, including `issues`, `issue-closed`, `merge-request`, `merge`, `branch`, `commit`, `doc-text`,
  `folder-o`, `search`, `plus`, `chevron-*`, `lock`, `eye-slash`, `comments`, `label`, `planning`, `code`, `rocket`,
  `shield`, `deployments`, `cloud-gear`, `monitor`, `chart`, `settings`, `thumbtack`, `tanuki`, `todo-done`,
  `status_warning` and `status_success`.

## Fonts

GitLab renders its interface in **GitLab Sans** (based on Inter) and code in **GitLab Mono** (based on JetBrains Mono).
The app bundles the official builds.

| served file | source | licence |
|---|---|---|
| `../site/assets/fonts/GitLabSans.woff2` | https://cdn.jsdelivr.net/npm/@gitlab/fonts@1.3.1/gitlab-sans/GitLabSans.woff2 (npm `@gitlab/fonts` 1.3.1, project https://gitlab.com/gitlab-org/frontend/fonts). SHA-256 `9892dc17af892e03de41625c0ee325117a3b8ee4ba6005f3a3eac68510030aed` | SIL Open Font License 1.1: `fonts/GitLabSans-OFL.txt`. Copyright (c) 2016 The Inter Project Authors; portions Copyright 2022 GitLab B.V. |
| `../site/assets/fonts/GitLabMono.woff2` | https://cdn.jsdelivr.net/npm/@gitlab/fonts@1.3.1/gitlab-mono/GitLabMono.woff2 (same package). SHA-256 `29c2152dac8739499dd0fe5cd37a486ebcc7d4798c9b6d3aeab65b3172375b05` | SIL Open Font License 1.1: `fonts/GitLabMono-OFL.txt` (JetBrains Mono authors; GitLab adjustments) |

Both files are variable-weight WOFF2 fonts, used unmodified. The stylesheet falls back to GitLab's own system stacks
when a font cannot load.
