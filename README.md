# MotionTwin Ports

Playable TypeScript/PixiJS ports of selected MotionTwin/KadoKado Flash games.

The goal is high-fidelity reimplementation using original extracted assets and behavior derived from the open source Flash projects. This is not a Flash runtime, and it is not meant to be a loose remake.

TypeScript/PixiJS is the current implementation route because it is working well for browser playback, fast iteration, and direct asset reuse. It is a working choice, not a permanent constraint. If another runtime or extraction approach gives better fidelity for a game, the project should stay open to it.

## Games

- Interwheel: `/#interwheel`
- Pioupiou: `/#pioupiou`
- Manda: `/#manda`
- Kill-Bulle: `/#killbulle`
- Linea: `/#linea`
- Alphabounce: `/#alphabounce`
- K-Slash: `/#kslash`
- Iron Chouquette: `/#iron-chouquette`

The root route shows a KadoKado-style launcher shell based on archived 2005-2006
site captures.

## Commands

```sh
npm install
npm run dev
npm run dev:api
npm run build
npm run preview
npm start
npm run test:api
npm run test:e2e
npm run analyze:interwheel:quick
npm run analyze:interwheel -- --max-seconds=30 --trials=3 --seed=42
```

For the persistent leaderboard locally, run `npm run dev:api` in one terminal and `npm run dev` in another; Vite proxies `/api` to the Node server. For production, run `npm run build` and then `npm start`.

For fast Interwheel AI sanity checks before committing, prefer `npm run analyze:interwheel:quick`: it runs one deterministic seed with a 30-second in-game cap and records movement analytics. Use `npm run analyze:interwheel -- --max-seconds=N --trials=M --seed=S` when a broader capped comparison is useful.

The leaderboard database defaults to `.data/leaderboard.sqlite`. Override it with `LEADERBOARD_DB_PATH`. Set `IP_HASH_SECRET` in production so stored IP hashes are stable without storing raw IPs. If the app is behind a trusted reverse proxy, set `TRUST_PROXY=1`.

For single-node deployment notes, health checks, and SQLite backup/restore, see
`docs/ops/single-node-vps.md`.

## Layout

- `src/main.ts`: launcher and hash routing.
- `src/games/registry.ts`: list of available games.
- `src/games/<game>/index.ts`: one self-contained Pixi game module with `mount()` and `destroy()`.
- `src/games/_shared/frames.ts`: shared helpers for loading extracted sprite frames with pivots.
- `public/assets/<game>/`: extracted raster assets used by the ports.
- `server/`: Express + SQLite leaderboard API.
- `docs/FIDELITY.md`: current fidelity state, validation plan, and next work.
- `docs/ops/single-node-vps.md`: basic VPS deployment and operations runbook.

## Current State

All registered games are playable and use real extracted assets, but none should be considered 100% faithful yet. The current priority is to make the ports measurable against the original games: preserve asset provenance, compare against reference captures, and replace guessed behavior with source-backed behavior where possible.
