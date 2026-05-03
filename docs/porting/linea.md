# Linea Porting Brief (Haxe → TypeScript + PixiJS)

## Stage and Timing

**Dimensions:** 300×300 pixels. The archive `index.html` embeds the loader at 300×320, but the actual `game.swf` display rect is 6000×6000 twips = 300×300 px.

**FPS — corrected:** The compiled `game.swf` and `gfx.swf` headers both report **40 FPS**. The `@90D*` in `project.hxml` is not the runtime frame rate for the SWF in the archive. `Common.hx` also defines `FRAME_RATE = 40`.

Port implication: use a fixed-step accumulator at `STEP_SECONDS = 1 / 40`, and preserve the source's `keymod` smoothing in `Game.update()` because it deliberately runs `updateAll()` about 1.2 times per engine tick under normal `tmod = 1`.

The playfield is not offset below the top border. `Dotter`, objects, bonuses, and UI all share the same root coordinate space; the top and bottom borders overlay y=0..20 and y=280..300.

---

## Constants

All are defined in `Common.hx`, scoped as `Const` class statics. Frame rate is inert; gameplay speeds and thresholds are volatile (server-reloaded).

**Rendering Layers (DepthManager depth indices):**
- `DP_BG` = 0 – Static background
- `DP_BMP` = 1 – Dot grid bitmap
- `DP_UNDER` = 2 – Bonus threshold visual guides (vertical lines)
- `DP_OBJECTS` = 3 – Falling square obstacles
- `DP_PERLIN` = 4 – (unused)
- `DP_BONUS` = 5 – Bonus pickups and line-add bonuses
- `DP_DOT` = 6 – Dot trail particles (explosions)
- `DP_UI` = 7 – Score, multiplier, dot inventory HUD

**Game dimensions:**
- `WIDTH` = 600 in `Const`, but `Game.attachElements()` passes `Math.ceil(Const.WIDTH / 2)` to `Dotter`, so the actual trail `BitmapData` is 300×300.
- `HEIGHT` = 300 (dot playfield height)
- `START` = 50 (x-position where first dot becomes "active")
- `DOT_START_POS` = 150 (initial y for queued dots, in BitmapData space)
- `MARGIN` = 22, `XMARGIN` = 10 (safe zones above/below playfield for obstacles)

**Scoring & difficulty:**
- `BASE_SCORE` = 2000 (per-hit square obstacle)
- `BONUS_COMBO` = 12000 (reward for hitting all 4 sub-hitboxes of a single bonus pickup in one update)
- `LINE_BONUS` = 5 (percentage chance per frame to spawn a line-add bonus instead of a square; server-tuned)
- `BONUSX2_THRESHOLD` = 100, multiplier = 2 (score multiplier at x ≥ 100)
- `BONUSX3_THRESHOLD` = 175, multiplier = 3
- `BONUSX4_THRESHOLD` = 250, multiplier = 8 (sic: not 4, confirmed in code line 62)
- `CAMPER` = 300 (frames of inactivity threshold; at 300 frames, obstacles change sprite frame visually and teleport mechanics engage)
- `MAINCYCLE` = 800 (frames before difficulty ramp: adds 3 to `MINADD`, +1 to `VSCROLL`, +2 to `BASESPEED`)

**Dot physics:**
- `BASE_DOT_UP_SPEED` = −30, `DOWN` = 30, `LEFT` = −20, `RIGHT` = 20 (speed in BitmapData units per 10 frames)
- `DOT_X_SPEED`, `DOT_Y_SPEED` (derived and set dynamically based on key input)
- `DOT_X_SPEED` derived = `Math.round(BASE_DOT_RIGHT_SPEED / 5)` (rounded, ≈6 per frame when moving right)

