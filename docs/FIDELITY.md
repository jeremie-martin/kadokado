# Fidelity Guide

Updated: 2026-05-04

This file is the canonical guide for making the ports faithful to the original
games. It is intentionally not an audit transcript. Long agent pass logs,
superseded conclusions, and stale bug narratives do not belong here.

The source tree, git history, focused tests, and short code comments are better
places for archaeology. This document should help the next porting pass make
better decisions quickly.

## Quality Bar

A port is not done because it is playable. It is done only when the important
behavior and feel have been checked against the original game.

The target for each game:

- Use the original extracted assets with correct frame ranges, pivots, scale,
  masks, and draw order.
- Preserve the original stage size, frame rate, update order, input semantics,
  RNG-sensitive behavior, scoring, collision, and end flow.
- Back behavior with the original source or with reference captures.
- Mark approximations explicitly and keep the list current.
- Verify representative scenarios against the original: first frame, first input,
  first collision, scoring, death, restart, and unusual edge cases.
- Keep cleanup solid: no leaked listeners, tickers, Pixi resources, or stale input
  state after route changes.

## Evidence Levels

Use these labels when documenting a fact or deviation:

- `source-backed`: confirmed from the original `.mt`, `.hx`, SWF metadata, or
  extracted asset manifest.
- `capture-backed`: confirmed by running the original SWF in Ruffle, projector,
  or another controlled runtime.
- `asset-backed`: confirmed from extracted PNG series, dimensions, frame counts,
  or visible sprite content.
- `inferred`: best current guess. This should be temporary and should explain
  what would verify it.
- `intentional deviation`: known difference kept for practical reasons. Explain
  why it is acceptable and what would be needed to remove it.

When evidence conflicts, prefer current source and fresh captures over old notes.
If old documentation disagrees with the game, the old documentation is wrong.

## Porting Workflow

1. Locate the original material.

   Record the source directory, SWF path, loader parameters, asset extraction
   path, stage size, and frame rate. Do not infer FPS from vague convention when
   the SWF header or source has the answer.

2. Read the source before tuning.

   Identify the main loop, fixed-step timing, input gates, state transitions,
   collision checks, scoring, death, restart, and per-frame update order. Port
   these before tuning by feel.

3. Inventory assets.

   For every large sprite series, record the source symbol if known, frame count,
   intended registration point, masks, timeline labels, and whether frame numbers
   are one-indexed Flash frames mapped to zero-indexed arrays.

4. Rebuild the simulation conservatively.

   Match constants and update order first. Keep source quirks if they affect
   gameplay and are verified. Do not "fix" source behavior without marking it as
   an intentional deviation.

5. Rebuild the presentation.

   Match depth planes, MovieClip registration, masks, text placement, alpha,
   blend behavior, frame holds, and particle lifetimes. Pixi containers should
   reflect Flash depth order, not just approximate visual grouping.

6. Compare against the original.

   Use reference captures for known states. Add debug fixtures or deterministic
   seeds when randomness prevents repeatable comparison.

7. Keep the docs current and small.

   Document only the live state: current approximations, current verification
   status, and the next checks that matter. Delete stale conclusions when code or
   evidence supersedes them.

## Reference Captures

Reference captures are often the fastest way to catch "works but feels wrong"
bugs.

For each useful capture, record:

- Original command or runtime used.
- SWF path and loader parameters.
- Window size and scale.
- Date of capture.
- Input sequence or debug seed.
- The port route and commit used for comparison.

Useful capture points:

- Initial loaded state.
- First movement or input.
- First collision or grab.
- First score event.
- Water, hazard, or death event.
- Restart/remount.

Ruffle is usually good enough for visual and timing evidence. If Ruffle behavior
looks suspicious, cross-check with source or another Flash runtime before tuning
the port to Ruffle.

## Common Flash Porting Traps

- `Timer.tmod` matters. A fixed-step port with `tmod = 1` should not double-scale
  motion by applying both per-step constants and elapsed seconds.
- Main-loop order matters. Moving collision checks before or after integration can
  change gameplay even when the formulas are identical.
- Flash MovieClip registration is not Pixi anchor. Confirm pivots from extraction
  data or captures instead of centering everything.
- Depth planes are behavior. Effects, masks, water, score popups, and shadows can
  be wrong even if every asset is present.
- `hitTest` may be pixel or shape based. Circle checks are approximations unless
  the source used circle math.
- Timeline labels can be frame numbers. `gotoAndStop("1")` may mean frame 1, not
  a semantic label.
- TextFields are visual assets in practice. Font, outline, alignment, and symbol
  registration can make HUD placement look wrong.
- Input often uses edge gates, not held state. Space/click release flags and blur
  cleanup should be tested.
- `Std.random(0)`, comma expressions, null callbacks, array mutation during
  iteration, and other source-language quirks can be gameplay-relevant. Preserve
  them only after verifying the source really behaves that way.
- Pixi texture cleanup should respect shared asset caches. Destroy display trees,
  but do not destroy globally cached textures unless the game owns them.
- Headless screenshots can be blank if WebGL is unavailable. Use Chromium flags
  that enable software WebGL when doing automated smoke captures.

## Documentation Rules

- Keep `docs/FIDELITY.md` short and canonical.
- Do not add dated multi-pass audit logs here.
- Do not keep contradicted conclusions for historical context.
- Put asset provenance in `docs/porting/*-assets.md`.
- Put game-specific porting briefs in `docs/porting/<game>.md`.
- Put narrow implementation explanations near the code when they prevent a future
  accidental "cleanup" from breaking fidelity.
- If a bug fix invalidates a doc claim, update or delete the claim in the same
  change.

## Current Route

The current implementation route is TypeScript plus PixiJS.

