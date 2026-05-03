# Iron Chouquette Porting Brief (TypeScript + PixiJS)

**Source:** 4074 lines of Motion-Twin .mt code across 14 files. A vertical bullet-hell boss-rush platformer with continuous parallax decor scroll, six distinct weapon types, multi-phase boss AI, and dynamic enemy spawning tied to a difficulty curve.

## Stage and timing

**Dimensions:** 300 × 300 pixels (constants `Cs.mcw` and `Cs.mch`).

**Frame rate:** **40 FPS — source-confirmed from SWF headers** (`code.swf`, `root.swf`, `gfx.swf`, `decor.swf`, and `monster.swf` all report 40 FPS). Use `STEP_SECONDS = 1 / 40 = 0.025`.

## Level data format (editor/)

**Two files only:** `editor.fla` (Adobe Flash source) and `starShoot.html` (test harness).

**No runtime level data files.** Level data is **hardcoded in source code:** Stykades.PATH (42 pre-defined paths as nested integer arrays: `[x, y]` tuples with optional event marker). Stykades.PROB (34 difficulty-gated monster spawn rules, each `[monsterTypeId, difficultyThreshold]`). Wave spawning is driven by difficulty timer, not external files.

**Implication for porting:** Copy PATHS and PROB arrays directly into a TypeScript constants file. No JSON/XML parsing needed. The porting agent must implement a `Wave` class that accepts a PATH index and instantiates enemies along that path, with dynamic speed/offset scheduling.

## Pre-rasterized assets (bmp/)

Ten PNG/JPG files, all final art (no runtime scaling or decomposition expected):

- `bg.jpg` (133 KB) — parallax background, tiled vertically as the scroll advances.
- `omega_body.png`, `omega_turn.png` — enemy sprite sheets for Omega (type 1).
- `blackron.png`, `furia.png` — enemy sprite sheets.
- `steack.png` (8.3 KB) — large sprite sheet covering multiple enemy types and effects.
- `orbs.png`, `unorbs.png` — projectile/bonus visuals.
- `space_rabbit.png` — hero or decoration.
- `psx_pad.png` — control prompt or HUD element.

**Assignment by asset:**
- **Hero:** space_rabbit.png (primary character sprite).
- **Enemies:** omega_body/turn (Omega), blackron (Blackron), furia (Furia), steack (aggregated: Gromph, Block, etc.), orbs (bonus orb effects).
- **Background:** bg.jpg tiled with parallax offset.
- **Decor:** Referenced from external SWF libraries (gfx.swf, monster.swf, decor.swf), not bitmap files.

**Copy strategy:** Place all bmp/ PNGs into `public/assets/iron-chouquette/` and load them into a Pixi TextureCache. Each sprite class references its texture by name.

## Constants (Cs.mt)

| Constant | Value | Purpose |
|----------|-------|---------|
| `mcw` | 300 | Play area width |
| `mch` | 300 | Play area height |
| `CDIF` | 0.7 | Difficulty increase rate per frame (added to Stykades.dif each tick) |
| `SCORE_ASTEROID` | [50, 75, 150, 200, 300] | Array (unused stub) |
| `C5`, `C0`, `C500` | KKApi.const(5/0/500) | Score multipliers (API-wrapped) |
| `C_OMEGA` through `C_STORM` | KKApi.const(...) | Per-enemy-type score values; range 65–8000 |
| `game` | Game singleton | Backref to active game instance |

**Helper functions:**
- `mm(a, b, c)` — clamp a to [b, c].
- `sMod(v, mod)` — modulo with negative wrap.
- `hMod(v, mod)` — half-modulo (wrap ±mod).
- `colToObj32(col)` — split 32-bit color to {a, r, g, b}.
- `getDist(o1, o2)`, `getAng(o1, o2)` — Euclidean distance and atan2 angle.
- `setPercentColor(mc, prc, col)` — flash/damage color overlay.

## Game (Game.mt)

**Top-level orchestrator:** Manages stages, level progression, parallax decor, wave spawning, boss state, and difficulty curve.

