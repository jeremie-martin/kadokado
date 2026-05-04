# Killbulle Porting Brief (TypeScript + PixiJS)

## Stage and timing

**Dimensions:** 300 × 320 pixels (from index.html embed; note Const.WIDTH = 450 in-game, a discrepancy inherited from the original Flash build).

**Frame rate:** **Tentative 40 FPS — not source-confirmed.** The `.mt` games store FPS in the `.fla` binary, not in any text source the agent could read. The 40 FPS value is a convention guess based on other KadoKado titles. Verify during porting by side-by-side comparison with the original `swf/code.swf` running in Ruffle.

**Timing convention:** The code uses `Timer.deltaT` (delta time in seconds) and `Timer.tmod` (a scaling factor, likely for variable timestep). Port to fixed-step accumulator: `STEP_SECONDS = 1 / 40 = 0.025`. See Interwheel's pattern: accumulate deltaT, apply multiple fixed steps per frame until exhausted, pass the step count as `tmod` to update methods.

## Constants

All named constants from Const.mt:

| Constant | Value | Purpose |
|----------|-------|---------|
| `PLAN_CORDE` | 2 | Depth/layer for grapple rope visual |
| `PLAN_GRAPIN` | 4 | Depth/layer for grapple hook |
| `PLAN_BONUS` | 4 | Depth/layer for bonus pickups |
| `PLAN_HERO` | 3 | Depth/layer for the player character |
| `PLAN_BLOB` | 4 | Depth/layer for enemy blobs (overlaps bonus) |
| `WIDTH` | 450 | Horizontal play area width |
| `MINY` | 290 | Ground/baseline Y position for blobs and hero |
| `BLOB_PROBAS` | 3000 | Spawn rate denominator: lower values = more frequent spawning |
| `C20` | KKApi.const(20) | Constant reference (score multiplier for blob hits) |
| `C5000` | KKApi.const(5000) | Constant reference (bonus points) |
| `BONUS_START_LEVEL` | 10 | Minimum game level before bonuses spawn inside blobs |
| `BONUS_PROBAS` | [500, 100, 10, 30, 50] | Weighted array: none, time-stop, super-grapin, shuriken, points |

The last three entries are API-wrapped; assume these resolve to 20 and 5000 respectively when porting.

## Game lifecycle (Game.mt)

**Constructor:** Initializes a `DepthManager` (see Manager section below) attached to the root MovieClip. Attaches background sprites ("bg" at depth 0, "bg2" at depth 2). Creates the Hero. Initializes empty blob array, stats object (shots $s, score $ts, bonuses $b), level counter, and a persistent `updates` array for callback-driven objects (falling bonuses, rope fadeout).

**Main update loop (`main()`):**

1. **Blob spawning:** Decrement `blob_timer`. Stochastically generate new blobs based on current blob total size (`tsize`) and level, weighted by `BLOB_PROBAS`. Each blob has a random size (50 × random level-dependent coefficient) or size 50 if carrying a bonus.
2. **Flash effect:** Decrement `flash_timer`, apply color transform to root until zero (used for bonus activation feedback).
3. **Hero update:** Call `hero.update()`.
4. **Camera follow:** Smooth interpolation of `camera_x` toward hero's x-position using exponential decay (0.9 factor). Pan root and parallax background accordingly.
5. **Blob updates:** Only if `blob_timer <= 0` (safe frame), iterate all blobs, call `update()` on each, remove dead ones, decrement `tsize`.
6. **Callback queue:** Drain the `updates` array, removing falsy returns. This is where rope fadeout and bonus gravity run.

**Depth structure (maps to Pixi Container hierarchy):**
- Layer 0: background ("bg")
- Layer 2: back parallax ("bg2")
- Layer 3: hero
- Layer 4: blobs, grapple, ropes, bonuses (all share this depth; ordering handled by swap operations)

## Hero (Hero.mt)

**Fields:** Position (x, y), velocity (dx, dy), frame counter, facing direction (dir: -1 or 1), acceleration (acc), movement state (moving bool), lock state (for grapple or special effects), super-grapin cooldown timer, death state and death timer.

**States and frame-based animation:**

- **Frame 1:** Idle, standing still. Animates a sub-MovieClip.
- **Frame 2:** Moving (walking). Sub-animation loops; frame counter wraps to maintain continuity.
- **Frame 3+:** Post-grapple lockout. Sub-animation plays once; when done (frame >= sub._totalframes), unlock and return to idle.
- **Frame 4:** Grappling; locked; no input accepted.
- **Frame 6:** Special activation (shuriken bonus).
- **Frame 7:** Death; plays sub-animation; after 1.5 seconds calls KKApi.gameOver().

