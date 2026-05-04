# K-Slash Porting Brief (TypeScript + PixiJS)

## Stage and timing

**Dimensions:** 300 × 300 pixels (from swfmake.xml: width 300, height 300, matching constants `Cs.mcw` and `Cs.mch`).

**Frame rate:** **Tentative 40 FPS — not source-confirmed.** `.mt` games store FPS in the `.fla` binary, not in any text source. The 40 value is a convention guess. Verify during porting by side-by-side comparison with the original `swf/code.swf` in Ruffle.

**Timing convention:** Like Killbulle, the code uses `Timer.tmod` for frame-time multipliers. Port to a fixed-step accumulator at the verified FPS (assume `STEP_SECONDS = 1 / 40 = 0.025` until proven otherwise). Accumulate real deltaT and apply multiple fixed steps per frame, passing step count as tmod to update methods. See Killbulle translation notes for the pattern.

## Constants (Cs.mt)

All named constants from Cs.mt with values and purpose:

| Constant | Value | Purpose |
|----------|-------|---------|
| `SIZE` | 24 | Base grid unit (tile size for collision, position quantization) |
| `PLAT_ECART` | 4 | Vertical spacing between platform spawn attempts |
| `ST_NORMAL` | 0 | Hero/enemy state: walking/idle on ground |
| `ST_CLIMB` | 1 | Enemy state: climbing wall before jump |
| `ST_FLY` | 2 | Hero/enemy state: airborne/jumping |
| `ST_DEATH` | 3 | Hero state: dead, bouncing off screen |
| `ST_SHOOT` | 4 | Enemy state: launching projectiles |
| `OPT_KATANA` | 0 | Option bit 0: extended slash range (60→120 pixels) |
| `OPT_FLAMES` | 1 | Option bit 1: stars deal 8 damage instead of 5 |
| `OPT_SCROLL` | 2 | Option bit 2: scroll power-up (turns Kunai hits into invincibility frames) |
| `mcw` | 300 | Viewport width (mirrors stage width) |
| `mch` | 300 | Viewport height (mirrors stage height) |
| `C0`–`C8000` | KKApi.const(N) | Wrapped constants for scoring (10, 30, 50, 100, 120, 200, 300, 1000, 5000, 8000) |
| `XMAX` | 25 | Horizontal grid size (grid[25][25]; world is 600px wide) |
| `YMAX` | 25 | Vertical grid size (world is 600px tall) |
| `NIGHT_CODE` | [78,73,71,72,84] | Key sequence for night mode (spells "NIGHT" in ASCII) |

## Game (Game.mt)

**Constructor:** Initializes a DepthManager attached to the root MovieClip. Attaches background sprites ("bg" at depth DP_BG). Creates an internal DepthManager (`mdm`) for the game map container. Initializes empty arrays: `mList` (monsters), `sList` (enemy projectiles), `nsList` (player stars), `bList` (bonuses), `pList` (particles), `iconList` (power-up icons), `planList` (parallax layers). Creates a Hero instance. Generates a randomly placed platform grid with staggered heights. Initializes a 25×25 collision grid with block flags and monster lists per cell. Sets initial monster difficulty (`monsterLevel=0`, `monsterLevelMax=2`). Seed night mode randomly (0.2% chance).

**Main update loop (`main()`):**

1. **Entity updates:** Call update() on hero, all monsters, all enemy projectiles, and all bonuses.
2. **Scrolling:** Camera follows hero with smooth interpolation, panning all parallax layers proportionally.
3. **Particle effects:** Update physics, velocity decay, and alpha fading for all particles.
4. **Monster spawning:** Gradually increase difficulty by incrementing `monsterLevelMax` (+0.0025 per frame). When `monsterLevel < monsterLevelMax`, call `addMonster()` to spawn a random type.
5. **Difficulty scaling:** Increment global `dif` variable (+1.5 per frame). Spawn probabilities for Tanker and Flyer depend on dif thresholds.

**Scrolling:** Horizontal and vertical camera centering with bounds checks (x: ±150 from hero, y: clamped to top/bottom of world). Parallax layers scale their position by a coefficient stored in `planList` (range 0.13 to 1.0).