**Initialization (`new Game(root)`):**
1. Attach root MovieClip to DepthManager.
2. Create static layer objects: `bg` (background), `baseList` (decor planets/bases), plasma bitmap layers.
3. Initialize empty arrays: `sList` (sprite updates), `shotList`, `badsList`, `bonusList`, `pList` (particles).
4. Create Hero (step 1 after kidnappers intro).
5. Setup shot and plasma caches (BitmapData for rendering effects).

**State machine (`initStep(n)`):**
- **Step 0:** Intro sequence. "Chouquette" enemy descends on-screen orbited by 3 "Kidnappers" in circular motion. Uses sinusoidal interpolation with angle wrap (`knTurnDecal`).
- **Step 1:** Kidnappers fade off-screen, Hero enters. Boss (Stykades) activation imminent.
- **Step 2:** Play — free enemy waves until game over.

**Main update loop (`main()`):**
1. **Bullet time:** If `bt` (bullet-time state) active, lerp `bt.val` toward target; apply color-matrix filter to background.
2. **Flash effect:** Decrement `flashouille` timer, apply white color transform.
3. **Plasma rendering:** Two layers (layer 0 additive, layer 1 normal blend), blur + decay. Drawn from Shot layer 0; used for laser visual and plasma trail feedback.
4. **Sprite updates:** Call `update()` on all sList entries (replicates at start).
5. **Phase logic:**
   - Step 0: Chouquette rises until y < mch × 0.5; Kidnappers orbit.
   - Step 1: Hero slides up off-screen, timer countdown, then advance step.
   - Step 2: Call `Stykades.update()` (boss state machine).
6. **Scroll management:** Increment `SCROLL_SPEED`, cap at `SCROLL_SPEED_MAX` (6). Wrap decor layers and baseList objects.
7. **Graphics mode degradation:** If lag detected (`Timer.tmod > 2`), reduce quality (lower pq scale, disable plasma layers, reduce enemy cap).

**Parallax decor:** Background (`bg`) and `baseList` (planets/bases) scroll vertically. Speed is `SCROLL_SPEED` (constant 0.0001 base, incremented each frame post-step-1). No horizontal parallax. Decor wraps at canvas height; off-screen sprites are removed.

**Depth structure:**
| Depth | Purpose |
|-------|---------|
| 2 | BG + baseList decor |
| 3 | Under-parts (wave effects, particles) |
| 5 | Draw layer (laser lines) |
| 7 | Enemies (Bads) |
| 8 | Shots layer (3 sub-layers for batching) |
| 9 | Hero |
| 10 | Particles (Part) |
| 12 | Interface/HUD (Inter) |

**Rendering:** Plasma layers (fast-path BitmapData drawing) replace traditional MovieClip rendering for performance. New shots are drawn directly to BitmapData with color transform + blur each frame.

## Phys (Phys.mt) — physics base

**Parent class for Hero, Bads, Shots, Parts.** Extends Sprite.

**Fields:**
- Position: `x`, `y` (world coordinates).
- Velocity: `vx`, `vy`, `vr` (angular).
- Physics: `weight` (gravity magnitude), `frict` (friction coefficient, applies as exponential decay).
- Collision: `ray` (circular hitbox radius).
- Rendering: `plasmaId` (index into plasma layer for additive draw), `flash` (damage flash timer).

**Update sequence:**
1. **Gravity:** `vy += weight × tmod` (if weight defined).
2. **Friction:** `vx` and `vy` decay via `vx *= frict^tmod` (exponential). `vr` similarly decayed if set.
3. **Position:** `x += vx × tmod`, `y += vy × tmod`, `root._rotation += vr × tmod`.
4. **Plasma draw:** If `plasmaId` defined, draw MovieClip to plasma layer.

**Methods:**
- `collide(sp)` — circle-circle collision test: `distance(x, y, sp.x, sp.y) < ray + sp.ray`.
- `fxOnde(sc)`, `fxExplode(sc)` — spawn attached visual effects (wave ripple, miniature explosion).
- `throwDebris(gid, coef)` — spawn particle shards for death animation; iterate frames of "partDebris" MovieClip, scatter velocity.

## Hero (Hero.mt)

**Player-controlled spaceship.** Extends Phys. State machine, 6 weapon types, 3 active slots, + special abilities (invincibility, laser, black hole).