**Obstacle & bonus generation:**
- `MINADD` = 250 (initial minimum x-distance before next obstacle; ramps up by 3 every 800 frames)
- `MAXADD` = 50
- `VSCROLL` = 1 (vertical oscillation speed for obstacles, in pixels per 10 frames; increments every 800 frames)
- `BASESPEED` = 40, `MINSPEED` = `BASESPEED - 20` = 20 (horizontal scroll speed; MINSPEED used when moving dot vertically to simulate "camping")
- `SPEED` = 50 (base scroll speed for scoring, set to `MINSPEED` when dot moves vertically)
- `BACKSPEED` = 5 (unused)

**Color palettes:**
- `DOTCOLORS` = 8 palettes × 4 colors each (RGBA hex values, pre-converted via `Col.rgb2Hex()`)
- `OBJECTS_COLOR` = same 8 palettes × 5 colors (4 obstacle colors + 1 white for contrast)
- Palette is chosen randomly at game start; dots are popped from the chosen palette as they are added

**Bonus visual:**
- `BONUS_GLOW` = 20 (frame count for animating bonus pickup glow, alternates sprite frames every 20 ticks)
- `KEYPRESSED` = 8 (cooldown frames for any keypress event, unused currently)

---

## Game (Game.hx)

Game is the main scene controller (~818 LOC). It orchestrates the Scroller, Dotter, and object spawning, and drives the update loop with state machine logic.

**Constructor (`new`):**
Initializes the root MovieClip and DepthManager, spawns Scroller (300×300 viewport), and calls `attachElements()` to build UI and sprite attachments. Sets color theme and loads initial dot. All volatile state (bonus, scroll rate, camping counter) is initialized here.

**Main update (`update`):**
Wraps `updateAll()` with timing logic from `mt.Timer.tmod`. Accumulates `keymod` and fires `updateAll()` multiple times when `keymod` exceeds 1 after subtracting 0.8, so at stable `tmod = 1` gameplay logic averages about 1.2 `updateAll()` calls per 40 FPS engine tick. The Pixi port keeps this behavior inside its fixed-step tick.

**State machine (`updateAll` / switch step):**
- **Step 1 (waiting for dot to reach START):** Dot animation ("ready" blink) until first dot x-position crosses 50 pixels. On cross, advances to Step 2, hides start overlay, sets `Const.DOT_X_SPEED = 0`.
- **Step 2 (active play):** Main loop: scrolls dots, obstacles, and bonus pickups; calculates score multiplier based on first dot x-position; increments difficulty every 800 frames. Dot removal triggers Step 3.
- **Step 3 (game over):** Halts scroll, sends final signal to `KKApi.gameOver()` with stats, sets `signalSent = true` to prevent re-fire.

**Key methods:**

- **`scrollDots()`:** Updates Dotter's dot positions, checks multiplier thresholds based on first dot x-pos, and toggles bonus2/bonus3/bonus4 visual indicators.

- **`scrollObjects()`:** Iterates active obstacles. On collision with a started dot: if obstacle is a "line" (line-add bonus), pops a new color from palette and adds new dot; if obstacle is a square, removes dot and triggers game-over if no dots remain. Checks for "camping" (stationary dot for >300 frames) to alter obstacle sprite. Updates obstacle y-position via vertical oscillation.

- **`scrollBonus()`:** Iterates bonus pickups (up to 4 sub-hitboxes per pickup). On collision with any dot: increments multiplier; if all 4 hit, awards combo score; otherwise, awards BASE_SCORE × multiplier. Each pickup can only be hit once per update.

- **`addObject(dx)`:** Spawns obstacles and bonuses pseudo-randomly. Camping logic: every 30 frames without input, increments camper counter and spawns a "camping" obstacle at the leading dot's y-position (centered). Bonuses spawn with 1/50 probability; line-add bonuses with LINE_BONUS percentage. Obstacles spawn with random y in safe zone and vertical oscillation direction. Tracks `lastX` to space spawns.

- **`blowLine(x, y, color)`:** Explosion particle effect—creates 40 particles (10 radial rays × 4 shells) emitted from dot collision point, colored per dot, with physics and fade.

