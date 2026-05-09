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
npm run analyze:interwheel -- --runner=pure --concurrency=4 --trials=20 --seed=42 --max-seconds=30
npm run analyze:interwheel -- --runner=pure --policy.wall=0.5 --trials=10 --seed=42 --max-seconds=30
npm run analyze:interwheel -- --runner=pure --policy.climb=1.2 --policy.wall=0.8 --trials=10 --seed=42 --max-seconds=30
npm run analyze:interwheel -- --verify-pure-planner --trials=3 --seed=42 --max-seconds=30
npm run analyze:interwheel:policies -- --trials=40 --seed=4200 --max-seconds=30
npm run analyze:interwheel:policies -- --study=metric-params --trials=8
npm run analyze:interwheel:climb -- --seed=42 --max-seconds=300
npm run analyze:interwheel:climb -- --seed=42 --max-seconds=300 --no-water --min-height=5000
npm run analyze:interwheel:edges -- --seed=42 --max-height=4000
```

For the persistent leaderboard locally, run `npm run dev:api` in one terminal and `npm run dev` in another; Vite proxies `/api` to the Node server. For production, run `npm run build` and then `npm start`.

For fast Interwheel AI sanity checks before committing, prefer `npm run analyze:interwheel:quick`: it runs one deterministic seed with a 30-second in-game cap and records movement analytics. Use `npm run analyze:interwheel -- --max-seconds=N --trials=M --seed=S` when a broader capped comparison is useful.

Interwheel analytics has two trusted execution modes. The default `mounted` runner uses the browser-mounted game with rendering and particles disabled. The `pure` runner uses the same simulator and planner without Pixi game updates, and can run multiple browser pages in parallel with `--concurrency=N` for larger seed batches. Before relying on the pure runner after planner/gameplay changes, run `npm run analyze:interwheel -- --verify-pure-planner --trials=N --seed=S --max-seconds=M`; it compares the pure runner against mounted headless tick by tick.

Interwheel planner behavior is controlled through a small numeric policy object instead of scattered scoring constants. The current live knobs are `--policy.climb=N` and `--policy.wall=N`. The analytics output includes the chosen policy and average score components for selected plans, so policy changes can be compared against movement stats such as height, run speed, bonus pickups, wall jumps, waits, and phase time.

For broader policy characterization, run `npm run analyze:interwheel:policies`. It runs policy studies over a fixed seed population and writes `raw.json`, `summary.json`, and `report.md` under `.tmp/interwheel-policy-studies/<timestamp>/`. The study tool treats responsiveness as first-class: it can sweep policy coefficients such as `wall`, and metric parameters such as `wallLandingBonus` / `wallTickBonus`, then reports response-curve linearity and largest adjacent behavior jumps.

For an experimental single-seed Interwheel climb check, run `npm run analyze:interwheel:climb`. This offline validator runs the trusted pure simulator with a climb-biased agent and reports whether the agent survived to the time cap with recent upward progress. Add `--no-water --min-height=N` to temporarily disable drowning and use a target-height criterion for route-only calibration against the analytical edge validator. It is analysis tooling only; live level generation does not call it.

For an experimental analytical Interwheel generation check, run `npm run analyze:interwheel:edges`. This builds a local reachability graph from generated wheels using sampled jump trajectories, forbidden mine landing arcs, and wall-assisted routes. It is offline analysis tooling only.

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