**Weapon types:**
| ID | Name | Behavior |
|----|----|----------|
| 0 | Plasma | Straight shots, piercing, heavy damage, scales with ammo count |
| 1 | Sider | Side-spread pattern, angled velocity, lower per-shot damage |
| 2 | Laser | Homing beam with curvature toward target; draws line-strip visual |
| 3 | Speed | Temporarily activates a large glowing aura (speedup effect) |
| 4 | Void | Converts enemies into black-hole particles, absorbs all shots |
| 5 | Missile | Homing rockets with acceleration, 12-shot bursts |

**Mechanics:**
- **Weapon slots:** Array of up to 3 active weapons (boxes drawn as UI). Press CTRL/SHIFT to sacrifice the last slot, triggering its effect (e.g., Plasma sacrifice spawns a large piercing shot).
- **Weapon ammo:** Each weapon has a reload counter `a[1]` (ticks down each frame; incremented after a volley).
- **Invincibility frames:** WP_LASER grants 300-frame invincibility at 2× radius (`INVINCIBLE_RAY = 32`); pulses white color, emits particles.
- **Laser targeting:** Lazy-search for nearest enemy, tracks via `laserTrg` struct. Draws beziér-like curve with line artifacts for visual noise.

**Input (`control()`):**
- **LEFT/RIGHT:** Move ±speed (up to 10), apply roll animation, adjust laser aim angle.
- **UP/DOWN:** Move vertically.
- **SPACE/ALT/ENTER:** Fire. Each weapon type generates a different shot pattern; reload times and damage scale with ammo count.
- **CTRL/SHIFT:** Sacrifice last weapon slot.

**Special abilities (activated via sacrifice):**
- **WP_PLASMA (0):** Large piercing shot (50 ray), 50 damage.
- **WP_SIDER (1):** "Sonic Boom" – expands wave hitting all enemies once (5 damage each).
- **WP_VOID (4):** "Black Hole" – converts all active enemies/shots to particles, draws them in with radial acceleration, scales 10→150 over 4 phases.
- **WP_SPEED (3):** "Big Laser" – glowing aura, 80-frame timer, damages enemies in line-of-sight.
- **WP_LASER (2):** Invincibility mode (see above).
- **WP_MISSILE (5):** 12 missiles, 60-frame timer, homing.
- **null (all slots empty):** Bullet-time slow-mo (0.3× speed, 100-frame duration, color desaturates).

**Constraints:**
- Hero locked in control until `Stykades.dif > 56` (boss escape threshold).
- Hero has 3 boxes max; adding a weapon when full sacrifices box 0.
- Anti-cheat: Compares `weapons[]` against `cweapons[]` checksum and `slots` vs `cslots`.
- Bounds clamp: x in [ray, mcw−ray], y in [ray, mch−ray].

## Bads (Bads.mt) — enemies

**Base class for all adversaries.** Extends Phys. AI state machine (`bList` array of behavior IDs), weapon/attack system (Rafale), scoring.

**Behavior modes (bList entries):**
| ID | Name | Logic |
|----|------|-------|
| 0 | PATH | Follows predefined Wave path, distance-based progression |
| 1 | WANDERING | Random angular walk; `va` (angular velocity) jitters ±0.06 per tick |
| 2 | ONDULE | Sinusoidal horizontal wave at constant altitude |
| 3 | FOLLOW_TARGET | Seeks `trg` (target struct {x, y}), rotation toward target |
| 4 | SHOOTER | Stochastic shot timer, triggers Rafale |
| 5 | ONDULEUR_HORIZONTAL | Locks altitude, oscillates x, pauses before leaving |
| 6 | BEE | Seeks random waypoint in `beeRange` array; acceleration-based steering |
| 7 | FLAMER | Cone-fire attack (±0.3 rad, speed 5–8 px/f) toward hero, 8-frame bursts |
| 8 | SEEKER | Rises until `seekerLimit`, then switches to FOLLOW_TARGET |
| 9 | STAGNE | Vertical pause, waits at altitude, then shoots at hero |
| 10 | SHIELD | Pushes all hero shots away (repulsion shield) |