- **FX functions:**
  - `fxShake(sh, shf)`: Root screen shake by ampl `sh` with friction `shf`; decays until < 0.2.
  - `fxFlash(mc, flh, coef, col)`: Color-flash overlay on sprite for `flh` percentage, decays by `coef` per frame.

- **UI scoring (`score()`):** Instantiates "mcLineScore" or "mcBonusScore" MovieClip, displays score and multiplier text, applies glow filter, and attaches physics for upward fade-out over 15 frames.

- **Hit detection:**
  - `hit(mc, x, y)`: AABB for square obstacles; circular distance < 15 for line bonuses.
  - `hit2(root, mc, x, y)`: Circular distance < 8 for bonus pickup sub-hitboxes.

**Input (`onKeyDown`):**
Polls `Key.UP`, `Key.DOWN`, `Key.LEFT`, `Key.RIGHT` (flash.Key API). Updates `Const.DOT_*_SPEED` and `Const.SPEED` (scroll rate penalty when moving vertically). Resets camping counter if moving both horizontally and vertically.

---

## Scroller (Scroller.hx)

Manages background layer(s) tiling and vertical scrolling. In linea, only one layer ("mcBack") is used, loaded from the gfx.swf library.

**Key logic:**
- `addLayer(linkage, xSpeed, verticalScrollEnabled, maxVScroll)`: Registers a layer by string linkage (asset ID in FLA). Creates initial instance at x=0.
- `add(layer, x)`: Attaches MovieClip instance at x-offset. On first add, calculates vertical margin (centering or overflow handling). Stores margin globally.
- `update(xSpeed, xMod, ySpeed)`: Each frame, scrolls x by `xSpeed + xMod` if not at edge; when x ≤ 0 and not yet created, instantiates next tile at `x + width`. Removes tiles when x + width ≤ 0. Handles y-scrolling with margin clamping.

**For TypeScript port:** Background tiling is minimal in linea; Scroller can be simplified to a single scroll-following Container or left as-is if asset recycling is needed. Check gfx.swf content.

---

## Dotter (Dotter.hx)

Core dot grid and path tracing. Renders a trail of dots into a BitmapData (300×300 canvas in this game). Dots are logical entities; their positions drive pixel drawing.

**Architecture:**
- `dots`: PArray of DOT structs (x, y, color, state flags: ready, started, stopped, merged).
- `plane`: BitmapData (300×300). Attached to a MovieClip via `attachBitmap()`.
- Dots are created with a unique ID (uid) for safe removal.

**States per dot:**
- **not started**: Queued, moving horizontally toward `startAim` (width/6 ≈ 100 pixels).
- **started**: Controlled by player input or chained physics. Draws to bitmap.
- **ready**: Aligned to a "line" (row in the trail). Once ready, position is locked vertically relative to first dot.
- **stopped**: Collision with obstacle; no more drawing.

**Key methods:**

- **`addDot(color)`:** Instantiates a new DOT, defaults to color 0xFFFFFF. Sets y = `startPos + (count of non-ready dots) * 10` to queue vertically. Writes initial pixel to plane at (0, startPos).

- **`update(sx, sy, scr, cbk)`:** Main update. Scrolls BitmapData horizontally by `scr` pixels via `plane.scroll()`. Applies a ColorTransform to add sine-wave blue/green/red multiplier (0.98 ± sin) for a "shimmer" effect. Then updates each dot:
  - **Linked (started) dots:** If not ready, calculates target position aligned to first dot with vertical spacing `margin * idx`. Uses `atan2` + trigonometric heading to smooth motion toward target. Once aligned (within ±3 pixels), marks ready and fires callback.
  - **Free (not started) dots:** Moved horizontally at `sx` speed until x ≥ `startAim`, then auto-started.
  - **Line fusion:** If two linked dots have different colors and `merge` flag is true, applies sinusoidal oscillation to animate convergence. (Unused in current game; not sure why it exists.)

- **`moveDot(dot, dx, dy)`:** Writes pixels to plane. Horizontal-only motion draws line from (x, y) to (x + scroll + dx, y). Vertical motion draws bresenham line via `Geom.drawBitmapLine()`. Adds smoothing pixels for anti-aliasing.

