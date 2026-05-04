# Manda Porting Brief: Angular Snake Variant (TypeScript + PixiJS)

## Stage and Timing

**Dimensions:** 300×320 pixels (playable area 294×264 with 3px border on all sides, bottom margin to 267px for HUD)

**FPS:** **Tentative 24 FPS — not source-confirmed.** The agent inferred this from `version="8"` in `swfmake.xml`, but that's the SWF format version, not the framerate (any FPS is legal in any SWF version). The real FPS lives in the `.fla` binary. Verify during porting by side-by-side comparison with the original `swf/code.swf` running in Ruffle. 24 is plausible; 30 or 40 are equally possible.

**Port implementation:** Use a fixed-step accumulator with `STEP_SECONDS = 1/24 ≈ 0.041667`. The original uses `Timer.tmod` (relative time delta) and `Timer.deltaT` (absolute delta in seconds) for all motion calculations. Port by maintaining this timing discipline: accumulate frame time and run discrete physics steps, interpolating visual state.

## Constants (Const.mt)

### Graphics/Rendering
- `WIDTH = 300`, `HEIGHT = 300`
- `COLOR_SNAKE_DEFAULT = 0x009900` (normal snake: green)
- `COLOR_SNAKE_BORDER_DEFAULT = 0x006C00` (dark green border)
- `COLOR_SNAKE_INVINCIBLE = 0x89A6B5` (blue potion: light gray-blue)
- `COLOR_SNAKE_BORDER_INVINCIBLE = 0x61869A` (blue potion border)
- **Depth planes** (z-order layers):
  - `PLAN_FRUITS_SHADE = 1` (fruit shadows)
  - `PLAN_SNAKE = 2` (snake graphics)
  - `PLAN_FRUITS = 3` (fruits and bonuses)
  - `PLAN_PARTICULES = 4` (explosion particles)
  - `PLAN_POPSCORE = 5` (floating score popups)
  - `PLAN_JACKPOT = 1` (jackpot slots HUD, same as shadows but managed separately)

### Physics
- `SNAKE_DEFAULT_SPEED = 2.3` (pixels/frame)
- `SNAKE_MIN_SPEED = 1.15` (half default)
- `SNAKE_FAST_SPEED_COEF = 3` (boost multiplier when holding UP)
- `SNAKE_DEFAULT_TURN = 0.125` (radians/frame, ~7.2° per frame baseline)
- `SNAKE_DEFAULT_LENGTH = 3` (initial segment count)
- `SNAKE_QUEUE_ELT_SIZE = 4` (sampling interval in queue; body chain stored every 4 position samples)
- `SNAKE_SPEED_INCREMENT = 0.001` (per-frame acceleration baseline)
- `FRICTION = 0.97` (exponential drag when not boosting: `speed *= 0.97^tmod`)

### Gameplay
- **Bonus spawn probabilities** (weighted random selection):
  - 0: CISEAUX (scissors) – 100
  - 1: COFFRE (chest) – 40
  - 2: POTION BLEUE (blue potion/invincibility) – 30
  - 3: CANNE (fishing rod/giant fruit) – 8
  - 4: MOLECULE (score token) – 80
  - 5: PLUME (feather/speed down) – 20
  - 6: CLOCHE (bell/tail-following auto-pickup) – 2
  - 7: JACKPOT (slot machine trigger) – 500

- `BONUS_FREQ = 250` (spawn denominator; adjusted by score/10000)
- `BONUS_MAX = 7` (concurrent bonuses allowed)
- `FRUITS_FREQ = 350` (fruit spawn denominator)
- `FRUITS_MAX = 200` (max fruit ID for difficulty scaling)
- `FBARRE_MAX = 150` (fruit bar resource cap; replenishes on eating, decays on timeout)
- `FBARRE_FRUIT_BASE = 20` (spawn cost)
- `FBARRE_FRUIT_TIMEOUT = -1.5` (penalty per expired fruit)
- `FBARRE_FRUIT_EAT = 2` (gain per eaten fruit)

### Score Multipliers (KKApi constants)
- C5, C10, C20, C30, C50, C100, C200, C700, C1900, C3000, C4000, C6000
- Used as fractional multipliers via `KKApi.cmult()` and `KKApi.const()` for server-side scoring

### Bounds
- `LEVEL_BOUNDS = { left: 3, top: 3, right: 297, bottom: 267 }`
- Playable region with 3px margin; bottom at 267 leaves HUD space