**Level/wave state:** No explicit "waves" or "levels" in the mission sense. Instead, continuous difficulty ramping: enemies spawn with increasing frequency and variety as `dif` grows (Runner always available; Flyer after dif>1800; Tanker after dif>4000). Monster pool count (`monsterLevel`) acts as a throttle.

**Enemy spawning:** `addMonster()` picks a type (0-4: Soldier variants, Flyer, Tanker, or Runner) based on dif. Soldiers spawn at screen edges (left if hero is right, vice versa) on random platforms. Flyers spawn at random x, top of screen. Tankers spawn at screen edges on platforms. Spawned enemies enter the `mList` array and register in the collision grid.

**Scoring:** Enemies grant points on death: Runner 0pt, Soldier 30–200pt (by level), Tanker 100pt, Flyer 30pt. Bonuses dropped by enemies give 200–8000pt depending on type. Stars and slash hits give 10–50pt each.

## Hero (Hero.mt)

**Inheritance:** Extends Ent base class (shared position/velocity/animation mechanics).

**State machine:**

- **ST_NORMAL (0):** Walking/idle on ground. Responds to LEFT/RIGHT/SPACE (shoot) input. Can jump with UP arrow.
- **ST_FLY (2):** Airborne. Continues accepting horizontal movement input (capped acceleration). Can perform double-jump (second UP press when falling). Gravity pulls down.
- **ST_DEATH (3):** Dead. Bounces off screen bottom for 1.5 seconds before KKApi.gameOver() is called.

**Movement physics:**

- **Gravity:** `weight = 0.7` (vy += 0.7 × tmod when airborne).
- **Jump impulse:** `JUMP_START = 8` (vy = -8 on jump). `JUMP_EXTEND = 3` (hold UP to apply bonus lift every frame, scaled by boost factor).
- **Run acceleration:** `SPEED = 5` (base run velocity; increases to 9 when super-mode active). On ground, vx caps at ±SPEED. In air with double-jump available, directional input applies capped acceleration (±0.25 limit per frame).
- **Friction:** `vx *= 0.8^tmod` on ground (exponential decay). In air, vx is preserved (no air friction patch).
- **Double-jump:** Single use per jump; triggered on second UP press while airborne and falling (vy > 0). Reset on landing.

**Input handling:**

- **LEFT/RIGHT arrows:** Flip facing direction (`sens`), set `flMoving=true`. Animation switches to "walk" or "run" (run if monster is adjacent). Decelerate when key released.
- **UP arrow:** Jump if on ground. While airborne with boost active, extend jump height. If double-jump ready and falling, perform second jump. Press and hold boosts jump further.
- **DOWN arrow (on ground):** Fall through platforms (set `flCheckGroundSafe=true` to skip ground detection next frame, vy *= 0.65).
- **SPACE or CTRL:** Fire star projectile (see `shoot()`) or perform close-range slash attack (see `slash()`). Cooldown 2–10 frames depending on attack type.

**Attack mechanics:**

- **Slash:** Close-range (48–120px depending on Katana upgrade). Targets closest enemy. Does 21 damage. Knockback: vx = -5 × sens.
- **Throw star:** Launches from hero toward target with velocity STAR_SPEED=14. Stars have 5 damage base (8 with Flames upgrade). Auto-aims at nearest monster using `getClosestMonsters()` sorted list. Cost: 1 star from pool. Multiple stars can be thrown in air without double-jump if limit exceeded.
- **Star pool:** Replenishes slowly (40 stars at game start, `incStar(±n)` to adjust). Display in HUD (`fieldStar`).

**Special states:**

- **Invincibility:** `flInvicible` flag set during Scroll power-up recovery (30 frame lockout after Kunai hit). During super-mode (sTimer > 0), hero is invincible and gains speed 9.
- **Hurt state:** When hit by Kunai and Scroll power-up is active, hero plays "tronc" animation, loses control for 30 frames, then teleports to center-top and falls.
- **Super mode:** Activated by super-item bonus (ID 10). Sets sTimer=500, SPEED=9. Hero gains speed trail (shade MovieClip copied every 5 frames). Ends when sTimer expires.

**Animation:** State-driven via `nextAnim` string: "wait", "walk", "run", "fly_up", "fly_down", "ball", "land", "death", "tronc", etc.