- **Helper methods:**
  - `getFirst()`, `getReady()`, `getStarted()`: Lambda filters returning dot arrays.
  - `getLength()`, `remove(uid)`: Dot count and removal.
  - `updateSpeed(vx, vy)`: Cache input speeds.

**For TypeScript port:** The BitmapData trail is the **visual core**. Pixi's RenderTexture can replace BitmapData; pixel writing becomes `Graphics` draws or `Sprite` positioning on the RenderTexture. The shimmer effect requires a ColorTransform on each render. Path smoothing is already baked into the moveDot logic—Pixi needs no extra tweaks.

**Collision detection:** None in Dotter itself; Game.hx checks distance from dots to obstacles/bonuses.

---

## Common (Common.hx)

Utility library with Haxe/Flash-specific imports and helpers.

**Imports:**
- `mt.flash.Volatile`: Decorator for variables marked for server-side tuning.
- `mt.bumdum.Lib`: Flash sprite/physics abstractions.
- Custom typedefs and constants (Const class).

**No public functions exported**—Const and typedefs only. All real utilities are imported from mt.* libraries (DepthManager, Phys, Geom, Col). These are KadoKado internal libraries:
- `mt.DepthManager`: Depth-based sprite layering (replaces `addChildAt()` + sorting).
- `mt.bumdum.Phys`: Physics particle system with timer, fade, velocity, drag.
- `mt.white.Geom`: Geometric drawing and trigonometry (cos, sin, drawLine, drawBitmapLine).
- `Col`: Color utilities (rgb2Hex, setColor, brighten, darken, setPercentColor).
- `KKApi`: Server API for score submission, difficulty tuning, cheat detection.

**For port:** These libraries must be reimplemented or mocked in TypeScript. Pixi has built-in graphics, so Geom is mostly replaced. Phys becomes a simple particle manager. Col becomes PIXI.Color or custom helpers.

---

## Input

**Mouse:** Not used. The path-tracing in this game is not mouse-driven; the dots auto-move via game logic.

**Keyboard:** Four-arrow controls (UP, DOWN, LEFT, RIGHT). Mapped via `flash.Key` API. In TypeScript, use `KeyboardEvent` or a library like `pixi-input`.

```
Key.UP.isDown()     → arrow up
Key.DOWN.isDown()   → arrow down
Key.LEFT.isDown()   → arrow left
Key.RIGHT.isDown()  → arrow right
```

No mouse input is present in the source.

---

## Visual & Layer Composition

Organized via `DepthManager` with 8 layers:

| Depth | Name | Purpose | Sprites |
|-------|------|---------|---------|
| 0 | DP_BG | Static background | mcBack (from Scroller) |
| 1 | DP_BMP | Dot trail bitmap | Dotter's BitmapData + MovieClip |
| 2 | DP_UNDER | Bonus threshold guides | Vertical colored lines (drawLine) |
| 3 | DP_OBJECTS | Falling obstacles | mcSquare instances |
| 4 | DP_PERLIN | (unused) | – |
| 5 | DP_BONUS | Bonus pickups & line-adds | mcBonus, mcAddLine instances + mcBonusParts particles |
| 6 | DP_DOT | Dot explosion particles | mcPart instances from blowLine() |
| 7 | DP_UI | HUD & scoring | mcUI (score text), mcStart (overlay), mcBorder, mcBonusScore, mcLineScore, uidots inventory |

**Pixi Container mapping:**
```
stage
 ├─ bgContainer (DP_BG, DP_UNDER, DP_BMP) [Scroller + guides]
 ├─ gameContainer (DP_OBJECTS, DP_BONUS, DP_DOT)
 └─ uiContainer (DP_UI)
```

---

## Asset Symbols Expected

All are MovieClip linkages from FLA library, referenced via string ID in `dm.attach(name, depth)`. The porting agent must provide these as Pixi Sprites or Graphics in `/public/assets/linea/`:

| Symbol | Depth | Purpose | Notes |
|--------|-------|---------|-------|
| `mcBack` | DP_BG | Background tile | Looping 600×400 image from gfx.swf, centered vertically by `Scroller` |
| `mcBorder` | DP_UI | Top/bottom frame | Simple rect or border graphic |
| `mcStart` | DP_UI | "Ready" blink overlay | Fades out on game start |
| `mcUI` | DP_UI | Score HUD | Container with TextField children: `.b` (base score), `.b2` (x2), `.b3` (x3), `.b4` (x4), `.x` (multiplier), `.dfactor` (difficulty) |
| `mcSquare` | DP_OBJECTS | Obstacle square | 2+ frame animation (states 1=normal, 2=camping, 3=hover, 4=exit) |
| `mcAddLine` | DP_BONUS | Line-add bonus | 2-frame animation for glow |
| `mcBonus` | DP_BONUS | Bonus pickup | 2-frame glow animation; has child MovieClips `.b1`, `.b2`, `.b3`, `.b4` (4 circular hitboxes) |
| `mcBonusParts` | DP_BONUS | Bonus explosion | Multi-frame particle (1 per radial direction); accessed via `gotoAndStop(i+1)` |
| `mcLineScore` | DP_UI | Floating "score" popup | TextFields: `.score`, `.mult` |
| `mcBonusScore` | DP_UI | Floating "bonus" popup | TextFields: `.score`, `.mult` |
| `mcBonusCombo` | DP_UI | "COMBO!" popup | (implied; referenced in scrollBonus) |
| `mcPart` | DP_DOT | Dot explosion particle | Child `.smc` is the colored graphic |

**Asset sources:**
- Static graphics (mcBack, mcBorder, etc.): `/swf/gfx.swf` (not included in archive; must be recreated or mocked).
- Dynamic graphics (lines, glows, shapes): Drawn via `mt.white.Geom.drawLine()`, `drawRectangle()` in code.

---

## HUD & End-of-Run

**Score display:**
- `ui.b` (TextField): Running base score from obstacles hit.
- `ui.b2`, `ui.b3`, `ui.b4` (TextFields): x2, x3, x4 multiplier indicators; visibility toggled based on first dot x-position.
- `ui.dfactor` (TextField): Current difficulty factor (bonus + dot count - 1), displayed as "1", "2", "-" if negative.
- `ui.x` (TextField): Unclear purpose (never written in visible code).

All TextFields have drop shadow filters applied.

**Bonus glows:**
- `bonus2`, `bonus3`, `bonus4` (MovieClips): Rectangular glows at x=100, 175, 250 along bottom HUD. Visibility synced with multiplier tier.

**Floating score popups:**
- Spawned via `score()` method for each obstacle hit or bonus collected.
- Display score value and multiplier (if > 0).
- Attached physics: upward velocity, 15-frame fade-out.

**Game-over flow:**
1. Last dot removed → step = 3.
2. Next update: `gameOver = true`, calls `KKApi.gameOver({Phit, PBonus, PLines, PCamper})`.
3. Stats sent to server (Phit = obstacles hit, PBonus = bonus score, PLines = line-add bonuses collected, PCamper = "camping" obstacle bonus count).

---

## Haxe-Specific Translation Notes

**This is the first Haxe port in the repo.** Existing ports (interwheel, etc.) are from `.mt` (pre-Haxe). Key translation patterns:

### MovieClip Access → Pixi Sprite

**Haxe/Flash:**
```haxe
var mc : flash.MovieClip = dm.attach( "linkageName", depth );
mc._x = 100;
mc._y = 50;
mc._visible = false;
mc.gotoAndStop( frameNumber );
mc._rotation = 45;
mc._alpha = 80;
mc._width = 200;
```

