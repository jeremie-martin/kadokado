# KadoKado site shell assets

These assets support the nostalgic launcher shell in `src/main.ts` and
`src/style.css`.

Evidence level: `capture-backed` and `asset-backed`.

## Source captures

- Wayback homepage capture: `https://web.archive.org/web/20060828030130/http://www.kadokado.com/`
- Wayback CSS captures:
  - `https://web.archive.org/web/20060828030130cs_/http://data.kadokado.com/css/main.css?version=10`
  - `https://web.archive.org/web/20060828030130cs_/http://data.kadokado.com/css/panels.css?version=10`
  - `https://web.archive.org/web/20060828030130cs_/http://data.kadokado.com/css/games.css?version=10`

## Local assets

- `public/assets/site/kadokado/1_logo.gif`
- `public/assets/site/kadokado/background.gif`
- `public/assets/site/kadokado/containerBg.gif`
- `public/assets/site/kadokado/topBar.gif`
- `public/assets/site/kadokado/gameBg.gif`
- `public/assets/site/kadokado/gameBg_open.gif`
- `public/assets/site/kadokado/paneBg.gif`
- `public/assets/site/kadokado/paneFooter.gif`
- `public/assets/site/kadokado/paneHeader.gif`
- `public/assets/site/kadokado/games/*.gif`

## Current scope

The shell mirrors the 2005-2006 fixed-width KadoKado portal: logo, top bar,
left navigation, pane boxes, right sidebar, 491px game list rows, record badges,
toggleable help boxes, and orange/green action links. The game canvases still
mount through the existing TypeScript/PixiJS ports rather than the original
Flash runtime.

## Product decisions

The site must feel like KadoKado without pretending to be the original service.
For v1, every visible platform feature must be functional, truthful, or removed.

Keep:

- `Jouer`: game list and game launch.
- `Scores`: real leaderboard data from the local API.
- `Fidelity`: project evidence categories and links to local docs.
- `About`: preservation scope and non-affiliation context.
- Per-game `aide`: real controls/objective text.
- `Record`: real saved leaderboard score where available, with local best as
  the initial fallback.

Do not ship in v1:

- Fake account login, registration, or secret-code fields.
- Gifts, prize catalogs, ads, or reward-like sidebars.
- Guestbook, forum, legal pages, password reset, or unsupported community pages.
- Clans, unless a real clan feature exists. Do not show fake clan names.
- Motion Twin copyright footer or any wording that presents this project as
  Motion Twin.

Allowed footer wording should be neutral, for example:

`Fan preservation project - original games by Motion Twin`