## Ent (Ent.mt) — enemy base class

**Shared fields:**

- **Position:** `x`, `y` (grid cell index, 0–24). `cx`, `cy` (sub-cell: 0 left/top, 1 right/bottom). `dx`, `dy` (pixel offsets within cell, range ±6).
- **Velocity:** `vx`, `vy` (pixels/frame).
- **Rotation:** `vr` (angular velocity, spins and decays).
- **Physics:** `weight` (gravity multiplier, default 1), `friction` (velocity damper, default 0.95).
- **State:** `step` (integer state enum), `sens` (±1 facing direction).
- **Collision:** `flGround` (on solid), `flCol` (collision enabled), `flFreezeAnim` (animation locked).
- **Animation:** `nextAnim` (string; gets applied if not frozen).

**Position system (tile-based with sub-pixel precision):** The grid is 25×25 cells. Each cell is 24 pixels. Position is calculated as: `screenX = (x + 0.25 + cx × 0.5) × SIZE + dx`, where cx ∈ {0, 1} represents left/right half. The `recal()` method maintains sub-cell consistency: when dx/dy exceed ±6, cell boundaries are crossed, grid lists updated, and callbacks triggered.

**State machine basics:**

- **ST_NORMAL (0):** Standing or walking.
- **ST_FLY (2):** Airborne.
- **ST_CLIMB (1):** About to jump up (monsters only; see Monster).
- **ST_SHOOT (4):** Preparing projectile (Soldier, Tanker only).

**Gravity & landing:** When not on ground, vy += weight × tmod. When landing (checkGround() returns true at y+1), `flGround=true`, vy reset to 0, `land()` callback fires.

**Damage handling:** Monsters have `hp` (hit points). `harm(damage)` subtracts and triggers flash effect. `cut(damage)` and `hit(projectile)` are overridden per monster type. On death, `leaveSquare()` removes from grid, `mList.remove(this)` unregisters, and optional bonus drop spawned.

**Collision grid:** During `enterSquare()`, monster adds itself to `grid[x][y].list`. During `leaveSquare()`, removes itself. Enables fast spatial queries (see checkDeath in Hero).

## Per-enemy variants

### Runner (Monster base, minimal)

**Characteristics:** Smallest and fastest ground-moving enemy. Walks on platforms, climbs obstacles.

**HP:** 10 (configured by subclass; base Monster never instantiated directly).

**Speed:** Configured per subclass (2–5 pixels/frame run speed applied when ST_NORMAL, with acceleration capped at 0.5 per frame).

**Movement:** When on ground (ST_NORMAL), applies directional acceleration: `dvx = sens × speed - vx`; limits delta to ±0.5. On jump (`tryJumpFront()`), checks distance to next platform (up to 6 cells ahead). If blocked, calls `jumpFront(dist)` with impulse `vy = -10` and horizontal boost proportional to distance.

**Climb behavior:** Randomly initiates climb when crossing platform edges. Climb probability `stTossClimb` (lower = more likely). When climbing, waits a timer duration, then applies upward velocity impulse `vy -= stClimb` (21–36 depending on subclass).

**Land:** On landing, calls `chooseWay()` to pick random or smart (if isSmart() passes) direction.

**Fall:** Transitions directly to ST_FLY (no animation state change).

**Death animation:** Plays "death" frame sequence.

**AI:** `isSmart()` returns true if `Math.random() × stTossSmart < 1` (e.g., stTossSmart=2 means 50% smart moves). Smart: approaches hero. Dumb: random walk.

### Soldier (extends Runner)

**Variants by level (1–3):** Each level unlocks stronger stats, bonus pool, projectile attacks, and visual changes.

**HP:** Level 1: 10, Level 2: 40, Level 3: 60.

**Score:** Level 1: 30pt, Level 2: 100pt, Level 3: 200pt.

**Speed:** Level 1: 2, Level 2: 3, Level 3: 5.

**Spikes:** Levels 1–2 have spikes disabled. Level 3 has spikes enabled (flSpike=true; affects hero bounce during aerial collision).

**Projectiles:** Levels 2–3 shoot Kunai (2–3 per volley). Kunai spawn at Soldier's position, aimed at hero with slight spread pattern. Cooldown `stShootWait` decreases per level (36→12). Trigger: when hero is at same y ±3 and within 180px.