**TypeScript/Pixi:**
```typescript
const mc = createAssetSprite( "linkageName" ); // or load from cache
stage.addChild( mc );
mc.x = 100;
mc.y = 50;
mc.visible = false;
mc.gotoAndStop( frameNumber ); // custom method if animated
mc.rotation = (45 * Math.PI) / 180; // convert degrees to radians
mc.alpha = 0.8; // 0–1 scale, not 0–100
mc.width = 200;
```

**Key differences:**
- `_x`, `_y` → `x`, `y` (underscore convention is Flash-only).
- `_visible` → `visible` (boolean, not string).
- `_alpha` → `alpha` (0–1 scale, not 0–100; divide by 100).
- `_rotation` → `rotation` (radians in Pixi, degrees in Flash; multiply by π/180).
- `_width`, `_height` → `width`, `height`.
- `gotoAndStop(n)` → custom method on animated Sprite; frame index is 0-based in Pixi.
- `_currentframe` → custom `.currentFrame` property.
- `_totalframes` → custom `.totalFrames` property.

### Typedefs → TypeScript Interfaces

**Haxe:**
```haxe
typedef DOT = {x:Int, y:Int, color:Int, ready:Bool, uid:Int}
var dot : DOT = cast {};
dot.x = 10;
```

**TypeScript:**
```typescript
interface DOT {
  x: number;
  y: number;
  color: number;
  ready: boolean;
  uid: number;
}
const dot: DOT = { x: 10, y: 0, color: 0, ready: false, uid: 0 };
```

### PArray (Haxe Array Wrapper)

**Haxe:**
```haxe
var arr = new PArray<DOT>();
arr.push( dot );
arr.remove( dot );
arr.length; // property
for( d in arr ) { ... } // iteration
```

**TypeScript:**
```typescript
const arr: DOT[] = [];
arr.push( dot );
arr.splice( arr.indexOf( dot ), 1 );
arr.length;
for( const d of arr ) { ... }
```

PArray is just a wrapper around Array in Haxe; use native TypeScript arrays.

### Haxe stdlib idioms

- **`Std.random(n)`** → `Math.floor(Math.random() * n)` (0 to n-1).
- **`Std.string(x)`** → `String(x)` or `x.toString()`.
- **`Std.parseInt(s)`** → `parseInt(s, 10)`.
- **`Math.atan2(y, x)`**, **`Math.cos(a)`**, **`Math.sin(a)`** → Identical in TypeScript.
- **`Math.sqrt(x)`**, **`Math.round(x)`**, **`Math.ceil(x)`**, **`Math.floor(x)`** → Identical.
- **`Math.PI`** → Identical in TypeScript.
- **`Lambda.filter(arr, f)`** → `arr.filter(f)` in TypeScript.
- **`Lambda.first(arr)`**, **`.last(arr)`** → `arr[0]`, `arr[arr.length - 1]`.
- **`untyped { ... }`** (dynamic property assignment) → In TypeScript, use `(obj as any).prop = value` or declare properties in interface.

### BitmapData → Pixi RenderTexture

**Haxe:**
```haxe
var bmd = new flash.display.BitmapData(300, 300, true, 0xFF);
root.attachBitmap(bmd, 0, "Never", false);
bmd.setPixel32(x, y, color);
bmd.scroll(-sx, 0);
bmd.colorTransform(bmd.rectangle, colorTransform);
```

**TypeScript/Pixi:**
```typescript
const renderTexture = PIXI.RenderTexture.create({ width: 300, height: 300 });
const sprite = new PIXI.Sprite(renderTexture);
stage.addChild(sprite);

// Pixel drawing: use a Graphics object or draw to a canvas, then update texture
const g = new PIXI.Graphics();
g.pixel(x, y, color);
app.renderer.render(g, { renderTexture });

// Scroll: manually shift drawing offset or use a Container mask
// colorTransform: apply via shader or software (Pixi ColorMatrix plugin)
```

For linea, the Dotter's BitmapData can be replaced with a Graphics-based drawing system or a PixiJS graphics canvas. The shimmer effect (ColorTransform with sine oscillation) requires a custom shader or post-processing.