## Game (Game.mt)

**Constructor flow:**
1. Attach background MovieClip (`"bg"`)
2. Create two DepthManagers:
   - `dmanager` (game world, depth 1): holds all in-play entities (snake, fruits, bonuses, particles)
   - `interf` (interface, depth 2): holds HUD elements (jackpot display, score)
3. Attach a mask MovieClip (`"bgMask"`) at depth 3, positioned (5, 5), to constrain rendering to play area
4. Initialize Level, Jackpot, and Snake; position snake head at origin with angle π/4
5. Initialize counters: `fcounter` (frame counter), `fbarre` (fruit resource), `nfruits` (score tracking)

**Update flow (main):**
- Increment frame counter
- If game-over: run game-over sequence (snake explodes segment-by-segment); save final score (fruit count, jackpot 2-match/3-match totals)
- Else: run game loop:
  - **Input → Snake rotation:** LEFT/RIGHT arrow keys modulate `snake.ang` by `delta_ang`, scaled by `sqrt(speed/default_speed)` and `tmod` for frame-rate independence
  - **Throttle/boost:** UP key forces `base_speed = 3×`; release causes `base_speed *= 0.97^tmod` (friction) until > 1.0
  - **Speed progression:** `speed += 0.001 * tmod` (baseline creep)
  - **Collision/move:** Call `snake.move(bounds)`, which returns true if self-hit or boundary breach → triggers game-over
  - **Fcloche callback:** If bell bonus active, auto-eat tail segments
  - **Level.main():** Spawn fruits/bonuses, check collisions, invoke `eatFruit()` on hit
  - **Jackpot.main():** Advance slot animation if active
  - **Snake.draw():** Render snake chain
- **Anti-cheat:** Flag if fruit count diverges (would indicate client manipulation)

**Fields:**
- `bg`: background sprite
- `dmanager`, `interf`: depth managers (map to Pixi Containers)
- `snake`: primary player entity
- `level`: fruit/bonus manager
- `jackpot`: slot-machine state
- `game_over_flag`: termination signal
- `fcounter`: frame count
- `fbarre`: resource bar (float 0–150)
- `nfruits`: total eaten (for final score)
- `fcloche`: optional callback for bell bonus tail-following

## Snake (Snake.mt)

**Motion Model:** Continuous angular rotation, not grid-based. The snake has a heading angle (`ang` in radians) that can be rotated smoothly via turn input. The head moves in the direction of this angle at `speed` pixels/frame.

**Body Representation:** `queue` is an Array of `{x, y}` positions. Samples are added once per `SNAKE_QUEUE_ELT_SIZE` (4) distance units traveled (stored in `dist` accumulator). The body is logically indexed by segment: segment `i` reads from `queue[queue.length - i*4]`. Growth adds segments by prepending dummy samples; self-collision tests by ray-casting 1.5–3× the queue size ahead.

**Head Graphics:** `tete` MovieClip (the sprite "tete" from assets) represents the head, scaled and rotated based on snake size and angle. Scales to `(30+70*size_factor)%` where `size_factor = min(10, len+3)/20`. Rotation set to `ang * 180/π` degrees.

**Body Chain Rendering:**
- Two parallel curves drawn via `drawQueue()`: shadow (offset at y+4, olive color 0xB7EF7C) and main body (green or invincible gray)
- Uses `lineStyle(width, color)` and `curveTo()` (or `lineTo()` if frame-skip > 1.7) to interpolate between sampled queue points
- Line width scaled per segment: `(len-i)*scale + linesize` where `scale ∝ len^-1`
- "Eat" animation: segments fade in/out as `max(1, 2-(len-eat)²/2)` factor when `eat > 0`

**Growth:** On fruit pickup, `addQueue()` prepends 10 dummy position samples, increments `len`, sets `eat` to trigger fade-in animation.

**Self-Collision Detection:**
- During move, check ray-cast ahead from head position: `col_pt = head + direction × distance`
- Test via `gfx.hitTest(col_pt.x, col_pt.y, true)` (pixel-perfect against rendered body)
- Incremental step: divide velocity into chunks of `esize` and check intermediate points to avoid tunneling
- Blue (invincibility) mode disables this test

**Reverse Bonus:** If hit by ciseaux bonus, call `reverse()` to flip the queue and recompute direction from tail orientation.