**Bonus drops:** Weighted pool per level (Level 1: 100×common, 20×rare, 1×ultra; progressively adds special drops for Levels 2–3). Specials: star refills (ID 4-5), power-ups (ID 6-8), instant Flyer spawn (ID 9).

**Facing:** Smart: faces hero. Dumb: random. Corrects when jumping.

**Visual:** Frame 1–3 shows level indicator in visual child "b1". Spikes toggled in children b3–b5.

### Tanker (extends Runner)

**Characteristics:** Heavy, slow-moving tank. Difficult to hit; bounces projectiles.

**HP:** 50 (high).

**Speed:** 4.

**Score:** 100pt (despite high HP, rewards are not proportional to threat).

**Climb stats:** Climbs frequently (stTossClimb=6) and applies stronger impulse (stClimb=36).

**Projectile reflect:** When hit by Kunai while in ST_NORMAL and projectile is coming from front (shot.vx × sens < 0), reflects the star back toward shooter. Creates particle effect (bounced star displayed as partical part "mcNinjaShot"). Tanker doesn't take damage on reflected shots.

**Slash immunity:** When slashed from behind (hero to left, Tanker facing right), throws the slash away instead of taking damage. Does take damage only from front-facing slashes.

**Bonus pool:** 40×common score, 10×rare, 30×star refills, 1×instant Flyer.

**Platform edge behavior:** When on ground with platform ending ahead, dumb Tanker: 70% chance to reverse. Smart Tanker: reverses if hero is above and on same side.

**Ground state:** After thrown, returns to ground stance (gotoAndStop("walk_loop")) if still alive.

### Flyer (extends Monster)

**Characteristics:** Airborne enemy. Does not use platform grid; no collision (flCol=false). Patrolling flight with evasion AI.

**HP:** 30.

**Score:** 30pt.

**Weight:** 0 (no gravity; maintains position via velocity control).

**Movement:** No walk speed; instead maintains a target position (`trg: {x, y}`) and applies proportional velocity toward it. Acceleration cap 0.4 per frame. Recalculates target every 100–120 frames (decaying timer).

**Target selection:** Chooses position on approach vector from hero, at distance min(actual_distance, 160px) away. Direction is random or toward hero depending on context.

**Evasion:** Flips facing (sens) when hero's x-position crosses Flyer's x (avoids being pinned).

**Animation:** Play "hit" when struck by star.

**Death animation:** Plays "death" frame sequence.

**Bonus pool:** 150×star refill (ID 4), 50×special (ID 8).

### Monster (direct, base class)

**Never directly instantiated.** Used as parent for Soldier, Tanker, Flyer, Runner hierarchy. Defines shared fields: hp, score, stLevel, stClimb, stDrop (weighted bonus pool), flash (white damage indicator), waitTimer (for state transitions).

**Damage & feedback:** `harm(damage)` applies hit, triggers white flash, plays "hit" animation. On death (hp<=0), resets color, awards score, drops bonus, removes from mList and grid.

**Knockback:** `throw(angle, power)` applies velocity impulse and state transition. If knockback puts enemy airborne, initStep(ST_FLY). If on ground, inverts dy with damping.

**Climbing:** `climb()` applies upward impulse `vy -= stClimb`. `tryJumpFront()` checks ahead up to 6 cells; if blocked, calls jumpFront(distance).

**Cross-square callback:** When entity moves between grid cells, `crossSquare()` triggers. Monsters use this for climb decision logic and AI behavior (facing changes, smart vs. dumb choices).

## Kunai (Kunai.mt) and Shoot (Shoot.mt)

**Inheritance hierarchy:** Kunai extends Shoot extends (base).

### Shoot (base projectile class)

**Purpose:** Base for both hero stars (Star) and enemy kunai. Handles ballistic motion and bounds checking.

**Fields:** Position (x, y grid; dx, dy pixel offsets like entities), velocity (vx, vy), rotation (vr), flCheck flag.

**Update:** Accumulate velocity into position (dx/dy). Call `recal()` to process cell boundary crossings. Remove if out of bounds (x<0 or x>XMAX or y<0 or y>YMAX). Call `checkCol()` to detect collisions.

