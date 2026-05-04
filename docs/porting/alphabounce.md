# Alphabounce Porting Brief (Haxe → TypeScript + PixiJS)

## Stage and Timing

**Dimensions:** 300×300 pixels (playfield); display window 300×320 (confirmed from index.html).

**FPS:** 40. Verified from the SWF headers for both `swf/game.swf` and `swf/gfx.swf` (`Frame rate: 40.0`). The earlier `@90D*` interpretation from `project.hxml` was stale/incorrect for the archived binaries. For TypeScript with PixiJS, use 40 FPS nominal timing and preserve `mt.Timer.tmod` semantics (delta-time scaling via a global time-modifier that responds to pad.flStop, the time-freeze mechanic).

---

## Constants (Cs.hx)

All are statics in the Cs class. Most are simple, but note the palette-based visual system and grid math:

| Constant | Value | Gloss |
|----------|-------|-------|
| `BW` | 28 | Block width (grid cell) in pixels |
| `BH` | 12 | Block height (grid cell) in pixels |
| `DIR` | `[[1,0],[0,1],[-1,0],[0,-1]]` | 4-cardinal direction vectors (R, D, L, U) for map generation |
| `XMAX` | computed | Grid cols = `(300 - 10) / 28` = 10 |
| `YMAX` | computed | Grid rows = `(300 - 30) / 12` = 22 (confirmed via init() calculation) |
| `SIDE` | computed | Left/right margin = `(300 - XMAX*28) / 2` = 10 |
| `mcw` | 300 | Canvas width for grid space (playfield) |
| `mch` | 300 | Canvas height for grid space |
| `SCORE_BONUS` | `[250, 1000, 5000]` | Bonus block scores (3 tiers) |
| `SCORE_BLOCK` | 50 | Base score per normal block destroyed |
| `SCORE_BOUNCE` | 5 | Score on bounce (hit without kill) |
| `SCORE_ICE` | 120 | Score when block frozen then shattered |
| `SCORE_0` | 0 | Zero score (used as placeholder) |
| `MAX_BALL` | 32 | Max simultaneous balls |
| `MAX_OPTION` | 6 | Max simultaneous power-ups on screen |
| `BALL_*` | 0–7 | Ball types: STANDARD, FIRE, ICE, DRUNK, KAMIKAZE, YOYO, HALO, SHADE |
| `PAD_*` | 0–6 | Pad types: STANDARD, GLUE, TIME, LASER, PROTECTION, AIMANT, SHAKE |
| `TEMPO` | 100 | Frame interval for ball speed acceleration |
| `DOOR_COEF` | 0.25 | Fraction of blocks destroyed to open exit door (25%) |
| `OPTION_COEF` | 0.2 | Probability factor for power-up drop on block death (20%) |
| `PQ` | 0.3 | Plasma downsampling quality (30% of full res) |
| `SKIN` | 2 skin objects | Color palette: `{back:0x..., br/bg/bb:..., rr/rg/rb:...}` (background and RGB range variance for procedural palette gen) |
| `getPerfCoef()` | function | Returns `max(0, 1 - sprites.length/120)` for FX LOD scaling |
| `getX(px)` | function | Maps grid col to pixel: `SIDE + px*BW` |
| `getY(py)` | function | Maps grid row to pixel: `py*BH` |
| `getPX(x)` | function | Reverse: pixel to grid col |
| `getPY(y)` | function | Reverse: pixel to grid row |

See linea.md for general Haxe translation notes (mt.flash.Volatile, _x/_y → x/y, etc.).

---

## Game (Game.hx)

Main scene manager (~900 LOC). Drives the 4-state machine: **Scroll** → **Intro** → **Play** → **GameOver**.

**Constructor:**
Initializes DepthManager and root, attaches background (looping mc), creates ball & option arrays, spawns sides (mirrored boundary visuals), and inits plasma FX layer. Calls `initScroll(1)` to begin level intro animation.