**Fields:**
- **Render:** `skin` frame; optional `follow` (turret sub-MC rotating toward hero), `turn` (spinning sub-MC), `fire` (muzzle flash MC).
- **Physics:** `speed` (constant velocity magnitude), `va` (angular acceleration limit), `turnCoef` (turn sharpness), `a` (current angle).
- **Health:** `hp` (float, damage accumulates), `dif` (local difficulty multiplier for scaling).
- **Weapons:** `weapons` array of Rafale objects (burst-fire patterns); `rafale` pointer to active burst.
- **Scoring:** `score` and `score2` (KKConst wrappers for variable rewards).
- **Wave reference:** `wave`, `waveIndex`, `pathIndex` (for PATH mode).
- **Special:** `bounceId` (for family-bounce collision), `partList` (attached sub-parts follow parent).

**Update:**
1. **Behavior loop:** Iterate `bList` and apply state-specific logic (path interpolation, rotation, acceleration).
2. **Shooting:** Decrement `shootTimer`; if elapsed and in SHOOTER mode, pick random Rafale, call `init()`.
3. **Part attachment:** Update sub-parts (e.g., turrets) to follow parent position.
4. **Flash decay:** Damage color overlay.
5. **Collision checks:**
   - Hero collision: if `hero.invincibleTimer == null`, trigger `hero.explode()` and deal 10 damage to self.
   - Laser collision: per-pixel plasma test; enemies in red plasma take damage (0.07–0.3 × tmod).
   - Hero shot collision: per-Rafale weapon type.
6. **Out-of-bounds:** Auto-kill if outside play area with 10-frame grace.

**Death:**
- `die()` → animate, spawn explosion particles, drop bonus (stochastic), award score (if `score != null` and value > limit, display as floating text).
- Stats tracking: Aggregate kill count by score value in `Cs.game.stats.$k`.

**Enemy types (instantiators in Stykades):**
- **Omega:** Fast, bouncy, minimal AI (Stykades.PATH wave-based).
- **Blackron:** Path-following variant.
- **Furia:** Aggressive, high speed.
- **Mine:** Static/slow, bounce off borders.
- **Briaros:** Bee-like, seeks random zones; super-variant carries high HP.
- **Block:** Large, static obstacle.
- **Gromph, SurGromph:** Slow path-followers.
- **Cutty:** Seeker variant, emerges from top, locks onto hero post-descent.
- **Nes, Gergin:** Path-followers with custom Rafale patterns.
- **Orb, Carrier:** Bonus-related.
- **Shield:** Special enemy with repulsion.
- **Storm:** Special (3 variants), generated dynamically.

## Wave (Wave.mt)

**Path and batch spawner.** Groups enemies traversing a single hardcoded path.

**Constructor (`new Wave(id, speed, flLinear)`):**
- Fetch Stykades.PATH[id] (array of [x, y] tuples).
- Compute cumulative distance per segment → `pl` array (path lengths).
- Set `speed` (pixels/frame along path).
- `flLinear` flag: if true, enemies maintain constant speed; if false, speed adjusts per segment.

**Methods:**
- `addBad(b)` — Attach Bads instance to wave. Set `way` (distance traveled, negative offset for staggering), `pathIndex`, `waveIndex` (index in batch). Add 0 (PATH mode) to `bList`.
- `addBads(f, max)` — Spawn `max` enemies via factory function `f`, attach to wave.
- `flipPath(n)` — Mirror path horizontally (n=0) or vertically (n=1) around screen center.

**Update (called from Bads.update via bList[0]):**
- Increment `way` by `speed × speedCoef × tmod`.
- Interpolate x/y between path nodes based on cumulative distance.
- Every segment transition, check for shot markers in path node (e.g., `path[i][2] == 0` → fire shot now).

## Stykades (Stykades.mt) — boss

**Multi-phase boss state machine.** Not a playable enemy; static class managing difficulty curve, wave generation, boss lifecycle.

**State variables:**
- `dif` (float, accumulates at 0.7/frame) — difficulty; gates enemy type availability.
- `monsterLevel` (sum of enemy difficulties currently alive) — caps at `dif × 0.01`.
- `waveTimer`, `nextWave` — timing for spawn checks (every 10–30 frames).
- `nextBonus` — timer for bonus spawns (every 80–280 frames, scales with dif).
- `BADS_LIMIT` (default 4, degrades to 2 on lag) — max concurrent enemies.
- `FL_CREATE_LOCK` — safety flag to prevent spawn spike.