**Collision (`checkCol()`):** Base method does nothing; overridden in subclasses.

**Position system (cell-based like entities):** Position stored as (x, y) grid cells + pixel offsets. `recal()` handles wrap-around when offset exceeds ±12 pixels. Simplified vs. entities (no cx/cy sub-cell).

### Kunai (enemy projectile)

**Source:** Spawned by Soldier.shoot() or Tanker weapons.

**Collision:** Hits hero if distance < 14 pixels and hero is not invincible. Calls `hero.hit(this)` and kills itself.

**Kill:** Removes from `sList` (enemy shot list) and destroys MovieClip.

### Star (hero projectile)

**Source:** Spawned by Hero.throwStar() or Flyer loot.

**Damage:** 5 base, 8 if Flames upgrade (OPT_FLAMES).

**Collision:** Checks grid cell at projectile position. If any monster present, hits first monster in list, damages and throws it, kills itself.

**Kill:** Removes from `nsList` (ninja star list) and destroys MovieClip.

**Visual:** Frame 1 (normal), Frame 2 (with flames effect).

## Bonus (Bonus.mt) and Star (Star.mt)

**Bonus (collectible items):**

**Purpose:** Dropped by defeated enemies. Provides points, star refills, or power-ups.

**Lifetime:** 300 frames (~7.5 seconds). Fades alpha to zero in final 10 frames.

**Bonus IDs and effects:**

| ID | Type | Effect |
|----|------|--------|
| 1 | Common score | +200pt |
| 2 | Rare score | +1000pt |
| 3 | Ultra score | +5000pt |
| 4 | Star refill | +20 stars |
| 5 | Star refill | +50 stars |
| 6 | Katana upgrade | Enable extended slash range (120px) |
| 7 | Flames upgrade | Enable 8-damage stars |
| 8 | Scroll upgrade | Enable projectile invincibility frame |
| 9 | Instant Flyer | Spawn 18 Flyer enemies immediately, +8000pt |
| 10 | Super mode | Hero gains speed 9, invincibility, 500-frame duration |

**Spawn:** Called via `Game.spawnBonus(x, y, id)` when monster dies. Skips if ID is 0 (no drop). For IDs 6–8 (upgrades), checks if already collected; if so, converts to common score (ID 1).

**Pickup:** Hero collision (distance < 24) triggers `take()`. Applies effect, spawns particle effect (type varies: sparks for points, circles for stars, light burst for supers), increments stat counter, removes self.

### Star (specialized projectile, hero's ranged weapon)

Covered above under Kunai/Shoot section. Not a separate "bonus" — it's the hero's throwing star ammunition.

## Manager (Manager.mt)

**Purpose:** Entry point and main loop glue.

**Static fields:** `root_mc` (root MovieClip), `mode` (Game instance).

**init(mc):** Checks KKApi availability. If available, creates Game instance and stores it.

**main():** Called every frame. Updates Timer, delegates to game.main().

**Port note:** Manager maps to a glue module that wraps Pixi initialization, creates the root Container, and wires game.main() to requestAnimationFrame. See Killbulle section 112 for the pattern.

## Scrolling and level

**Side-scroll mechanic:** Camera follows hero horizontally with smooth interpolation (exponential decay toward hero.x). Clamped to viewport bounds: `tx = max(-(XMAX × SIZE × 0.5), min(SIZE × mcw × 0.5 - hero.x, SIZE × mcw × 0.5))`. This keeps the hero near center while avoiding showing out-of-bounds areas.

**World structure:** Non-tiled. Platforms are randomly generated with fixed x, y, w (width in cells). Platform sprites are positioned via DepthManager at calculated screen coordinates. Collision checks the grid; visual layout is continuous (no discrete rooms).

**Parallax layers:** Game.planList stores pairs of {mc, c} where c is a parallax coefficient (0.13 for distant background, 1.0 for map layer, intermediate values for mid-layers). Camera movement is scaled by coefficient: `info.mc._x = tx × info.c`.

**Enemy spawning zones:** Soldiers/Tankers spawn at left or right edge (x=0 or x=XMAX) on random platforms. Flyers spawn at random x, y=0 (top of screen). No explicit "level" progression; difficulty ramps continuously via dif variable.