**Render layer indices (DepthManager):**
- `DP_BG` = 0 – Static background
- `DP_PLASMA` = 2 – Additive glow/lighting from particles
- `DP_UNDERPARTS` = 3 – Under-grid particles (sparks beneath blocks)
- `DP_BLOCK` = 4 – Block grid and blink flash
- `DP_PAD` = 5 – Paddle and protection shield
- `DP_OPTION` = 6 – Falling power-ups
- `DP_BALL` = 7 – Ball sprites
- `DP_PARTS` = 8 – Particle effects (explosions, etc.)
- `DP_INTER` = 10 – UI overlays (level title, score popups)

**Volatile state:** `lvl`, `block`, `blockTotal`, `levelTimer`, `autoLaunchTimer` (from KKApi integration); also `timeCoef` (for slow-motion on pad.flStop).

**Update flow (`update()`):**
1. If `pad.flStop` is true, ramp down `timeCoef` (to 0.1 min) and apply to `mt.Timer.tmod`.
2. Switch on `step` and call appropriate handler (scroll / intro / play / gameover).
3. Update plasma blur/fade, update floating title text.
4. Clear `flClick` (mouse action flag) for next frame.
5. Check `balls.cheat` flag to report cheating.

**Scroll phase (`initScroll`, `updateScroll`):**
Pans the entire scene right-to-left over ~60 frames (`scroll += 0.05*tmod`). Pad slides right slowly. When scroll reaches 1.0, calls `initIntro()`.

**Intro phase (`initIntro`, `updateIntro`):**
Animates level title ("NIVEAU X") from top off-screen to y=10. Spawns 64 light particles radiating outward. When sides[0] frame reaches 1 and title is at y=10, calls `initPlay()`.

**Play phase (`updatePlay`):**
Core loop. Increments `levelTimer` (no cap, used for safe-mode checks) and `autoLaunchTimer` (resets at 200, clears gluePoints to auto-launch). Ball acceleration: if `lvl >= 5`, mult = `(lvl-3)*0.5` applied to accTimer; when accTimer > TEMPO (100), all balls gain 0.5 speed and counter resets. Calls `updateSprites()` (all Sprite list items) and updates all `events[]`. When `flDoor` is true (25% blocks destroyed), checks `checkEnd()` to see if paddle has exited right edge and trigger next level.

**Block grid generation (`genModel`, `fillGrid`):**
Uses procedural bitmap-based layout. For each level, stamps random shapes onto a BitmapData, creates a mask, fills cells, then adds horizontal lines (difficulty-based), "digs" tunnels (random walk), borders (higher levels only), and malus (level > 5). Mirrors grid horizontally if random. Generates 1–3 bonus block clusters per level at high rarity. Result: `model[x][y]` is block type or null.

Block types:
- 0–4: Normal blocks (life = type)
- 5–12: Bonus blocks (types 10, 11, 12 correspond to tier 0, 1, 2 with scores 250/1000/5000)
- 13: Glass block (shatters, spawns new ball)

**Options (power-ups):**
Triggered by `getOption(id)` when a power-up is picked. Options 0–25 map to letters A–Z, each with unique effect (pad type, ball type, ball count, etc.). Some spawn events (Javelot, Quasar, Unification, Wave). Option.PROB array sets drop probability per type.

**End-of-level (`leaveLevel`):**
Increments `lvl`, captures screenshot of current playfield to mcScreenshot, resets sides and pad position, calls `initScroll(0)` for next level.

**Game-over (`initGameOver`):**
Calls `KKApi.gameOver({})` and sets step to GameOver (final state, no further updates).

**Plasma system:**
`mcPlasma` is a downsampled BitmapData (0.3× quality). Applied a blur filter, color transform per frame to fade. Ball and FX classes call `Game.me.plasmaDraw()` to render their MovieClips into the plasma layer with blendMode="add" for glow effect.

---

## Pad (Pad.hx)