**Update sequence:**

1. Decrement `super_grapin_time` cooldown.
2. Increment frame counter by `Timer.tmod`.
3. Handle grapple: if `grapin` object exists, call its update; if it returns false, clear it. Else if Space is pressed and hero is alive and not locked, create new Grapin and attempt its first update.
4. If dead: play death animation; return after timer expires.
5. If not locked: read LEFT/RIGHT input, apply acceleration (capped at ±5), decay velocity when keys release. Clamp x-position to [30, WIDTH-20].
6. Update animation frame: gotoAndStop transitions based on moving state and frame count within sub-animations.
7. Apply a sine-wave vertical bobbing (amplitude ~3 pixels, period based on x-position).
8. Position on screen and check blob collision (via `hit()` method if safe frame).

**Collision (`hit()`):** Scan all blobs; if hero center is within blob radius (adjusted by hero hitbox), trigger death: set death timer to 1.5 s, shrink blob to size 50, play death animation, spawn explosion sprite, attach bonus's MC to hero (a trick to keep bonus reference).

## Blob (Blob.mt)

**Spawn:** Created with a size and optional Bonus payload. Position set relative to hero (±50 offset). Initial velocity is semi-random (dx=2.5, dy=1) with random direction; speed scales with level (5 + level/20).

**State:** Maintains position (x, y), velocity (dx, dy), size, direction. Visual is a single MovieClip with color transform applied (purple base, or orange if carrying bonus).

**Update:** Apply gravity (dy += 0.9 × tmod), accumulate position, bounce off ground (y > MINY restores to MINY - size/2, inverts dy with stronger bounce -20 - sqrt(size)). Wrap around left/right walls via mirror reflection. Update bonus visual position if present.

**Collision/death (`hit()`):** Remove from world, spawn explosion sprite, increment level. If size >= 25 and no bonus, split into two child blobs of half size ±offset. Else if carrying bonus, trigger bonus fall animation.

## Grapin (Grapin.mt) — the grapple

**Trigger:** Player presses Space; creates a Grapin at hero's x-position, starting at BASEY (MINY - 30 = 260). Initial speed is 8 pixels/frame upward. If `super_grapin_time > 0`, flag superg=true (no retraction).

**Aiming & launch:** No explicit aiming UI. The hook rises straight up; ropes are drawn down from the base (BASEY) to the hook's current y, segmented every 25 pixels. Visual: a "corde" (rope) MovieClip per segment.