## Input

**Keyboard:**

- **LEFT / RIGHT arrows:** Move hero left/right.
- **UP arrow:** Jump (once on ground, again in air if double-jump available).
- **DOWN arrow (on ground):** Drop through platform.
- **SPACE or CTRL:** Fire star or slash (depending on distance to nearest enemy).
- **N, I, G, H, T sequence:** Unlock night mode (if entered in quick succession).

**Input handling:** Key listeners attached via `Key.addListener()` callback in Game constructor. Processed every frame in Hero.control().

## Asset symbols expected

**MovieClip/sprite hierarchy:**

- **Root container (Game.root):** Top-level holder.
  - **"bg"** (DP_BG=1): Static background image.
  - **"map"** (DP_MAP=3): Container for all game entities (mdm attachment point).
    - **"mcPlat"** (DP_DECOR=2): Platform sprite with children:
      - **"mask"** (xscale adjusted for width).
      - **"corner"** (positioned at right edge).
    - **"mcMonster"** (DP_MONSTER=5): Soldier/Runner/Tanker sprite.
      - **"b1"** (Soldier level indicator, frames 1–3).
      - **"b3", "b4", "b5"** (Spike toggles).
    - **"mcFlyer"** (DP_MONSTER=5): Flyer sprite.
    - **"mcHero"** (DP_HERO=7): Hero sprite with sub-animation clips (wait, walk, run, fly_up, fly_down, ball, land, fall, death, tronc, hit).
      - **"bfx"** (blade effect with child "blade" for Katana visual).
      - **"kunai"** (rotation indicator during invincibility).
    - **"mcKunai"** (DP_SHOOT=10): Enemy projectile sprite.
    - **"mcNinjaShot"** (DP_SHOOT=10): Hero star projectile (frames 1–2).
    - **"bonus"** (DP_BONUS=4): Bonus item sprite (frames 1–10).
    - **"partDust"**, **"partSmoke"**, **"partQueue"**, **"partLight"**, **"partSpark"**, **"partCircle"**, **"mcScore"** (DP_PARTS=12): Particle and effect sprites.
    - **"mcShade"** (DP_SHADE=3): Speed trail shadow (super mode).
  - **"inter"** (DP_INTER=5): HUD container.
    - **"fieldStar"** (TextField: displays star count).
    - **"mcIcon"** (DP_INTER=5): Power-up icon sprite (frames 1–3 for Katana/Flames/Scroll).
  - **"bgFront"** (DP_FRONT=4): Foreground parallax layers (frames 1–N, scales with parallax coefficient).
  - **"bgBack"** (DP_BACK=2): Background parallax layers (frames 1–N).

**Sprite sheets:** Expected under asset folders (psd/, gfx/ referenced in source root, but compiled into swf/ folder for deployment).

## HUD

**Display elements:**

- **Star counter:** `Cs.game.inter.fieldStar.text` updated whenever hero's star pool changes.
- **Score:** Managed externally via KKApi.addScore(). Not displayed in game; tracked in game.stats.$opt[] arrays for submission.
- **Power-up icons:** Dynamically created/destroyed in updateIcons(). Attaches "mcIcon" sprites to the right edge of screen for each active upgrade (Katana, Flames, Scroll).
- **Floating damage numbers:** Particles with "mcScore" sprite displaying damage or point values (e.g., "+200" after picking up bonus).

## Recommended TS file split

Given the codebase structure and the pattern established in Interwheel and Killbulle:

- **src/games/kslash/index.ts** — Mount/destroy, Pixi Application setup, main ticker loop, KKApi glue.
- **src/games/kslash/game.ts** — Game state, scrolling, spawning, particle effects, depth manager, level progression.
- **src/games/kslash/hero.ts** — Hero class, movement, jumping, attacks (slash/throw), state machine, animation.
- **src/games/kslash/enemies.ts** — Ent base class, Monster, Soldier, Tanker, Flyer, Runner classes and AI.
- **src/games/kslash/projectiles.ts** — Shoot, Kunai, Star classes.
- **src/games/kslash/bonus.ts** — Bonus class, collectible logic, particle effects.
- **src/games/kslash/platform.ts** — Platform grid generation and collision.
- **src/games/kslash/constants.ts** — Cs constants, state enums, asset paths.