### Enum vs. Abstract Types

Haxe has:
```haxe
enum MyEnum { A; B(x:Int); }  // ADT
abstract MyAbstract(Int) { ... }  // type alias with methods
```

Linea doesn't use custom enums/abstracts heavily, but the state machine (step 1, 2, 3) uses simple integers. In TypeScript, use an enum or const:
```typescript
const enum GameStep {
  Waiting = 1,
  Playing = 2,
  GameOver = 3,
}
```

### Imports & Namespacing

**Haxe imports:**
```haxe
import mt.flash.Volatile;
import mt.bumdum.Phys;
import mt.white.Geom;
```

These are Motion-Twin internal libraries, not part of the Haxe stdlib. For TypeScript:
- **Volatile** (server-tuned constants): Mock as `{ const: (name) => serverValue }`.
- **Phys** (physics particles): Implement a simple `Particle` class.
- **Geom** (geometry + trig): Implement helpers like `drawBitmapLine()`, `drawLine()`, `cos()`, `sin()`, etc.
- **Col** (color): Implement `rgb2Hex()`, `setColor()`, `brighten()`, `darken()`.
- **DepthManager**: Implement a depth-aware addChild wrapper.

### Dynamic Properties (`untyped`)

```haxe
untyped {
  mc._flhPrc = flh;
  mc._flhCol = col;
}
```

In TypeScript, declare properties on the sprite class or cast to `any`:
```typescript
(mc as any)._flhPrc = flh;
(mc as any)._flhCol = col;
```

Or add to the Sprite interface:
```typescript
interface FlashedSprite extends PIXI.Sprite {
  _flhPrc: number;
  _flhCoef: number;
  _flhCol: number;
}
```

### Flash.Key API

```haxe
using flash.Key;
if( Key.UP.isDown() ) { ... }
```

In TypeScript, use KeyboardEvent or a wrapper:
```typescript
const keysPressed = new Set<string>();
window.addEventListener('keydown', (e) => keysPressed.add(e.code));
window.addEventListener('keyup', (e) => keysPressed.delete(e.code));

if (keysPressed.has('ArrowUp')) { ... }
```

---

## Pixi Scaffolding Reference

Per `/home/holo/prog/motiontwin/src/games/interwheel/index.ts`, the standard setup is:

```typescript
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 300;
const FPS = 40;
const STEP_SECONDS = 1 / FPS;

const app = new PIXI.Application({
  width: STAGE_WIDTH,
  height: STAGE_HEIGHT,
  backgroundColor: 0xffffff,
});

let accumulator = 0;
const ticker = (deltaTime: number) => {
  accumulator += deltaTime;
  while (accumulator >= STEP_SECONDS) {
    gameUpdate(); // Fixed-step
    accumulator -= STEP_SECONDS;
  }
};
app.ticker.add(ticker);
```

Replace `gameUpdate()` with a call to `game.updateAll()` (or simply inline the main loop). The `tmod` variable in the original code is not needed in fixed-step.

---

## Summary

Linea is a vertical-scrolling dot-collection game with keyboard controls and collision-based scoring. The core mechanic is:
1. Player moves a connected chain of dots (via keyboard arrows) horizontally and vertically.
2. Obstacles scroll toward the player; collision removes a dot or adds a new one.
3. Score multipliers unlock at x-thresholds; "camping" (no input) spawns hard obstacles and increases difficulty.
4. Game ends when all dots are removed.

**Key translation challenges:**
- BitmapData path tracing → Pixi RenderTexture or Graphics.
- MovieClip frame animations → Pixi Sprite-sheet or texture swapping.
- Flash.Key polling → KeyboardEvent or input library.
- mt.* libraries (Phys, Geom, Col, DepthManager) → Custom TypeScript implementations.
- KKApi server integration → Mock or integrate with backend API.

**Timeline estimate:** 2–3 days for a competent developer, given asset preparation (FLA extraction, sprite-sheet generation). The logic is straightforward; asset preparation is the bottleneck.