Paddle: 36-pixel radius by default, extends/shrinks via power-ups.

**Input:**
- Arrow keys LEFT/RIGHT move the paddle (SPEED = 10 px/frame, scaled by moveFactor ±1 and mt.Timer.tmod).
- Mouse movement detected via `flMouse` flag; overrides keyboard.
- In PLAY_AUTO mode, paddle auto-tracks lowest ball.

**Collision with ball:**
Ball calls `colPad(cx)` where `cx` is normalized hit position (−1 to +1). Bounce angle calculated as `a = -1.57 + cx*ANGLE_MAX` (where ANGLE_MAX = 1.2 rad ≈ 69°). Ball velocity set to `(cos(a)*speed, sin(a)*speed)`.

**Pad types and mechanics:**
- **STANDARD:** No special behavior.
- **GLUE:** Ball sticks to paddle; released by click or 200-frame auto-launch timeout.
- **TIME:** Click to freeze time (slows `mt.Timer.tmod` globally via `pad.flStop`); power bar drains while active.
- **LASER:** Click to fire 2 lasers upward from paddle sides; cost 0.2 power per shot.
- **PROTECTION:** Creates shield dome above paddle; collisions bounce balls.
- **AIMANT:** Attracts balls toward paddle; emits attract-line FX.
- **SHAKE:** Wiggle paddle left/right (±14 px per frame).

**Power bar:**
Recovery rate depends on type (0.007 to 0.01 per frame). Recharges when not in use. Displayed as scaled MovieClip width.

**Collision response:** No direct collision checking in Pad; Ball class invokes Pad's colPad/colProtect methods.

---

## Ball (Ball.hx)

Ball: extends Element (which provides grid-based physics with collision). Stores type, speed, damage (varies by type), and special state.

**Motion:**
Inherits Element's update: moves in grid space (px, py cells + ox, oy sub-cell offsets) with velocity (vx, vy). On block boundary, calls `onBounce()`, which triggers block damage and sets `flBounce` flag. Ball bounces off walls; angle adjustment protects against thin-wall passes.

**Paddle collision (from Pad):**
If ball approaches paddle from above (vy > 0) and is within pad ray horizontally, calls `colPad(cx)`. If cx > 1 (off-side), checks `pad.flProtect` for shield bounce or counts ball as lost (`flUp = false`).

**Life loss:**
When ball goes below canvas (y > mch+10) and `flUp == false`, triggers game-over unless in safe mode and level timer < 600: rescues ball by bouncing at bottom and showing "SAUVETAGE !" message.

**Ball types and FX:**
- **STANDARD:** No special behavior; draws plasma glow.
- **FIRE:** Rotates to match velocity angle; emits fire sparks (frame 1).
- **ICE:** Emits ice shards with gravity; draws on plasma.
- **DRUNK:** Angular velocity wobble (va, ca fields); emits bubbles.
- **KAMIKAZE:** Homes on random block target; angular acceleration toward block.
- **YOYO:** Speed multiplies by height factor `4*(1-(y/(mch+15)))`.
- **HALO:** Spawns 5 trailing shade balls (BALL_SHADE type) on paddle hit, with delayed wake.
- **SHADE:** Invisible semi-transparent ball; kills self on block hit; shade ball from HALO.

**Clone method:**
Multi-ball option clones active ball, splits velocity angle by ±0.15 rad.

**Speed control:**
`setSpeed(n)` updates speed; if Kamikaze and n > 30, downgrades to STANDARD (fix for infinite loop).

---

## Block (Block.hx)

Static grid elements; stored in `Game.me.grid[x][y]`.

**Lifecycle:**
Created in `fillGrid()` based on `model[x][y]`. Inherits life from type (0–5 = normal, 10–12 = bonus). On `damage(ball)`, decrements life; if life <= 0, calls `explode()`.

**Damage mechanics:**
- If block is frozen (flIce), explosion ignores remaining life.
- If ball is ICE type, freezes block instead (appends ice overlay MovieClip).
- Otherwise, deduct ball.damage from block.life.