**Input Mapping:**
- LEFT arrow: `ang -= delta_ang * sqrt(speed/default_speed) * tmod`
- RIGHT arrow: `ang += delta_ang * sqrt(speed/default_speed) * tmod`
- Turning rate scales with speed to maintain control feel across difficulty levels

**Fields:**
- Rendering: `gfx`, `shade`, `tete`, `collide_mc`
- Physics: `x`, `y`, `ang`, `speed`, `base_speed`, `len`
- State: `queue` (position history), `eat` (fade counter), `blue`, `blue_flag` (invincibility)

## Movable (Movable.mt)

**Base class for animated entities:** Fruit, Bonus, and Item inherit from this. Encapsulates position (2D + z-depth for parallax shadow), scale, and animation state.

**Fields:**
- `mc`: the visual MovieClip
- `x, y, z`: position (z for vertical bounce/fall, shadow follows at `(x+z/4, y+z/3)`)
- `scale`: base scale factor
- `moving`: boolean; if true, lerp to destination
- `shade`: shadow MovieClip (created on-demand via subclass callback)

**Animation Methods:**
- `setPos(px, py)`: snap to position, clear motion
- `jumpNear(ray, zmax, speed, bounds)`: initiate arc toward random point within radius, respecting bounds; z-path via quadratic (peak `zmax`), duration `1/speed` frames
- `fall(speed)`: drop straight down with shadow; z-path via quadratic
- `move()`: advance parametric time `t`, interpolate position and z via stored coefficients (`coef_a`, `coef_b`)

**Lifecycle:** Subclasses override `createShade()` to define shadow appearance and `inBounds()` to validate spawn/land positions.

## Fruit (Fruit.mt) and Item (Item.mt)

**Item (base class):** Manages lifetime and collision for pickups. On instantiation, randomizes position via `rndPos()` (up to 200 retries to find valid spawn in bounds). Decrements `time` each frame; when <= 0, plays "disparait" animation and returns false to signal deletion.

**Fruit (subclass):** Spawned by `Level.generateFruit()` at random fruit ID from 0–200 based on `fbarre` (difficulty scaling). Each ID has a point value:
- IDs 0–24: `(id+1) * C5`
- IDs 25–59: `C200 + (id-25) * C10`
- IDs 60–99: `C700 + (id-60) * C20`
- IDs 100–144: `C1900 + (id-100) * C30`
- IDs 145–169: `C4000 + (id-145) * C50`
- IDs 170+: `C6000 + (id-170) * C100`

**Bonus:** Triggered on pickup to `activate(game)` with special effects (see Bonus section).

**Spawn Rules:** Fruits spawn every 350 frames (adjusted for existing count); max ~200 in-play. Bonus every ~250 frames (adjusted by score/10000 and bonus count); max 7 concurrent. Bonuses with ID=7 (jackpot) suppressed if encyclopedia < 5 fruits.

**Lifetime:** Fruits have base lifetime 6–8 seconds; bonus 7–10 seconds. Collision with snake head triggers `Game.eatFruit()` (increments score, fbarre, nfruits; adds to jackpot encyclopedia; triggers snake growth if `add_queue=true`).

**Difference:** Fruit always grows snake (`add_queue=true`). Item is the abstract parent; subclass Bonus explicitly sets `add_queue=false` and runs side effects on activate.

## Level (Level.mt)

**Difficulty Progression:** No explicit level cap; instead, progression is **continuous**.

- **Speed:** Baseline `SNAKE_DEFAULT_SPEED = 2.3` increments by 0.001/frame; no hard resets per level
- **Spawn rate:** `FRUITS_FREQ = 350` frame baseline; frequency ratio decreases as fruit count climbs (harder to spawn when 100+ exist)
- **Fruit ID range:** Scaled by `fbarre` (resource bar). Low bar = low ID fruits (easier, cheaper). High bar = high ID fruits (rarer, higher points)
  - `base = int(fbarre / 3)`, `ampl = round(fbarre * (MAX - base + 1) / MAX)`, then `id = base + random(ampl)`
- **Snake length:** No hard per-level cap; grows unbounded on fruit pickup
- **Bonus frequency:** Adjusts via `(BONUS_FREQ + score/10000) * (bonuses+1)` to prevent inflation at high scores

**Resource Management:** `fbarre` (0–150) acts as a gating mechanism. Eating fruit → +2, timeout → -1.5, MOLECULE bonus → +10. Depletion slows fruit spawning (minimum IDs shrink, fewer spawn attempts trigger).

## Jackpot (Jackpot.mt)