**Collision detection (`hits()`):** Iterate blobs; if hook center is within blob bounds (±blob.size/2 horizontally, y <= blob.y vertically), register a hit. Calculate score: size/2 × 20 points. Increment shot counter. If hook is below blob (rot=true), trigger bounce: reverse speed randomly, swap depth to front. If superg is active, keep going (don't return); else stop (return true).

**Rope destruction:** On hit or escape (y < -100), trigger `destroyCordes()` callback (added to Game.updates queue). Ropes fade alpha over time; hook continues moving until all ropes gone. Rotation and drift are applied during fadeout.

**Retraction:** No explicit retraction mechanic; hook simply stops when it exits bounds (y < -100) or hits a blob (single blob per cast unless superg).

## Bonus (Bonus.mt)

**Types (bonus IDs 0-3):**

- **ID 0 (time-stop):** Flash green. Set `blob_timer = 5` (pause blob updates for 5 seconds).
- **ID 1 (super-grapin):** Flash red. Set `hero.super_grapin_time = 20` (next grapple pierces all blobs).
- **ID 2 (shuriken):** Flash blue. Duplicate all blobs array and call `hit()` on each (instant clear). Lock hero into special frame.
- **ID 3 (points):** Flash white. Add 5000 points; increment bonus counter.

**Spawn:** Created inside Blob if level >= 10 and random roll passes BONUS_PROBAS. Bonus object attaches a small MovieClip (50% scale) and moves with its parent blob.

**Pickup mechanics (`fall()`):** When blob dies, bonus detaches and falls independently (gravity += 0.9 tmod, bounces at ground with -0.5 damping). Hero collision (distance < 30) activates bonus, plays flash effect, removes MC.

## Manager (Manager.mt)

Static class; acts as the game's initialization and main loop entry point. `init()` creates a Game instance and stores it in `mode`. `main()` calls Timer.update() and delegates to `mode.main()`.

For the port, Manager maps to a glue module that:
1. Instantiates the Pixi Application.
2. Creates the root Container (equivalent to root_mc).
3. Wires the Game class to Pixi.
4. Calls game.main() on each requestAnimationFrame.

The "DepthManager" referenced throughout is a custom depth-sorting utility; see Asset symbols section.

## Input & UX

**Controls:**
- **LEFT / RIGHT arrow keys:** Move hero.
- **SPACE:** Launch grapple.

**HUD:** Score (managed by KKApi.addScore()), lives/shots (stored in game.stats.$s), bonus count (game.stats.$b). Presumably displayed by external KKApi UI layer.

**Death & restart:** Hero death triggers 1.5 second countdown, then calls KKApi.gameOver() with final stats. Restart is handled by KKApi layer.

## Asset symbols expected

The following MovieClip/sprite names are attached dynamically via DepthManager (equivalent to Pixi Container with _name tracking). Port must provide sprite frames:

- **"bg"** — static background (320×290 viewport area)
- **"bg2"** — parallax layer (deeper background)
- **"hero"** — player character MovieClip with sub-clips:
  - Sub-MovieClip "sub" containing idle (frame 1), walk cycle (frames 2+), etc.
- **"blob"** — enemy ball/blob, with a child MovieClip "col" for color transforms
- **"corde"** — rope segment graphic (scales vertically)
- **"grapin"** — grapple hook sprite (has frames "1" for normal, "2" for super-grapin)
- **"bonus"** — bonus icon MovieClip (gotoAndStop by ID: frames 1-4 for time, super, shuriken, points)
- **"animExplose"** — explosion animation (has a "col" child for color)

All sprites should live under `/public/assets/killbulle/`.

## Translation notes

### .mt idiom patterns

1. **volatile fields:** `tsize`, `level`, `blob_timer`, `super_grapin_time` marked volatile. In the original, volatile hints the Haxe compiler to generate bytecode for atomic access. In TypeScript, treat as regular class properties; no special handling needed.

2. **DepthManager depth system:** The manager attaches sprites and manually manages z-order via "swap" operations (see Grapin.hits: `game.dmanager.swap(mc,1)`). Port this as a Container with children array manipulation or Pixi's built-in depthSort. Interwheel uses a flat Container list; consider the same approach.

3. **Callback pattern:** Objects queue themselves into `Game.updates` array via `game.addUpdate(callback(this,methodName))`. The .mt `callback(obj, method)` is a function closure; in TypeScript, use arrow functions: `() => this.destroyCordes()`. Game.main() drains this array, removing entries that return false.

4. **Color transforms:** Flash's `Color` class wraps MovieClip color manipulation. Port to Pixi's Sprite.tint or ColorMatrix filters. Motion-Twin wraps these as `new Color(mc).setTransform({ra, rb, ga, gb, ba, bb, aa, ab})` — map ra/ga/ba to alpha multipliers and rb/gb/bb to RGB offsets.

5. **MovieClip state machine:** Hero and animations rely on `gotoAndStop(frameString)` and _currentframe inspection. In Pixi, maintain explicit state enums (e.g., HeroState.Idle, Walking, Grappling) and manage frame indices accordingly. See Interwheel's BlobState enum.

6. **Timer module:** The code references Timer.deltaT (frame delta in seconds) and Timer.tmod (accumulated step count or scaling factor). Implement a fixed-step accumulator (as per Interwheel STEP_SECONDS pattern) and pass tmod to all update methods.

### Comparison to Interwheel

Interwheel (reference: /home/holo/prog/motiontwin/src/games/interwheel/index.ts) follows the established port pattern:

- Constants defined at module top.
- Fixed-step timing with `STEP_SECONDS = 1 / FPS`.
- Type definitions for game entities (Wheel, Pastille, etc.) matching .mt class fields.
- Pixi Container-based depth management (flat children array, no explicit depth manager).
- State enums (BlobState) instead of MovieClip frame strings.
- Callback pattern converted to arrow functions in arrays.

Killbulle differs in complexity: it has a custom DepthManager, more intricate collision, and the grapple mechanic. Implement DepthManager as a simple Container wrapper with z-index tracking if swaps are frequent; otherwise linearize into explicit layer containers (bg, mid, hero, blobs, ui).
