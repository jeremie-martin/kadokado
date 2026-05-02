# Fidelity Notes

Updated: 2026-05-02

This file is a working control panel for fidelity. It should stay practical: what is known, what is still approximate, and what would make us confident that a port matches the original. It is not an architecture decision record and it should not lock the project into TypeScript/PixiJS forever.

## Quality Bar

A port is only "done" when the important behavior and feel have been checked against the original Flash game, not merely when it is playable.

For each game, the target is:

- Original extracted assets are used at the correct frame counts, pivots, scales, and draw order.
- Physics, timing, RNG, scoring, collision, and input behavior are source-backed or explicitly documented as approximations.
- The game runs at the original intended tick rate and preserves the original control feel.
- Representative screenshots or captures from the original are compared against the port.
- Known deviations are listed instead of hidden.

## Current Technical Route

The current route is TypeScript plus PixiJS.

Reasons this is working:

- The games are small enough to port game-by-game.
- Pixi maps well to the extracted 2D Flash assets.
- Browser playback makes iteration, sharing, and deployment simple.
- The per-game `mount()` / `destroy()` shape keeps ports isolated.

This can be revisited. If a game needs a different renderer, a source-to-code extraction pass, or a native runtime to match behavior more closely, that should be judged per game.

## Shared Next Steps

1. Preserve asset provenance.
   Add or keep extraction notes/manifests that connect each exported PNG series to its original Flash symbol, frame range, pivot, and intended transform.

2. Build a reference workflow.
   Capture the original game at known states where possible: start screen, first movement, collision, death, scoring, and unusual edge cases. Ruffle, a projector, or a controlled SWF run can all be useful if they produce repeatable evidence.

3. Make comparison states deterministic.
   Add debug seeds or fixed scenarios where needed so a port can render the same situation repeatedly.

4. Separate fragile behavior from rendering when useful.
   Keep full rewrites small, but pull collision or simulation code into testable units when it reduces risk.

5. Track approximations openly.
   A guessed constant is acceptable during porting, but it should be marked until it is verified against source or reference behavior.

6. Revisit audio and platform API behavior.
   The current ports focus on playable visuals and controls. Sounds, score submission, replay behavior, and original platform hooks still need a deliberate pass.

## Pioupiou

Status: playable, asset-backed, not fidelity-certified.

Implemented:

- 300x320 Pixi stage with extracted Pioupiou assets.
- Fixed-step update loop targeting the original 40 FPS feel.
- Arrow-key movement, running, falling, climbing, block landing, crush/death behavior, bonuses, scoring, meter, and simple effects.
- Masked landed-block rendering that follows the original stacked-column visual idea.

Still approximate or unverified:

- Exact hero animation frame mapping, frame holds, pivots, squash/stretch, and state transitions.
- Edge cases around climbing, falling blocks, crush timing, and standing between columns.
- Falling block spawn rules, difficulty growth, bonus probabilities, and scoring details versus the original source.
- HUD typography and precise Flash text rendering.
- Audio, original platform score submission, and end-of-run flow.

Useful next work:

1. Identify the original source classes and constants that drove block spawning, hero movement, and scoring.
2. Create a small reference capture set for startup, left/right movement, climbing, block impact, bonus pickup, and death.
3. Audit every sprite series used by the hero and effects against original timeline labels or frame ranges.
4. Add a debug fixture that starts the hero and a few blocks in known positions for repeatable visual checks.

## Interwheel

Status: playable, asset-backed, not fidelity-certified.

Implemented:

- 300x300 Pixi stage with extracted Interwheel assets.
- One-button jump/grab loop, wheel generation, wheel rotation, mines, pastilles, water pressure, score/meter, wall sliding, death, particles, and decorative background layers.
- Blob wall-slide rendering is present after the recent wall visual fix.
- Per-game cleanup removes keyboard handlers, pointer handlers, and ticker callbacks.

Still approximate or unverified:

- Exact blob timeline mapping for grab, fly, wall-slide, wet, and death states.
- Wheel generation order, seeded randomness, wheel spacing, mine placement, and difficulty ramp versus original behavior.
- Original transforms and pivots for wheels, masks, dust, motifs, frises, explosions, mine parts, oil, and stars.
- Particle counts, velocities, alpha curves, water interaction, and death effects.
- Pastille attraction/collection thresholds and scoring timing.
- Audio, original platform score submission, and end-of-run flow.

Useful next work:

1. Compare the current port against the original first-run sequence: initial wheel, first jump, first wall contact, first mine, first water contact.
2. Build an asset manifest for Interwheel's large sprite sets so frame indexes and pivots are not tribal knowledge.
3. Verify blob state frame ranges from the original timeline instead of relying on inferred frame slices.
4. Add a fixed debug route or seed for repeatable wheel layouts and wall-slide checks.

## Repo Health Notes

- Keep each game isolated behind the shared `GameModule` interface.
- Every `mount()` must have a complete `destroy()` that removes event listeners, ticker callbacks, timers, and owned Pixi resources.
- Shared helpers should stay boring and asset-focused unless multiple games prove they need the same behavior.
- Avoid broad refactors while fidelity is still being established. Small, source-backed corrections are more valuable than general abstractions.