**PATH array:** 42 pre-defined enemy paths, each is a sequence of [x, y] waypoints. Paths branch into complex spirals, loops, and vertical drops.

**PROB array:** 34 entries defining monster spawn rules: `[monsterTypeId, difficultyThreshold]`. Example: `[3, 700]` = Blackron spawns when `dif > 700`. Higher entries (e.g., Storm) require dif > 5000.

**Update (`static update()`):**
1. Increment `dif` by `CDIF × tmod` (0.7/frame).
2. Decrement `waveTimer` (starts at 150). When elapsed:
   - Check bonus spawn: if `dif > nextBonus`, call `genMonster(21)` (Carrier bonus).
   - Check monster spawn: if `monsterLevel < dif × 0.01`, pick eligible type from PROB, call `genMonster(id)`.
   - Reset timer (10–30 frame random).

**genMonster(n) — factory dispatcher:**
- Types 1–9: Path-based waves (Omega, Double Omega, Blackron, Furia, Gromph, Back-Gromph, Block, SurGromph, Briaros).
- Types 10–12: Storm (3 variants, high difficulty).
- Types 16–18, 20–22: Variants (Briaros Rave, Cutty, NES, Orb, Gergin).
- Types 30–34: Mines, Shield, Killer Briaros (8 super-strong copies).

**No boss phases/HP bar:** Stykades is not a traditional "fight" enemy. Instead, it's the difficulty ramp. The game is "won" by surviving until `dif` reaches some threshold (code suggests hero unlock at dif > 56, no explicit end condition visible).

**Implication:** This is an endless survival game; no boss health, no final stage gate. Porting agent should confirm with design whether there's a target difficulty or if the game loops/repeats.

## Rafale (Rafale.mt) and Shot (Shot.mt)

**Rafale:** Burst-fire sequencer attached to each Bads. Defines a shot pattern (list of type + params + cooldown), fires sequentially.

**Fields:**
- `list` — Array of {type, params, cooldown} entries.
- `index` — Current position in sequence.
- `timer` — Countdown to next shot.
- `w` — Weight (for random selection among multiple Rafales per enemy).
- `dx`, `dy` — Offset from enemy center where shots spawn.
- `orientRay` — Optional radius for shots to spawn relative to hero.

**Shot types (Rafale.shot):**
| Type | Name | Params |
|------|------|--------|
| 0 | FRONT | [speed, skin, ray] — vertical shot downward |
| 1 | STANDARD | [speed, spread] — aimed at hero + jitter |
| 2 | CIBLE | [speed, skin] — aimed shot, no spread |
| 3 | MULTI | [speed, skin, count, angle] — fan spray |
| 4 | FRONT_ANGLED | [speed, spread] — angled front shot with jitter |

**Shot class:** Extends Phys. Projectile with optional targeting and special behaviors.

**Fields:**
- `flGood` — true if shot from hero, false if from enemy (collision logic inverted).
- `flPierce` — can pass through multiple enemies.
- `damage` — float, scales with weapon power.
- `bList` — Array of behavior flags (like Bads).
- `a`, `speed`, `va`, `ca` — angle, speed, angular velocity limit, angular acceleration coef (for homing).
- `trg` — target struct for homing behavior.
- `timer` — fade-out timer (final 10 frames).
- `queue` — optional trail visual (drawn to plasma).

**Behavior modes:**
| ID | Behavior |
|----|----------|
| 0 | Rotation (spin) |
| 3 | Homing (toward nearest enemy) |
| 4 | Ondulate (sine wave angle modulation) |
| 5 | Swarm (random direction changes) |
| 6 | Plasma draw (additive rendering) |
| 7 | Acceleration (speed ramps up) |
| 11 | Burst particles (spawn trailing sparkles) |

**Collision:**
- Hero shots vs enemies: Circle-to-circle (or rect if enemy uses rect field). On hit, apply damage; if piercing and enemy survives, reduce shot damage; else spawn impact particle.
- Enemy shots vs hero: If hero not invincible, trigger `hero.hit(shot)` → explode.