**Explosion:**
Spawns 2–24 particle parts (fx.Part with Bouncer physics, grid-aware bouncing). If block is normal type < 5, adds score and option drop (2% chance). If bonus type, spawns colored twinkle particles. Special case: type 13 (glass) spawns a new ball and glass shards.

**Scoring:**
Block death awards `KKApi.addScore(score)` where score varies by type. Bounce (hit without death) awards SCORE_BOUNCE (5).

---

## Bouncer (Bouncer.hx) and Element (Element.hx)

**Element** is a base class for physical bodies with grid-based collision. Stores position as (px, py) grid cells and (ox, oy) sub-cell offsets within [0, BW) and [0, BH). Uses a stepping algorithm to find grid collision: for each frame, advances (ox, oy) by velocity, checks which boundary is crossed first, bounces velocity by flipping sign (scaled by frict = 1 for balls). Calls `onBounce(px, py)` when hitting a non-free cell.

**Bouncer** is a standalone helper (not inherited by Element) that wraps a Phys sprite for similar grid-aware physics. Used by fx.Part (explosion pieces) to bounce off grid. Same stepping algorithm but independent of Element.

Both support wall bounces and grid-cell boundary detection. Friction (flict = 1) preserves velocity magnitude on bounce.

---

## Event Scheduler (Event.hx + ev/*)

**Abstract Event base:**
Simple observer added to `Game.me.events[]`. Subclasses override `update()` to implement time-based or condition-triggered behavior. Call `kill()` to self-remove.

**Event subclasses:**

### Wave
Horizontal wave that descends top-to-bottom, damaging all blocks in its path. Moves 2 cells per frame; renders as mcWave MovieClip (animation). Kills self when y < -2.

### Javelot (Javelin)
Vertical column descends from above paddle position, destroying all blocks in that column (static x, y decrements by SPEED=5/frame). Emits light particles trailing the beam. Kills at y < -14.

### Quasar
Area-of-effect explosion: spawns at screen center, pulls all blocks within RAY=100 pixels toward center over 60 frames. Blocks shrink visually and change to bonus type 10 (first-tier). Emits twinkle particles. On kill, displays total score gained (summed from all consumed blocks).

### Unification
Converts all blocks to bonus type 10 (greenish) via an expanding circle wave from upper-left. Expands at 0.2 cells/frame. Emits twinkle FX. Terminates when no blocks remain in list.

**Triggering:**
Events are spawned by `getOption()` calls, e.g., option 9 (Javelot letter) → `new ev.Javelot()`. No timer or score condition; purely player-input-driven via power-up consumption.

---

## Shot (Shot.hx) and shot/Laser.hx

**Shot** base class extends Element, inherits grid physics. On block collision, calls `onBounce()` → `hit()` → `kill()`.

**Laser:**
Emitted by PAD_LASER from paddle sides (2 per shot, at x ± (ray-9)). Travels upward (vy = -vit, vit = 18). Rendering: expands yscale from 0 to height (44) on ascent, then shrinks back to 0 on descent and kills. Uses plasma draw. Hits single block and vanishes.

---

## FX Particle System (fx/*)

**Part:**
Phys sprite with Bouncer (grid-aware physics). Used for block explosions. Inherits acceleration, friction, timer. Bounces off grid cells like balls do.

**LineUp:**
Rising particle with scale-based direction indicator. `factor` multiplier controls how much velocity scales into screen-space scale (100*factor*vx → xscale). Used for power-up pickups and pad power-ups.

**Spark:**
Velocity-scaled directional line. Rotates and scales by speed; used for protection bounces.

**Attract:**
Homing particle (Aimant pad FX). Moves toward pad.x+dx, fades when within 5 pixels. Emits scaled directional line.

Fade mechanics: all Phys particles have `timer` and `fadeType` (0 = fade to alpha, 1 = unused). Particles self-remove when timer <= 0.