This split keeps game logic separate from rendering, enemy AI in one file, and utilities modular. Adjust if feature clusters suggest different boundaries.

## Translation notes

### .mt-specific patterns relevant to K-Slash

1. **Grid-based position system:** Unlike Killbulle's continuous coordinates, K-Slash uses a cell-based grid with sub-pixel offsets (cx/cy binary sub-cell, dx/dy pixel offsets). The `recal()` method handles cell boundary crossing and triggers callbacks (enterSquare, leaveSquare, crossSquare). Port as:
   - Maintain (cellX, cellY) integer pair and (offsetX, offsetY) fractional pair.
   - After velocity integration, check boundary conditions in `recal()`.
   - Call appropriate lifecycle callbacks.
   - Reference Ent base class structure for template.

2. **State-driven animation (MovieClip gotoAndStop pattern):** Heroes and enemies animate via `nextAnim` string assignments, applied by the base update loop if not frozen. Port to TypeScript enums for state (HeroState, EnemyState) and map to sprite frame numbers or animation name strings in Pixi. See Killbulle section 5.

3. **Volatile fields:** `monsterLevel`, `monsterLevelMax`, `dif`, `cheatTimer`, `woodTimer`, `qTimer`, `sTimer`, `star` marked volatile. In TypeScript, treat as regular properties; no special handling needed. See Killbulle section 1.

4. **DepthManager depth system:** Game uses explicit depth constants (DP_BG=1, DP_MONSTER=5, DP_HERO=7, DP_SHOOT=10, etc.). The attach() method reserves a depth slot and positions sprites in z-order. Port as a Container with children managed by a depth-sort utility (flat array with swap operations, or separate containers per depth tier). See Killbulle section 2.

5. **Callback pattern (closures):** Objects interact via `callback(this, methodName)` closures. Used minimally in K-Slash (mainly gravity on particles). Port to arrow functions: `() => this.methodName()`. See Killbulle section 3.

6. **Color transforms:** Flash Color class applies alpha/tint transforms. Used for white flash on enemy hit, percentage-based color blending in night mode. Port to Pixi's Sprite.tint, ColorMatrix, or equivalent. See Killbulle section 4.

7. **Timer module:** Code uses `Timer.tmod` (frame count in fixed-step frame) and `Timer.deltaT` (real time delta). Implement fixed-step accumulator: accumulate real deltaT, apply N fixed steps per frame, pass N to all update(tmod) methods. See Killbulle section 6.

8. **Weighted random selection:** Monster drop pools use weighted arrays (e.g., stDrop with w=weight, id=bonus_id). Port as helper function: `function weightedChoice(pool) { sum weights, roll random, return matching entry }`. See Monster.getDrop().

9. **Distance-based spatial queries:** Hero.checkDeath() scans a 3×3 grid of cells. Star.checkCol() scans current cell. Port via a flat grid or quadtree, depending on entity density. K-Slash's small world (25×25) can use a simple nested array.

10. **Inheritance without super() call:** Soldier extends Runner extends Monster extends Ent. Each layer adds fields and overrides specific methods. Port directly to TypeScript class hierarchy with proper override decoration and method chaining.

### Comparison to established patterns (Interwheel, Killbulle)

**Similarities:**

- Fixed-step timing with `Timer.tmod` scaling.
- Depth-managed sprite rendering (explicit constants, z-order).
- State machines (enums for hero/enemy states).
- Callback/update array pattern (particles, animations).

**Differences:**

- K-Slash uses cell-based grid collision vs. Killbulle's continuous physics. Implement cell tracking and boundary callbacks (not just absolute position).
- K-Slash has stronger AI (smart vs. dumb, targeting, evasion) vs. Killbulle's simpler blob behavior. Dedicate effort to replicating the isSmart() / chooseWay() / crossSquare() decision trees.
- K-Slash platform generation is procedural (staggered heights, random widths) vs. Killbulle's static background. Generate the grid in TypeScript, not via Pixi sprite positioning.
- Hero is more complex (jump, double-jump, slash vs. throw, state transitions) vs. Killbulle's simpler grapple. Full state machine implementation needed.