This is a working route, not a permanent rule. Pixi maps well to extracted 2D
Flash assets, browser playback makes iteration easy, and the per-game
`mount()`/`destroy()` shape keeps ports isolated. If a game needs a different
renderer, source-to-code extraction, a SWF-assisted runtime, or a native runtime
for better fidelity, judge that per game.

## Website Shell

- Route: `/`
- Shell: `src/main.ts`, `src/style.css`
- Assets: `public/assets/site/kadokado/`
- Docs: `docs/porting/kadokado-site-assets.md`
- Status: capture-backed 2005-2006 KadoKado portal shell. The fixed-width logo,
  top bar, side navigation, sidebar boxes, game rows, record badges, help boxes,
  and orange/green action links are intentionally modeled after archived pages.
- Product rule: keep the KadoKado-era visual language, but every visible feature
  must be functional, truthful, or removed. No fake login, registration, gifts,
  ads, guestbook, forum, clans, legal pages, or platform rewards in v1.
- Known gaps: fallback thumbnails for games that do not have a recovered
  KadoKado list icon yet, and score pages depend on the local leaderboard API.

## Game Status

All registered games are playable ports using extracted assets. None should be
called 100 percent fidelity-certified until source review and reference captures
cover the important scenarios.

### Interwheel

- Route: `/#interwheel`
- Port: `src/games/interwheel/index.ts`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/Interwheel`
- Stage: 300x300
- Status: playable, asset-backed, source-audited in key mechanics.
- Current focus: wall/collision feel, wheel grab/mine timing, water pressure,
  blob timeline frames, HUD placement, and reference captures.
- Known gaps: audio/platform score hooks, complete pivot/timeline manifest, and
  deterministic reference scenarios.

### Pioupiou

- Route: `/#pioupiou`
- Port: `src/games/pioupiou/index.ts`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/pioupiou`
- Stage: 300x320
- Status: playable, asset-backed, needs a fresh source and capture audit.
- Current focus: block spawn rules, climbing/falling/crush edge cases, hero frame
  mapping, scoring, and HUD text.
- Known gaps: no current porting brief or asset provenance document in
  `docs/porting/`.

### Manda

- Route: `/#manda`
- Port: `src/games/manda/index.ts`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/manda`
- Stage: 300x320
- Docs: `docs/porting/manda.md`, `docs/porting/manda-assets.md`
- Status: playable, asset-backed, extensively source-audited, but not certified.
- Current focus: keep remaining approximations explicit and verify with captures.
- Known gaps: exact pixel-perfect self-collision, some timeline/sub-clip details,
  audio, and platform score hooks.

### Kill-Bulle

- Route: `/#killbulle`
- Port: `src/games/killbulle/index.ts`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/killbulle`
- Stage: 300x320
- Docs: `docs/porting/killbulle.md`, `docs/porting/killbulle-assets.md`
- Status: playable, asset-backed, source-audited in many mechanics, not certified.
- Current focus: grapple feel, blob spawn cadence, collision, bonuses, depth order,
  and death/restart capture checks.
- Known gaps: audio/platform hooks and any timeline details not represented by the
  extracted assets.

### Linea

- Route: `/#linea`
- Port: `src/games/linea/index.ts`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/linea`
- Stage: 300x300
- Docs: `docs/porting/linea.md`, `docs/porting/linea-assets.md`
- Status: playable, asset-backed, source-audited in many mechanics, not certified.
- Current focus: path tracing cadence, dot collision/removal order, scoring
  multipliers, render-texture effects, and capture comparisons.
- Known gaps: audio/platform hooks and visual differences from Flash filters or
  bitmap effects.

### Alphabounce

- Route: `/#alphabounce`
- Port: `src/games/alphabounce/`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/Alphabounce`
- Stage: 300x320
- Docs: `docs/porting/alphabounce.md`, `docs/porting/alphabounce-assets.md`
- Status: playable, asset-backed, not certified.
- Current focus: ball/pad collision, block/event timing, enemy waves, power-ups,
  and effect lifetimes.
- Known gaps: audio/platform hooks, capture coverage, and any asset timeline
  labels not recovered by extraction.

### K-Slash

- Route: `/#kslash`
- Port: `src/games/kslash/`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/kslash`
- Stage: 300x300
- Docs: `docs/porting/kslash.md`, `docs/porting/kslash-assets.md`
- Status: playable, asset-backed, not certified.
- Current focus: hero controls, slash/kunai hit rules, enemy states, scrolling,
  score pickups, and death flow.
- Known gaps: audio/platform hooks and full capture coverage for enemy edge cases.

### Iron Chouquette

- Route: `/#iron-chouquette`
- Port: `src/games/iron-chouquette/index.ts`
- Original: `/home/holo/prog/WebGamesArchives/KadoKado/Games/Iron Chouquette`
- Stage: 300x300
- Docs: `docs/porting/iron-chouquette.md`,
  `docs/porting/iron-chouquette-assets.md`
- Status: playable, asset-backed, not certified.
- Current focus: player movement, weapon behavior, boss patterns, bullets,
  parallax, scoring, and death/restart flow.
- Known gaps: audio/platform hooks, capture coverage, and any boss timeline
  details not recovered in assets.

## Next Useful Work

- Build a small reference-capture set for Interwheel and Pioupiou first, because
  their current docs have the least structured provenance.
- Add per-game debug fixtures or deterministic seeds where random layouts block
  comparison.
- Keep asset manifests close to the games that need them most: large atlases,
  timeline-heavy sprites, masks, and symbols with non-center registration.
- Add focused tests for pure gameplay helpers when it reduces regression risk:
  collision, scoring, spawn formulas, random weighted draws, and input edge
  gates.
- Revisit audio and original platform APIs as their own pass instead of mixing
  them into visual/gameplay fidelity work.