**Encyclopedia:** Each eaten fruit ID (except ID=75, the cloche bell) is appended to `encyclo` (up to 10 recent IDs). Jackpot can only spawn if encyclopedia length ≥ 5.

**Activation:** Triggered by JACKPOT bonus (ID=7). Sets `nturns = 100` to start slot-machine animation.

**Slot Animation:** Three slots display random fruit IDs from encyclopedia. Each slot animates over 100 frames:
- Slot 0 shows fruits for frames 100–31
- Slot 1 shows fruits for frames 100–61
- Slot 2 shows fruits for frames 100–91
- All settle at frame 0

**Payout:**
- 3-match (all three slots same ID): `jackpot(id, big=true)` → points = `basePoints(id) * C20`, increment `count3`
- 2-match (any two slots match): `jackpot(id, big=false)` → points = `basePoints(id) * C5`, increment `count2`
- No match: no score

**Coin System:** If coins > 0, auto-restart with `nturns = 100` and decrement coins (allows multiple spins from single JACKPOT bonus trigger).

**Coins:** Incremented on subsequent jackpot activations if nturns already active; essentially bundling multi-triggers.

## Bonus (Bonus.mt) and PopScore (PopScore.mt)

**Bonus Types (on activate):**

0. **CISEAUX (scissors):** Explode one snake segment; increment count for next pickup (up to 1, 2, 3, ... segments per activation)
1. **COFFRE (chest):** Generate 5–10 fruits around bonus location, make them jump inward, don't add to snake length
2. **POTION BLEUE (invincibility):** Set `snake.blue = true` for 15 seconds; toggle `blue_flag` off/on briefly for visual flashing when < 2 seconds remain; tracked via static counter to allow stacking
3. **CANNE (fishing rod):** Generate giant fruit at center (2× scale), 10× point value, add to length
4. **MOLECULE (score token):** Instant 3000 points, +10 fbarre
5. **PLUME (feather/slow):** Reduce snake speed by 1.0 (enforced min: SNAKE_MIN_SPEED)
6. **CLOCHE (bell):** Spawn copies of fruit ID=75 at tail position every frame; explode one segment per frame; continues until snake empty
7. **JACKPOT:** Trigger slot machine

**PopScore:** Floating text popup displaying score. Animates on-screen with separate X/Y elastic ease-out:
- Scales from 0% to `max_size` (25–70 based on points, clamped)
- Scales independently on X and Y axes
- Speed = 4 units/frame each axis
- Reverses on reaching 1.0, then eases back to 0.3 before vanishing
- Clamps position to screen bounds (screen-center pop-ups anchor away from edges)

**Manager.updates:** Both PopScore and particle effects register update callbacks in this global array; removed when animation complete.

## Manager (Manager.mt)

**Purpose:** Singleton entry point and update dispatcher.

**Static fields:**
- `root_mc`: reference to stage
- `updates`: Array of frame callbacks (closures for animations, particle effects, etc.)
- `mode`: current game mode object (holds `.main()` and `.destroy()` methods)

**Initialization:** `Manager.init(stage)` creates the Game instance and stores in `mode`.

**Main loop (Manager.main):**
1. Update timer (call `Timer.update()` to refresh `tmod` and `deltaT`)
2. Call `mode.main()` (Game.gameMain or Game.gameOverMain)
3. Invoke all callbacks in `updates` array (PopScore, particles, etc.)

**In Pixi port:** This maps to a game loop frame dispatcher. `Manager.root_mc` becomes the Pixi stage; `dmanager` and `interf` become Pixi Containers. Callbacks in `updates` should be managed in an event system or be polled each frame.

## Input

**Keyboard control:**
- **LEFT arrow:** Rotate snake counter-clockwise (decrease angle)
- **RIGHT arrow:** Rotate snake clockwise (increase angle)
- **UP arrow:** Boost speed to 3× for duration of key press

No mouse input; purely keyboard-driven.

## Asset Symbols Expected

The original uses `Std.attachMC()` and `downcast()` to load sprites from the embedded SWF library. The porting agent must provide these MovieClips under `public/assets/manda/`:

### Sprites (graphics)
- **`bg`:** Static background (300×320 checkerboard or solid)
- **`bgMask`:** Mask shape for play area (roughly 294×264 rect)
- **`tete`:** Snake head (animated; frames "1" = normal, "2" = invincible; frame events o1, o2 for sound triggers)
- **`fruit`:** Fruit picker with sub-clip `f` containing 201 frames (IDs 0–200 as gotoAndStop targets)
- **`bonus`:** Bonus picker with sub-clip `f` containing 8 frames (IDs 0–7)
- **`jackpot`:** Slot machine frame (contains sub-clip `f` with 201 fruit frames)
- **`qparticule`:** Explosion particle (small sprite)
- **`scoreDigit`:** Digit atlas (10 frames, gotoAndStop(1–10) for digits 0–9)

### Color Swapping
Sprites are programmatically recolored (e.g., snake invincible mode). Ensure base assets are monochromatic or pre-colored for recoloring to work cleanly.

## HUD

**Jackpot Display:** Three slots at (110, 270), (140, 270), (170, 270) showing current fruit ID; animates over 100 frames when active.

**Score:** Managed server-side via `KKApi.addScore()`. UI rendered via the API wrapper (not in-game).

**Fruit Bar:** Displayed client-side by the game, likely as a progress bar (fbarre / FBARRE_MAX). Currently stored as a float; rendering implementation TBD.

**Level Indicator:** No explicit level counter in-game; progression is continuous (speed, difficulty).

## Translation Notes

### Angular Snake Mechanic
The original computes `dx = cos(ang), dy = sin(ang)` and moves the head by `(dx, dy) * speed` each frame. Angle is absolute (stored in radians), not relative to grid directions. This is significantly different from classic 4-directional Snake. On porting:
- Maintain the continuous angle model (avoid snapping to cardinal directions)
- Scale turn rate by `sqrt(speed / default_speed)` to preserve input feel across difficulty levels
- Use `atan2(dy, dx)` when reversing or inferring angle from body

### Body Chain Representation
The queue stores position samples every 4 pixels (esize=4). Rendering samples from `queue[n - i*4]` where `i` is segment index. This sparse sampling is efficient for large bodies but requires careful indexing. On porting to Pixi:
- Store queue as-is (Array of point objects)
- Use `Graphics.lineStyle()` and `curveTo()` to draw smooth curves, or implement via Bezier segments
- Shadow offset is `(x + z/4, y + z/3)` with `z` as depth (parallax effect)

### Frame-Rate Independence
The code extensively uses `Timer.tmod` (delta time in frame units, nominally 1.0 at 24 FPS). Motion is scaled by `tmod`:
- `speed *= 0.97^tmod` (friction)
- `eat -= eat_speed * tmod / 2` (fade)
- `time -= Timer.deltaT` (absolute seconds for cooldowns)

Port by maintaining a fixed timestep accumulator and always passing the same `tmod` (e.g., 1.0 for 1/24 steps). This ensures deterministic, frame-rate-independent physics.

### Collision Model
Self-collision uses pixel-perfect `hitTest()` against the rendered body graphics. This is **not** a circle/polygon-based hit system; it tests against the actual drawn pixels. On porting:
- Render body to a Pixi Graphics or Canvas
- Implement a point-in-graphics test (or use a simplified bounding-box + segment approach)
- Alternatively, maintain a separate collision geometry (e.g., circles along the body chain) for faster Pixi hitTest

### Depth Management
The original uses a DepthManager to reorder MovieClips (Pixi will use Container hierarchy). Ensure depth planes are respected:
- Shadows layer below fruits
- Snake layer above shadows, below items
- Items above snake
- Particles above items
- PopScore above particles (always visible)
- HUD (Jackpot) separate, overlaid

## Files to Create

- `src/Game.ts`: Main game state and loop orchestration
- `src/Snake.ts`: Head + body chain, collision, rendering
- `src/Fruit.ts`, `src/Bonus.ts`, `src/Item.ts`: Pickup entities
- `src/Movable.ts`: Base animation class (arc/fall motion)
- `src/Level.ts`: Fruit/bonus spawner and collision logic
- `src/Jackpot.ts`: Slot machine state
- `src/PopScore.ts`: Floating score popup
- `src/Const.ts`: Constants (unchanged from MT)
- `src/Manager.ts`: Entry point and main loop
- `public/assets/manda/`: Sprite library (bg, fruit, bonus, jackpot, tete, etc.)
- `src/index.ts`: PixiJS app setup, stage initialization

---

**Estimated complexity:** Medium-high. The angular snake and body chain rendering are non-trivial; self-collision detection requires careful implementation. All other systems (bonuses, level spawning, jackpot) are straightforward state machines.