## Sprite (Sprite.mt)

**Base animation class.** Parent of Phys. Lightweight wrapper around MovieClip lifecycle.

**Fields:**
- `x`, `y` — World position.
- `root` — MovieClip with downcasted obj + sub field.
- `scale` — Scale percentage (default 100).

**Methods:**
- `setScale(n)` — Set xscale, yscale to n.
- `update()` — Position root at (x, y).
- `updatePos()` — Immediate position sync (no wait).
- `kill()` — Remove MovieClip, unregister from sList.
- `getDist(o)`, `getAng(o)` — Euclidean distance and angle to another Sprite.
- `isOut(m)` — Bounds check with margin m.

## Part (Part.mt)

**Particle system.** Extends Phys. Spawned for explosions, trails, effects.

**Fields:**
- `timer` — Lifetime in frames.
- `fadeType` — 0 (scale fade), 1 (y-scale fade), default (alpha fade).
- `fadeLimit` — Frames before fade begins (default 10).

**Update:**
- Apply physics (gravity, friction, position).
- If `timer < fadeLimit`, apply fade effect (scale/alpha decay).
- Auto-kill when timer < 0.

**Lifetime typically 10–30 frames. Used for:** Explosions (spawn ~12 particles per hit), laser impacts, plasma trails, boost effect (hero speed weapon).

## Inter (Inter.mt)

**HUD/interface — minimal.** Only implements secondary weapon UI (unused in current flow).

**Fields:**
- `h` — Ref to Hero.
- `ico` — Icon MovieClip for secondary weapon ammo wheel.

**Update:** If hero has secondary weapon selected, display icon + ammo progress on wheel (40-frame rotation).

**Note:** Current code suggests secondary weapon system is not fully integrated. Porting agent may stub this or disable it.

## Bonus (Bonus.mt)

**Pickup items.** Extends Phys. Stochastically spawned by Stykades or dropped by enemies.

**Types (ID 0–5 = weapon pickups, 6 = ammo box, 7+ = unused):**
- IDs 0–5 match Hero weapon types; picking up grants +1 ammo to that weapon.
- ID 6: Adds a weapon slot (max 3).
- IDs 7+ reserved (not implemented).

**Spawn probability (STATS array):**
| ID | Weapon | Weight |
|----|--------|--------|
| 0 | Plasma | 100 |
| 1 | Sider | 60 |
| 2 | Laser | 50 |
| 3 | Speed | 70 |
| 4 | Void | 70 |
| 5 | Missile | 70 |
| 6 | Slot | 30 |

**Physics:** Semi-random initial velocity (3 px/f, angle ≈ 0.775 or π + 0.775 rad), gravity-free, bounces off walls, slow drift downward.

**Update:**
- Check collision with hero (circle).
- Bounds: wrap left/right, bounce off ground.
- If type >= 15 (special): spawn trailing particle rays.
- On touch: Call `take()`, apply weapon/slot bonus, remove from game.

## Manager (Manager.mt)

**Singleton entry point.** Initializes game on first call, runs ticker.

**Functions:**
- `init(root)` — Create Game instance if KKApi available.
- `main()` — Call `Timer.update()`, then `game.main()` each frame.

**No depth management logic here; delegated to Game's DepthManager.**

## Parallax decor

**Background is not a separate SWF.** The system uses:
1. Static background image (`bg` MovieClip, frame 1, looped).
2. Scrolling base platforms (`baseList` array of attached "mcPlanet", "base1", "base2" symbols).
3. Plasma layers (bitmap rendering, not vector decor).

**All decor scrolls vertically at rate `SCROLL_SPEED` (incremented each frame post-step-1, caps at 6).** No horizontal parallax or rate variation. Layers wrap when y > canvas height. Off-screen objects are removed.

**SWF libraries (gfx.swf, monster.swf, decor.swf)** are referenced for symbols (MovieClips attached by name via `dm.attach(name, depth)`), but these are not the focus of the porting. The porting agent should confirm which symbols are used and provide placeholder Pixi Containers/Sprites as needed.