---

## Option (Option.hx)

**Power-up pickup class** (extends Phys). Falls downward at FALL_SPEED=3. On collision with paddle, calls `apply()` to:
1. Trigger FX (LineUp particles + mcOnde wave animation).
2. Call `Game.me.getOption(id)` to apply the effect.
3. Self-remove.

**Type assignment:**
- `setType(null)` picks random type from PROB array (weighted by probability).
- `isBad()` filters certain hazardous options on level 0 (e.g., DIMINUTION, INVERSION).

**Rendering:**
Displays letter (A–Z) in scrolling text field. Color derived from rainbow per id.

---

## Input

**Keyboard:**
- LEFT/RIGHT arrows: move paddle.
- SPACE: click/action (activate pad power or launch glued ball).

**Mouse:**
- Movement: reported via `onMouseMove()` flag; overrides keyboard if pad is in mouse-control mode.
- Click: `onMouseDown()` / `onMouseUp()` trigger pad action/release.

No gamepad input.

---

## Asset Symbols Expected

Every sprite/MovieClip referenced from code:

**Pad & Ball:**
- `mcPad` – Paddle root (contains sub-clips: side0, side1, mid with smc child for rendering).
- `mcBall` – Ball sprite (8 frames for ball types 0–7).
- `mcProtection` – Shield dome.
- `mcLaser` – Laser sprite (sub-clip smc for scaling).

**Blocks & Bonuses:**
- `mcBlock` – Grid block (frame 1 for normal, frames 2–4 for bonus types).
- `partExplode` – Explosion parent container.
- `mcBlink` – Flash on block hit.
- `mcOption` – Power-up base (contains scroll sub-clip with text field).

**Sides & Doors:**
- `mcSide` – Door/boundary (2 instances, frames 1–max for animation).
- `mcBg` – Level background (frames 1 onwards for level themes).

**Events & FX:**
- `mcWave` – Wave event visualization.
- `mcJavelot` – Javelin event beam.
- `mcQuasar` – Quasar core (center point).
- `partLight` – Light particle.
- `partSpark` – Spark burst.
- `partGlue` – Glue ball stickiness FX.
- `partIceShard` – Ice block shatter piece.
- `partBubble` – Drunk ball bubble.
- `partTwinkle` – Bonus/unification wave particle.
- `partLineUp` – Rising power-up FX.
- `partGlass` – Glass block shards.
- `partScore` – Floating score text (contains field TextField).
- `mcPart` – Generic particle (frame-based).
- `mcOnde` – Wave aura on option pickup.
- `mcTitle` – Level title overlay (contains mcField sub-clip with field TextField).
- `mcTitleLevel` – Intro "NIVEAU X" text.
- `mcIce` – Frozen block overlay.

**VFX & UI:**
- `mcBrush` – Procedural generation brush shape.
- `mcShape` – Procedural generation shape mask.
- `mcScore` – Score popup (contains field).
- `mcGreenBar`, `mcPinkBar` – Aimant & Shake pad FX queues.
- `partLine` – Generic line particle.
- `partOnde` – Wave effect.

**Raster assets:**
- `bmp/side.png` – Pre-rendered side boundary image (referenced as resource, already raster format).

---

## HUD & End-of-Run

**Score display:**
Real-time score managed by KKApi (server-side). Floating score popups spawn on block death and at level end (mcScore MovieClips with TextField, physics fade).

**Lives display:**
Not implemented (breakout genre variant uses 1-life-per-level semantics; losing all balls triggers game-over).

**Level display:**
Shown at intro (mcTitleLevel "NIVEAU X" animation).

**Multiplier:**
Not explicitly shown on-screen; used internally for scoring but no HUD bar.

**Game-over flow:**
When balls array becomes empty, `destroy()` calls `Game.me.initGameOver()`, which:
1. Calls `KKApi.gameOver({})` to report final state.
2. Halts all updates (step = GameOver).
3. No UI shown; relies on KKApi to display result externally.

