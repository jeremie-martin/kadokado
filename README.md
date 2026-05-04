# MotionTwin Ports

Playable TypeScript/PixiJS ports of selected MotionTwin/KadoKado Flash games.

The goal is high-fidelity reimplementation using original extracted assets and behavior derived from the open source Flash projects. This is not a Flash runtime, and it is not meant to be a loose remake.

TypeScript/PixiJS is the current implementation route because it is working well for browser playback, fast iteration, and direct asset reuse. It is a working choice, not a permanent constraint. If another runtime or extraction approach gives better fidelity for a game, the project should stay open to it.

## Games

- Interwheel: `/#interwheel`
- Pioupiou: `/#pioupiou`
- Alphabounce: `/#alphabounce`

The root route shows the small launcher.

## Commands

```sh
npm install
npm run dev
npm run build
npm run preview
```

## Layout

- `src/main.ts`: launcher and hash routing.
- `src/games/registry.ts`: list of available games.
- `src/games/<game>/index.ts`: one self-contained Pixi game module with `mount()` and `destroy()`.
- `src/games/_shared/frames.ts`: shared helpers for loading extracted sprite frames with pivots.
- `public/assets/<game>/`: extracted raster assets used by the ports.
- `docs/FIDELITY.md`: current fidelity state, validation plan, and next work.

## Current State

All registered games are playable and use real extracted assets, but none should be considered 100% faithful yet. The current priority is to make the ports measurable against the original games: preserve asset provenance, compare against reference captures, and replace guessed behavior with source-backed behavior where possible.