## NIGHT_CODE cheat

**Not found in source.** The brief mentioned this, but no reference exists in the .mt files. Possibly removed or refers to a keyboard sequence for unlocking developer modes (e.g., pressing N-I-G-H-T for level skips). Porting agent should note this as a non-critical feature unless design doc clarifies.

## Input

**Keyboard only:**
- **LEFT/RIGHT** (Key.LEFT, Key.RIGHT) — Horizontal movement.
- **UP/DOWN** (Key.UP, Key.DOWN) — Vertical movement.
- **SPACE / ALT (Key code 18) / ENTER** (Key.ENTER) — Fire.
- **CTRL (Key.CONTROL) / SHIFT (Key.SHIFT)** — Sacrifice weapon slot.

**Cheat keys (if `FL_CHEAT` true, currently hardcoded false):**
- Number pad 0–9: Add weapon directly.
- Number keys 1–5: Spawn weapon boxes.

## Asset symbols expected

Every symbol attached via `dm.attach(name, depth)` must exist. From code analysis:

**From gfx.swf / monster.swf / decor.swf (vector MovieClips):**
- `mcHero` — Player ship sprite (21 frames: idle + moving states + rotations).
- `mcBads` — Generic enemy symbol (frames for each enemy type).
- `mcBonus` — Bonus pickup (1–7 frames).
- `mcShot` — Shot/projectile (frames 1–22, different projectile skins).
- `mcSlot` — Weapon box UI (frames 1–8: empty, then weapon types).
- `mcBg`, `mcPlanet`, `base1`, `base2` — Decor layers.
- `mcSonicBoom` — Expanding wave effect (Sider sacrifice).
- `mcBlackHole` — Void weapon effect (rotating vortex).
- `mcBigLaser` — Speed weapon aura (layered rays).
- `mcOnde`, `mcMiniExplo` — Physics-driven effects.
- `mcExploPart`, `mcExploTrace` — Particle effects (explosion shards + traces).
- `mcSpeed` — Speed boost visual (frames 1–? for power levels).
- `partDebris`, `partLaser`, `partScore`, `partInvincibility`, `partSparkSpeed`, `partImpact`, `partBlackHole`, `partStatic`, `partRay` — Particle effects (sub-classes with gotoAndStop support).
- `mcIcon` — HUD icon for secondary weapon (unused, stub okay).
- `mcRound` — Circular mask for black hole effect.
- `mcLaserLight`, `mcLaserRay` — Laser weapon visuals.
- `queueStandard`, `mcQueueStandard` — Rocket trail visual.

**Approximate count:** 25–30 symbols. Many share frames or have sub-MovieClips (`.sub`, `.wheel`, `.smc`, `.fire`, `.follow`, `.turn` children).

## Recommended TS file split

Given 4074 LOC and multi-phase architecture:

```
src/games/iron-chouquette/
├── index.ts              # Mount, destroy, ticker
├── game.ts               # Game class, main loop, decor, parallax
├── phys.ts               # Phys base (gravity, friction, collision)
├── hero.ts               # Hero + weapons (1000 LOC)
├── bads.ts               # Bads base + AI state machine (700 LOC)
├── wave.ts               # Wave path spawner
├── boss.ts               # Stykades static class, difficulty curve
├── projectiles.ts        # Rafale + Shot classes
├── sprite.ts             # Sprite base (animation, position)
├── part.ts               # Particle system
├── inter.ts              # HUD (minimal)
├── constants.ts          # Cs + PATHS + PROB arrays
└── enemy-factories.ts    # Stykades.newOmega, newBlackron, etc.
```

**Alternative (more granular):** Split bads.ts further (bads-base.ts, bads-ai.ts, bads-factories.ts) if Bads AI becomes complex.

**Rationale:** Hero and Bads are each 700–1000 LOC; physics is shared (separate file for clarity); boss/spawner is static and can be standalone. Projectiles pair naturally. Constants deserve their own file (PATH/PROB are massive).

## Risk flags