---

## Recommended TS File Split

```
src/games/alphabounce/
├── index.ts              (mount/destroy + ticker integration)
├── game.ts               (Game class: state machine, grid, events)
├── ball.ts               (Ball class + physics)
├── pad.ts                (Pad class + input)
├── block.ts              (Block class + destruction)
├── element.ts            (Base Element physics)
├── bouncer.ts            (Bouncer grid physics helper)
├── events.ts             (Event base + Wave, Javelot, Quasar, Unification)
├── shot.ts               (Shot base + Laser subclass)
├── option.ts             (Power-up class)
├── fx.ts                 (Part, LineUp, Spark, Attract)
├── cs.ts                 (Constants & grid math helpers)
└── input.ts              (Keyboard/mouse listener setup)
```

This split mirrors the source structure and keeps concerns separated: events/shot/fx can be in single files due to size, but if Quasar becomes large (particle management), split to `events/quasar.ts` etc.

---

## Notes for Porting

1. **Time scaling via mt.Timer.tmod:**
   The engine uses a global time modifier for slow-motion. When `pad.flStop` is true (TIME pad active), `timeCoef` ramps down and scales `mt.Timer.tmod`. All motion (velocity, animation, particle physics) must respect `mt.Timer.tmod` multipliers. In TS+Pixi, implement as: every frame advance, compute delta = (elapsed_ms / 1000) * 40 (for 40 FPS nominal), then apply `delta *= mt.Timer.tmod` before all physics updates.

2. **Grid-based collision stepping:**
   Element and Bouncer use sub-frame stepping (parc loop). Movement is broken into segments such that only one grid boundary is crossed per segment. This ensures balls don't tunnel through thin walls. Port this stepping logic exactly; it is critical for ball physics correctness.

3. **Plasma layer:**
   BitmapData blur + fade per frame creates a persistent glow backdrop. In Pixi, implement as a Sprite with a lower-res BitmapData (0.3× scale), apply filter per frame, and composite via container depth. Particle classes call `plasmaDraw()` to render their MovieClips into this BitmapData.

4. **Procedural level generation:**
   Uses BitmapData.draw() with random stamps, color transformations, and pixel manipulation. Ports directly to Canvas 2D or WebGL equivalent. The genModel/genPalette functions are computationally expensive; consider memoizing or offloading to Web Worker for levels > 10.

5. **Shared state across events:**
   Events stored in `Game.me.events[]` and updated sequentially. Each event can spawn visual FX (particles, text) that may outlive the event itself. On game reset/level end, all events are killed (not just cleared) to ensure MovieClip cleanup.

6. **Ball cloning & multi-ball:**
   Multi-ball option clones active ball and diverges angle. Ensure clone preserves all state (speed, type, position, velocity) but generates new MovieClip instance.

7. **Power-up option IDs:**
   26 unique options (A–Z). Distribution is weighted by PROB array. Some options (J, Q, U, V) spawn events; others (F, G, H, M, K) change ball type; others (B, D, E, L, P, R, S, T) modify pad. None are "bad" past level 0 (isBad filter).

8. **Slow-motion vs. real physics:**
   `flStop` (TIME pad) slows time globally. Ensure all frame-rate-dependent calculations (distance traveled, FX timing) scale by `tmod`. Particle timers, ball acceleration accumulator (accTimer), and level timer all scale.

9. **MovieClip frame arithmetic:**
   Code uses `gotoAndStop(index+1)` and checks `_totalframes`. Translate to Pixi animation systems (AnimatedSprite or manual frame index). Frame counts for block life (gotoAndStop(life+1)) and ball types (8 frames) must align with sprite sheet.

10. **Volatile state:**
    KKApi.const() and KKApi.aconst() wrap server-side tuning. In TypeScript, these become static or injected config values. No runtime reload implemented; just parameterize constants at initialization.