1. **Boss state machine ambiguity:** Stykades has no traditional boss entity; difficulty ramp drives spawning. Porting agent must confirm:
   - Is there an explicit win condition (reach dif 5000? survive X seconds)?
   - Does the game loop infinitely, or does it end on hero death?
   - Are there visual/audio cues for difficulty milestones?
   - **Mitigation:** Add a "stage complete" threshold; display difficulty as on-screen counter; log milestones.

2. **Plasma layer BitmapData rendering:** Core visual effect relies on per-frame BitmapData.draw() with matrix transforms, color filters, blur filters, and scrolling. High risk of:
   - Performance cliffs on slower devices (Pixi Renderer may not support native BitmapData equivalent).
   - Color/blend mode mismatch (Flash ColorTransform vs PixiJS filters).
   - **Mitigation:** Prototype plasma layer in Pixi; consider fallback to sprite-batch if BitmapData is infeasible. Benchmark early.

3. **Laser curvature algorithm:** Hero's laser weapon uses iterative angle-steering with target distance check. Algorithm assumes continuous collision test and target persistence. If target dies mid-laser, behavior is undefined.
   - **Mitigation:** Add null-check for target lifespan; clamp laser path length (100 iteration max already in place).

4. **Enemy path interpolation timing:** Wave.update() advances `way` (distance traveled) per frame. If `speed` varies per segment or `flLinear` flag flips, position interpolation may jitter.
   - **Mitigation:** Test path replay with recorded speed profiles; verify hermite or linear interpolation matches original.

5. **Parallax scroll wrap:** Background and baseList wrap at canvas height with no "seam" visible. If wrap point is off by 1 pixel, will see stutter.
   - **Mitigation:** Ensure bg image height = Cs.mch × 2 (or integer multiple); test continuous scroll at max speed.

6. **Collision vs. plasma color sampling:** Bads check hero's plasma layer (weapon-specific) by reading pixel colors at their x, y. If plasma layer resolution or sampling point is off, collision may miss.
   - **Mitigation:** Document plasma layer pixel-to-world scale (pq factor); verify color thresholds match original (lim = 50, check r > lim and g == 0).

## Translation notes

(Cross-reference Killbulle brief for .mt idioms not covered here.)

**Key .mt patterns:**
- **Downcasting:** `downcast(mc)` removes type info; used when assigning custom fields. Port as `as any` or `as unknown as CustomType`.
- **Upcast:** `upcast(obj)` signals polymorphism. Port as type assertion or interface compliance.
- **MovieClip attachment:** `dm.attach(name, depth)` finds symbol in library, attaches to container, returns new instance. Pixi equivalent: create Sprite/Container, assign to parent, set depth via z-index.
- **gotoAndStop(frame):** Jump to frame. Port as spritesheet frame index (0-based).
- **callbacks:** `callback(this, methodName)` creates bound function. Port as arrow function or .bind().
- **volatile:** Marks fields for cheat-detection. Port as public with getter/setter for validation.
- **Timer.tmod:** Timestep scaling factor (1.0 at 60 FPS; 0.3 during bullet-time). Accumulate and apply per fixed step.
- **KKApi:** Leaderboard/scoring wrapper. Port as local stats tracking; submit scores to backend separately.
- **Std.random(n):** Random int [0, n). Port as `Math.floor(Math.random() * n)`.

**Class hierarchy:**
```
Sprite (base: pos, scale, animation)
├─ Phys (adds: gravity, friction, velocity, collision)
   ├─ Hero (player, 6 weapons, state machine)
   ├─ Bads (enemies, AI, Rafale bursts)
   ├─ Shot (projectiles, homing, pierce)
   └─ Part (particles, fade)
Bonus (weapon pickups, extends Phys)
Wave (path spawner, static state)
Stykades (boss/difficulty, static, no MC)
```

---

**Total estimated LOC (TS):** ~5200 (15% overhead for Pixi boilerplate, type annotations, no .mt sugar).

**Testing priorities:**
1. Hero movement + 6-weapon fire patterns.
2. Enemy spawning (Omega wave, Blackron, difficulty curve).
3. Parallax decor scroll + wrap.
4. Plasma layer rendering (laser, speed boost).
5. Boss state transitions + enemy AI (path following, homing).
6. Score tracking + stat aggregation.
7. Edge cases: bullet-time, invincibility, black hole, shield interaction.

---
