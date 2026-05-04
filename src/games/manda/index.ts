import { Application, Container, Graphics, Matrix, Sprite, Text, Ticker } from 'pixi.js';
import { noopGameHost } from '../types';
import type { GameHost, GameInstance, GameMountContext } from '../types';
import { type Frame, loadFrame, loadSeries, makeSprite } from '../_shared/frames';

// Stage and timing.
//
// SWF binary header (verified 2026-05-02): 40 FPS. The brief's tentative 24 FPS
// was inferred from `version="8"` in swfmake.xml — that's the SWF format
// version, not the framerate. The original drives motion via Timer.tmod; we run
// a fixed-step accumulator and feed every step a nominal `tmod` of 1.0 so
// per-step physics matches the original constants.
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 320;
const FPS = 40;
const STEP_SECONDS = 1 / FPS;
const TMOD = 1; // each fixed step counts as one frame at the target FPS
const DELTA_T = STEP_SECONDS; // seconds elapsed per fixed step

const ASSET_ROOT = '/assets/manda';

// Const.mt
const COLOR_SHADE = 0xb7ef7c;
const COLOR_SNAKE_DEFAULT = 0x009900;
const COLOR_SNAKE_BORDER_DEFAULT = 0x006c00;
const COLOR_SNAKE_INVINCIBLE = 0x89a6b5;
const COLOR_SNAKE_BORDER_INVINCIBLE = 0x61869a;

const SNAKE_DEFAULT_SPEED = 2.3;
const SNAKE_MIN_SPEED = SNAKE_DEFAULT_SPEED / 2;
const SNAKE_FAST_SPEED_COEF = 3;
const SNAKE_DEFAULT_TURN = 0.125;
const SNAKE_DEFAULT_LENGTH = 3;
const SNAKE_QUEUE_ELT_SIZE = 4;
const SNAKE_SPEED_INCREMENT = 0.001;
const FRICTION = 0.97;

// Bonus weights: CISEAUX, COFFRE, POTION_BLEUE, CANNE, MOLECULE, PLUME, CLOCHE, JACKPOT.
const BONUS_PROBAS = [100, 40, 30, 8, 80, 20, 2, 500];
const BONUS_FREQ = 250;
const BONUS_MAX = 7;

const FRUITS_FREQ = 350;
const FRUITS_MAX = 200;

const FBARRE_MAX = 150;
const FBARRE_FRUIT_TIMEOUT = -1.5;
const FBARRE_FRUIT_EAT = 2;

const LEVEL_BOUNDS = { left: 3, top: 3, right: 297, bottom: 267 };

// Score-multiplier table — KKApi.const() returns its argument unchanged in the
// stripped runtime; we reuse the same numbers verbatim for parity.
const C5 = 5;
const C10 = 10;
const C20 = 20;
const C30 = 30;
const C50 = 50;
const C100 = 100;
const C200 = 200;
const C700 = 700;
const C1900 = 1900;
const C3000 = 3000;
const C4000 = 4000;
const C6000 = 6000;

// Asset frame counts (verified in manda-assets.md).
const TETE_FRAMES = 20;
const BONUS_FRAMES = 23;
const FRUIT_FRAMES = 24;
const FRUIT_TYPE_FRAMES = 201;
const SCORE_DIGIT_FRAMES = 41;
// CISEAUX scissor sub-clip (`DefineSprite_3`, 21 frames). Source places this
// inside `DefineSprite_21` frame 1 — when the bonus inner-`f.gotoAndStop("1")`
// fixes the inner picker on the CISEAUX cell, the scissor sub-MovieClip below
// it auto-plays its 21-frame open/close cycle. Other 7 bonus icons are static
// (`DefineShape` characters) so they don't need this animation.
const CISEAUX_FRAMES = 21;

// POTION_BLEUE bubble sub-clip (`DefineSprite_13`, 15 frames). Source places
// this inside `DefineSprite_21` frame 3 (the POTION_BLEUE icon cell) at depth 4
// with a CXFORMWITHALPHA recoloring three pairs of MorphShape characters
// (chars 6/7, 8/9, 10/11) tweening through ratio sweeps over frames 1-5,
// 6-10, 11-14, then settling on static char 12 at frame 15. The morph shapes
// are pure white (255,255,255) — the colorTransform `r*=51/256, +0;
// g*=51/256, +41; b*=51/256, +204; a*256/256` evaluated on white yields
// (50.8, 91.8, 254.8, 255) ≈ Pixi tint `0x335CFF`, which we apply to the
// white-source PNGs directly (multiplicative tint matches the additive-on-white
// transform exactly because tint*1 == mult+add when the source is the upper
// channel limit). Like CISEAUX, the sub-clip auto-plays continuously while
// the parent timeline is on screen, so we run a 15-frame texture-swap
// counter independent of the parent's apparait/standard/disparait phase.
const POTION_BUBBLE_FRAMES = 15;
// Bubble center in `bonus[10]`'s 86×90 frame (the POTION_BLEUE standard-block
// PNG): empirically measured by sampling pixels matching the colorTransform
// output `(51, 92, 255)` with ±10 RGB tolerance — bbox (34, 42)..(51, 53),
// center (42.5, 47.5). Theoretical placement from sprite_21's frame-3
// `translateX=-12, translateY=81` twips = (-0.6, +4.05) px relative to
// sprite_21 origin; the FFDec extractor pivots `bonus[10]` such that
// sprite_21 origin sits near (43, 45) — the 1.5 px y-discrepancy is the
// extractor's bbox-fit centring of the parent timeline's union shape (the
// bottle's vertical bias shifts the centroid slightly upward of the
// geometric centre). Empirical wins. iconSprite.anchor=(0.5,0.5) puts
// texture pixel (43, 45) at sprite-local (0, 0), so the overlay sits at
// sprite-local (42.5-43, 47.5-45) = (-0.5, +2.5).
const POTION_BUBBLE_OFFSET_X = -0.5;
const POTION_BUBBLE_OFFSET_Y = 2.5;
// Pixi tint applied to the white-source bubble PNGs, recoding the
// CXFORMWITHALPHA colorTransform's output for `RGB(255,255,255)` into a
// multiply-only tint. tint*255/255 = mult+add when the source channels are
// already at 255; this lets us use the Pixi default colour pipeline.
const POTION_BUBBLE_TINT = 0x335cff;

// Per-frame transform of the eye sub-clip during one blink cycle, decoded
// directly from `gfx.swf` `DefineSprite_265` PlaceObject2 matrix tweens (the
// named `o1`/`o2` sub-MovieClips inside `DefineSprite_273_tete`) — verified
// 2026-05-02 via FFDec XML export. The eye is character 263 (a stylised
// black ellipse, shapeBounds 7.5x3.8 px) wrapped in sprite 264. Sprite 265's
// 12-frame timeline does NOT just squash the ellipse vertically — every
// frame past the first applies a non-trivial 2x2 matrix combining vertical
// squash, horizontal skew (rotateSkew0 grows from 0 to ~0.275 rad ≈ 16° at
// peak closure), and ~1% horizontal stretch. Pass 17 simplified to scaleY
// only and missed the skew/stretch components, which tilt the eye's
// horizontal axis as it closes — most visible on frames 4-6 and 8-9 where
// the skew approaches its maximum. We now apply the full per-frame matrix
// via `Matrix.decompose` (Container.setFromMatrix). Each row is `[a, b, d]`
// (c is always 0). Frame 7 is the "eye removed" frame (RemoveObject2Tag at
// depth 1) — represented by a null entry; we hide the eye that frame.
// Source `Snake.move` (`Snake.mt:74-77`) calls `tete.o1.play()` and
// `tete.o2.play()` with `1/round(100/tmod) = 1/100` probability per frame
// at TMOD=1, kicking the sub-clip from its stopped frame-1 state through
// one full cycle.
type EyeMatrix = [number, number, number]; // [a, b, d]
const EYE_BLINK_MATRIX: (EyeMatrix | null)[] = [
  [1.0,        0.0,         1.0       ], // frame 1 — open (identity)
  [1.0014801,  0.009307861, 0.96421814], // frame 2
  [1.0051422,  0.04399109,  0.8568573 ], // frame 3
  [1.0089722,  0.09794617,  0.6779022 ], // frame 4
  [1.0087433,  0.17835999,  0.42736816], // frame 5
  [1.0,        0.28211975,  0.10527039], // frame 6 — peak skew + closure
  null,                                   // frame 7 — eye removed
  [1.0,        0.28211975,  0.10527039], // frame 8 — re-placed at frame-6 pose
  [1.0094604,  0.15596008,  0.49671936], // frame 9
  [1.0073242,  0.06686401,  0.7763214 ], // frame 10
  [1.0022888,  0.014144897, 0.94407654], // frame 11
  [1.0,        0.0,         1.0       ], // frame 12 — back to identity
];

// Eye placement inside `tete` (sprite-local coordinates of the centred-anchor
// 34x30 head PNG). SWF places `o1` at (translateX=186, translateY=-120)
// twips = (9.3, -6) px in tete-local; `o2` at (186, 120) with scaleY=-1
// (vertical mirror). The asset extractor produces a 34x30 PNG whose top-left
// corresponds to the head shape's (Xmin, Ymin) = (-13.1, -12.45) twips-px.
// With `anchor.set(0.5)` the sprite's (0, 0) sits at PNG (17, 15), so SWF
// origin is at sprite-local (-3.9, -2.55) and the SWF eye placements map to
// sprite-local (5.4, -8.55) for the upper eye and (5.4, +3.45) for the
// lower. Note this is NOT vertically symmetric in the centred-bbox frame
// because the head's bbox itself isn't centred on the SWF rotation origin
// (head shape extends asymmetrically forward of centre); the SWF placement
// IS symmetric about y=0 in source space, which is the correct eye-symmetry
// axis. Eye shape itself is ~7.5x3.8 px centred on its own sub-clip origin.
const EYE_OFFSET_X = 5.4;
const EYE_O1_OFFSET_Y = -8.55;
const EYE_O2_OFFSET_Y = 3.45;
const EYE_BASE_RADIUS_X = 3.75; // half of shapeBounds X (75 twips = 3.75 px)
const EYE_BASE_RADIUS_Y = 1.9;  // half of shapeBounds Y (38 twips = 1.9 px)

// Reusable scratch matrix for per-frame eye-blink composite construction.
// Avoids allocating one Matrix per Snake.draw call.
const EYE_MATRIX_SCRATCH = new Matrix();

// Bonus atlas (`bonus/`, 23 frames extracted from DefineSprite_22) is split
// into three labelled blocks by parent timeline:
//   frames 1-8   = "ombre" / preview block (corner-registered tiny icons)
//   frames 9-16  = "standard" block (full-size icons for the 8 bonus types)
//   frames 17-23 = "disparait" fade-out cells
// At runtime source attaches the parent and sets the inner sub-clip
// `f.gotoAndStop(id+1)` (`Level.mt:41`). The inner sub-clip itself is
// `DefineSprite_21` — 8 frames matching the 8 bonus types in order
// (scissors, chest, potion, cane, molecule, feather, bell, lightning).
// The "standard" block on the parent atlas is the same set of full-size
// icons — verified by visual inspection of `extracted-assets/manda/`.
// Index `BONUS_STANDARD_OFFSET + id` lands on the player-visible icon.
const BONUS_STANDARD_OFFSET = 8;

// Bonus IDs.
const BONUS_CISEAUX = 0;
const BONUS_COFFRE = 1;
const BONUS_POTION_BLEUE = 2;
const BONUS_CANNE = 3;
const BONUS_MOLECULE = 4;
const BONUS_PLUME = 5;
const BONUS_CLOCHE = 6;
const BONUS_JACKPOT = 7;

// Per-frame scale of the inner `f` sub-clip during the parent's `apparait`
// pop-in animation, decoded from the SWF binary's PlaceObject2 matrix tweens
// (`DefineSprite_225 fruit` / `DefineSprite_22 bonus` — verified against
// `gfx.swf` 2026-05-02). `Level.generateFruit/Bonus` attaches the parent at
// frame 1 and lets it auto-play; the parent's frame 1-9 timeline scales the
// inner from ~10% up to its overshoot peak then settles at the rest scale.
// Tweens preserve the source's overshoot/settle envelope (fruit: ~120% peak
// then 109% rest; bonus: 150% peak then 128% rest). Length 9 = 9 fixed steps
// at 40 FPS = 225 ms total pop-in.
const FRUIT_APPARAIT_SCALE = [
  0.0999, 0.4361, 0.7111, 0.9250, 1.0778, 1.1694, 1.2000, 1.1778, 1.0888,
];
const BONUS_APPARAIT_SCALE = [
  0.0999, 0.5278, 0.8778, 1.1499, 1.3444, 1.4611, 1.5000, 1.4444, 1.2778,
];

// Per-frame scale during the parent's `disparait` shrink-out animation. Same
// 7-frame curve for both fruit and bonus parents (verified — both timelines
// carry identical PlaceObject scales at frames 16-22 / 15-21 respectively).
// Source `Item.update` (`Item.mt:13-21`) calls `mc.gotoAndPlay("disparait")`
// when `time <= 0`; the parent then plays its disparait block and the final
// frame's `removeMovieClip("")` action self-destroys the mc. Length 7 =
// 7 fixed steps = 175 ms fade-out.
const ITEM_DISPARAIT_SCALE = [0.9859, 0.9438, 0.8734, 0.7750, 0.6484, 0.4937, 0.3109];

// Per-digit visible width (px) for `scoreDigit` frames 1..10 = digits 0..9.
// Source `PopScore.init` reads each digit MovieClip's `_width`, which returns
// the rendered shape's bounding-box width — not the symbol's canvas size.
// Pixi's `sprite.width` returns the texture canvas width (39 px for every
// digit), so naively reading it spaced every digit at 39 px apart and offset
// the digit-1 glyph by ~7.5 px relative to source. Pre-measured per-digit
// bboxes from the extracted `score-digit/` PNGs give the source-faithful
// spacing: digit 1 is ~24 px wide, the rest are 38-39 px. Index = digit
// value (0..9). Verified 2026-05-02 via PIL `getbbox()` against
// `extracted-assets/manda/DefineSprite_261_scoreDigit/{1..10}.png`.
const SCORE_DIGIT_VISUAL_WIDTH = [39, 24, 38, 38, 38, 38, 39, 38, 38, 38];

// pivot: assets exported with top-left origin; we set sprite anchors per-sprite where needed.

type MandaAssets = {
  bg: Frame;
  bgMask: Frame;
  jackpotFrame: Frame;
  jackpotMask: Frame;
  qparticule: Frame;
  bonus: Frame[];
  fruit: Frame[]; // 24-frame outer "fruit" symbol — labeled timeline (ombre/standard/disparait); not currently rendered (live fruit uses only `fruitType[id]` per `Level.mt:23-26`).
  fruitType: Frame[]; // 201-frame fruit ID atlas (the sub-clip `f`)
  tete: Frame[];
  scoreDigit: Frame[];
  ciseaux: Frame[]; // 21-frame scissor open/close sub-MovieClip (`DefineSprite_3`); animates inside the CISEAUX bonus icon.
  potionBubble: Frame[]; // 15-frame morph-shape bubble sub-MovieClip (`DefineSprite_13`); animates inside the POTION_BLEUE bonus icon.
};

type Point = { x: number; y: number };
type Bounds = { left: number; top: number; right: number; bottom: number };

type UpdateFn = () => void;

function randomInt(max: number): number {
  if (max <= 1) {
    return 0;
  }
  return Math.floor(Math.random() * max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function randomProbas(weights: number[]): number {
  const total = weights.reduce((sum, w) => sum + w, 0);
  let draw = randomInt(total);
  for (let i = 0; i < weights.length; i += 1) {
    draw -= weights[i];
    if (draw < 0) {
      return i;
    }
  }
  return weights.length - 1;
}

async function loadAssets(): Promise<MandaAssets> {
  const [bg, bgMask, jackpotFrame, jackpotMask, qparticule, bonus, fruit, fruitType, tete, scoreDigit, ciseaux, potionBubble] = await Promise.all([
    loadFrame(`${ASSET_ROOT}/bg.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/bg-mask.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/jackpot.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/jackpot-mask.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/qparticule.png`, 0, 0),
    loadSeries(`${ASSET_ROOT}/bonus`, BONUS_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/fruit`, FRUIT_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/fruit-type`, FRUIT_TYPE_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/tete`, TETE_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/score-digit`, SCORE_DIGIT_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/ciseaux`, CISEAUX_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/potion-bubble`, POTION_BUBBLE_FRAMES, 0, 0),
  ]);
  return { bg, bgMask, jackpotFrame, jackpotMask, qparticule, bonus, fruit, fruitType, tete, scoreDigit, ciseaux, potionBubble };
}

// -------------------------------------------------------------------------------------------------
// Movable: shared base for Fruit and Bonus. Encapsulates the parametric jump/fall arc.
// -------------------------------------------------------------------------------------------------

abstract class Movable {
  view: Container;
  shade: Sprite | null = null;
  // Position (logical). View is repositioned in render-step via the values we set on `view` in move().
  x = 0;
  y = 0;
  z = 0;
  scale = 1;

  protected moving = false;
  protected xStart = 0;
  protected yStart = 0;
  protected zStart = 0;
  protected xDest = 0;
  protected yDest = 0;
  protected coefA = 0;
  protected coefB = 0;
  protected speed = 0;
  protected t = 0;

  constructor(view: Container) {
    this.view = view;
    this.x = view.x;
    this.y = view.y;
  }

  isMoving(): boolean {
    return this.moving;
  }

  setPos(px: number, py: number): void {
    this.x = px;
    this.y = py;
    this.z = 0;
    this.moving = false;
    this.view.x = px;
    this.view.y = py;
    if (this.shade) {
      this.shade.removeFromParent();
      this.shade = null;
    }
  }

  abstract createShade(): Sprite;
  abstract inBounds(x: number, y: number): boolean;

  protected addShade(): void {
    if (this.shade === null) {
      this.shade = this.createShade();
    }
    this.shade.visible = true;
    this.shade.x = this.x;
    this.shade.y = this.y;
  }

  move(): void {
    if (!this.moving) {
      return;
    }
    this.t += TMOD * this.speed;
    if (this.t >= 1) {
      this.x = this.xDest;
      this.y = this.yDest;
      this.z = 0;
      if (this.shade) {
        this.shade.removeFromParent();
        this.shade = null;
      }
      this.moving = false;
    } else {
      this.x = this.xStart + (this.xDest - this.xStart) * this.t;
      this.y = this.yStart + (this.yDest - this.yStart) * this.t;
      this.z = this.coefA * this.t * this.t + this.coefB * this.t + this.zStart;
    }
    if (this.shade && this.z !== 0) {
      this.shade.x = this.x + this.z / 4;
      this.shade.y = this.y + this.z / 3;
      const s = ((100 - this.z / 2) / 100) * this.scale;
      this.shade.scale.set(s);
    }
    const vs = ((100 + this.z) / 100) * this.scale;
    this.view.scale.set(vs);
    this.view.x = this.x;
    this.view.y = this.y - this.z;
  }

  jumpNear(ray: number, zmax: number, speed: number, _bounds: Bounds): void {
    // _bounds kept for API parity with source; clamping is handled via inBounds().
    this.speed = speed;
    this.xStart = this.x;
    this.yStart = this.y;
    this.zStart = this.z;
    this.t = 0;
    this.coefB = zmax * 4 - this.z;
    this.coefA = -this.coefB - this.z;

    let tries = 100;
    do {
      const ang = randomInt(360) / (Math.PI * 2);
      this.xDest = this.x + Math.cos(ang) * ray;
      this.yDest = this.y + Math.sin(ang) * ray;
      tries -= 1;
    } while (!this.inBounds(this.xDest, this.yDest) && tries > 0);

    this.addShade();
    this.moving = true;
  }

  fall(speed: number): void {
    this.speed = speed;
    this.x = this.view.x;
    this.y = this.view.y;
    this.xStart = this.x;
    this.yStart = this.y;
    this.zStart = this.z;
    this.xDest = this.x;
    this.yDest = this.y;
    this.t = 0;
    this.coefA = 5;
    this.coefB = -this.z - this.coefA;
    this.addShade();
    this.moving = true;
  }
}

// -------------------------------------------------------------------------------------------------
// Item / Fruit / Bonus
// -------------------------------------------------------------------------------------------------

abstract class Item extends Movable {
  id: number;
  time: number;
  // Approximate AABB used for spawn validation and snake collision (the original used pixel hitTest).
  halfW = 12;
  halfH = 12;

  // Index into the parent's apparait scale-tween timeline (0..apparaitScale().length).
  // Source: parent fruit/bonus mc auto-plays from frame 1 on attach; the inner
  // sub-clip `f` is scaled by the timeline. We replicate by stepping this counter
  // once per fixed step and applying the per-frame scale to `inner`.
  apparaitFrame = 0;

  constructor(id: number, view: Container, time: number) {
    super(view);
    this.id = id;
    this.time = time;
    this.rndPos();
  }

  // Subclass returns the inner sprite (`f` in source) that the parent timeline
  // tween scales. Returns null until the subclass has wired its inner sprite.
  protected abstract inner(): Sprite | null;

  // Per-step scale tween table for the apparait pop-in (source `apparait` label
  // through the implicit stop frame). Fruit and bonus differ in peak / settle.
  protected abstract apparaitScale(): number[];

  // Public accessor for collision detection — reads the inner sprite's
  // current scale to size the AABB hit zone. Indirects through `inner()` so
  // both Fruit (`pickerSprite`) and Bonus (`iconSprite`) share the call site.
  itemInner(): Sprite | null {
    return this.inner();
  }

  rndPos(): void {
    let x = 0;
    let y = 0;
    let tries = 200;
    do {
      x = randomInt(STAGE_WIDTH);
      y = randomInt(STAGE_WIDTH); // original uses Const.HEIGHT (=300); stays inside playable region
      tries -= 1;
    } while (!this.inBounds(x, y) && tries > 0);
    this.x = x;
    this.y = y;
    this.view.x = x;
    this.view.y = y;
  }

  inBounds(x: number, y: number): boolean {
    const lv = LEVEL_BOUNDS;
    return x - this.halfW > lv.left && y - this.halfH > lv.top && x + this.halfW < lv.right && y + this.halfH < lv.bottom;
  }

  // Source `Item.update` (`Item.mt:13-21`): move(), then decrement `time` while
  // not moving, then return false (and `mc.gotoAndPlay("disparait")`) once
  // expired. The disparait fade-out is handled by the parent timeline + a
  // self-`removeMovieClip("")` on its final frame; we drive an equivalent
  // tween on the inner sprite via `Manager.updates` from `Level.main` at
  // expiry time so `update()` keeps returning false (logically dead) while
  // the visual fade plays out.
  update(): boolean {
    // Advance the parent's apparait timeline. The inner's resting scale is
    // the tween's last value; once the counter reaches the end we stop
    // applying so collision and movement see a stable size.
    const tween = this.apparaitScale();
    if (this.apparaitFrame < tween.length) {
      const inner = this.inner();
      if (inner !== null) {
        inner.scale.set(tween[this.apparaitFrame]);
      }
      this.apparaitFrame += 1;
    }

    this.move();
    if (!this.isMoving()) {
      this.time -= DELTA_T;
    }
    return this.time > 0;
  }

  destroy(): void {
    this.view.removeFromParent();
    if (this.shade) {
      this.shade.removeFromParent();
      this.shade = null;
    }
  }

  // Pins the inner sprite at the parent's resting `standard` scale and disables
  // the apparait tween. Mirrors source `f.mc.gotoAndStop("standard")` — used
  // for the CANNE giant fruit (`Bonus.mt:55`), the only callsite where the
  // source explicitly bypasses the parent's auto-play pop-in.
  skipApparait(): void {
    const inner = this.inner();
    const tween = this.apparaitScale();
    if (inner !== null && tween.length > 0) {
      inner.scale.set(tween[tween.length - 1]);
    }
    this.apparaitFrame = tween.length;
  }

  // Plays the inner-sprite shrink tween (`disparait` block) and removes the
  // view at the end. Mirrors `Item.update`'s `gotoAndPlay("disparait")` plus
  // the parent timeline's frame-23 self-`removeMovieClip("")` action.
  startDisparait(game: MandaGame): void {
    const inner = this.inner();
    let i = 0;
    if (inner === null) {
      this.destroy();
      return;
    }
    if (this.shade) {
      this.shade.removeFromParent();
      this.shade = null;
    }
    const tick: UpdateFn = () => {
      if (i < ITEM_DISPARAIT_SCALE.length) {
        inner.scale.set(ITEM_DISPARAIT_SCALE[i]);
        i += 1;
        return;
      }
      this.view.removeFromParent();
      game.removeUpdate(tick);
    };
    game.addUpdate(tick);
  }
}

class Fruit extends Item {
  add_queue = true;
  // Reference to the inner picker sprite ("f") — shows the actual fruit type.
  pickerSprite: Sprite;
  game: MandaGame;

  constructor(id: number, view: Container, pickerSprite: Sprite, game: MandaGame) {
    super(id, view, 6 + randomInt(200) / 100);
    this.scale = 0.75;
    this.view.scale.set(this.scale);
    this.pickerSprite = pickerSprite;
    // Source's parent fruit timeline starts at frame 1 with `f` at scale ~0.10
    // (the apparait pop-in's first frame). Pre-scale the inner here so the
    // first rendered frame matches the source instead of flashing at full
    // size before the first `update()` applies the tween.
    this.pickerSprite.scale.set(FRUIT_APPARAIT_SCALE[0]);
    this.game = game;
  }

  protected inner(): Sprite | null {
    return this.pickerSprite;
  }

  protected apparaitScale(): number[] {
    return FRUIT_APPARAIT_SCALE;
  }

  static basePoints(rawId: number): number {
    const id = rawId + 1;
    if (id <= 25) return id * C5;
    if (id <= 60) return C200 + (id - 25) * C10;
    if (id <= 100) return C700 + (id - 60) * C20;
    if (id <= 145) return C1900 + (id - 100) * C30;
    if (id <= 170) return C4000 + (id - 145) * C50;
    return C6000 + (id - 170) * C100;
  }

  points(): number {
    if (this.pointsOverride !== null) {
      return this.pointsOverride;
    }
    return Fruit.basePoints(this.id);
  }

  pointsOverride: number | null = null;

  createShade(): Sprite {
    // Approximation: original creates a `fruit` MovieClip on PLAN_FRUITS_SHADE,
    // sets the timeline to "ombre" and gotoAndStop(id+1) on its sub-clip.
    // We render the fruit-type frame with a dark tint as a proxy.
    const shadeFrameIndex = clamp(this.id, 0, FRUIT_TYPE_FRAMES - 1);
    const shade = makeSprite(this.game.assets.fruitType[shadeFrameIndex]);
    shade.anchor.set(0.5);
    shade.tint = 0x000000;
    shade.alpha = 0.35;
    shade.scale.set(this.scale);
    this.game.fruitShadeLayer.addChild(shade);
    return shade;
  }
}

class Bonus extends Item {
  game: MandaGame;
  iconSprite: Sprite;
  // Per-step frame counter for the CISEAUX scissor sub-clip animation. Source
  // places `DefineSprite_3` (21-frame open/close cycle) inside `DefineSprite_21`
  // frame 1 — when `f.gotoAndStop("1")` fixes the inner picker on the CISEAUX
  // cell, the scissor sub-MovieClip below it auto-plays its 21-frame loop.
  // Other 7 bonus icons are static `DefineShape` characters with no equivalent
  // sub-animation, so this counter only advances for `id === BONUS_CISEAUX`.
  // -1 = uninitialised/disabled (set on construction for non-CISEAUX bonuses).
  private ciseauxFrame = -1;
  // Per-step frame counter for the POTION_BLEUE bubble sub-clip animation
  // (`DefineSprite_13`, 15 frames). Same lifecycle as `ciseauxFrame`: -1 =
  // disabled, otherwise advances modulo 15 on every fixed step. Drives the
  // texture of the overlay sprite added as a child of `iconSprite` (see
  // constructor). The morph-shape source frames are pre-extracted to
  // `public/assets/manda/potion-bubble/` and loaded as `assets.potionBubble`.
  private potionBubbleFrame = -1;
  // Overlay child sprite that displays the animated bubble on top of the
  // statically baked bubble already present in `bonus[10]`. Native source
  // 19×13 px white morph shape; tinted to the colorTransform output. Null
  // for non-POTION_BLEUE bonuses.
  private potionBubbleSprite: Sprite | null = null;

  // Static state matches Bonus.mt — CISEAUX_COUNT increments globally; POTION_BLEUES counts active stacks.
  static ciseauxCount = 1;
  static potionBleues = 0;

  constructor(id: number, view: Container, iconSprite: Sprite, game: MandaGame) {
    super(id, view, 7 + randomInt(300) / 100);
    this.scale = 0.75;
    this.view.scale.set(this.scale);
    this.iconSprite = iconSprite;
    // Source's parent bonus timeline starts at frame 1 with `f` at scale ~0.10
    // (the apparait pop-in's first frame). See `Fruit` constructor comment.
    this.iconSprite.scale.set(BONUS_APPARAIT_SCALE[0]);
    this.game = game;
    if (id === BONUS_CISEAUX) {
      this.ciseauxFrame = 0;
      this.iconSprite.texture = game.assets.ciseaux[0].texture;
    } else if (id === BONUS_POTION_BLEUE) {
      // Add the bubble overlay as a child of `iconSprite` so the apparait
      // pop-in / disparait fade-out scale (and the parent view's `scale=0.75`)
      // both propagate automatically through the parent-child transform
      // chain. Source's `DefineSprite_13` is composited beneath the bottle's
      // outer shape (depth 4 vs depth 3 for char 5 = bottle outline) but
      // pass 22's snapshot bake of `bonus[10]` already includes the bottle
      // — and the bubble sub-clip's white morph shape is fully opaque (alpha
      // 255 fill), so an opaque overlay drawn ON TOP of the baked frozen
      // bubble fully obscures it as long as it covers the same area. The
      // overlay is sized at 19×13 px native; the baked frozen bubble
      // measures 18×12 px in `bonus[10]`, so the overlay is ~6% larger and
      // fully obscures it without bleed. The slight upper extension into
      // bottle pixels is invisible because the bottle area is uniform blue
      // (matching the tint).
      const bubble = makeSprite(game.assets.potionBubble[0]);
      bubble.anchor.set(0.5);
      bubble.tint = POTION_BUBBLE_TINT;
      bubble.x = POTION_BUBBLE_OFFSET_X;
      bubble.y = POTION_BUBBLE_OFFSET_Y;
      this.iconSprite.addChild(bubble);
      this.potionBubbleSprite = bubble;
      this.potionBubbleFrame = 0;
    }
  }

  protected inner(): Sprite | null {
    return this.iconSprite;
  }

  protected apparaitScale(): number[] {
    return BONUS_APPARAIT_SCALE;
  }

  // Override to advance the CISEAUX scissor and POTION_BLEUE bubble sub-clip
  // animations in lockstep with the parent's apparait/standard/disparait
  // timeline. Source's sub-clips auto-play from attach time and loop their
  // frames continuously (CISEAUX: 21, POTION_BLEUE: 15) until the parent's
  // `removeMovieClip("")` action destroys them.
  update(): boolean {
    const alive = super.update();
    if (this.ciseauxFrame >= 0) {
      this.ciseauxFrame = (this.ciseauxFrame + 1) % CISEAUX_FRAMES;
      this.iconSprite.texture = this.game.assets.ciseaux[this.ciseauxFrame].texture;
    }
    if (this.potionBubbleFrame >= 0 && this.potionBubbleSprite !== null) {
      this.potionBubbleFrame = (this.potionBubbleFrame + 1) % POTION_BUBBLE_FRAMES;
      this.potionBubbleSprite.texture = this.game.assets.potionBubble[this.potionBubbleFrame].texture;
    }
    return alive;
  }

  createShade(): Sprite {
    // Use the same standard-block frame as the live icon so the shadow tracks the visible glyph.
    const idx = clamp(BONUS_STANDARD_OFFSET + this.id, 0, BONUS_FRAMES - 1);
    const shade = makeSprite(this.game.assets.bonus[idx]);
    shade.anchor.set(0.5);
    shade.tint = 0x000000;
    shade.alpha = 0.35;
    shade.scale.set(this.scale);
    this.game.fruitShadeLayer.addChild(shade);
    return shade;
  }

  activate(g: MandaGame): void {
    const x = this.view.x;
    const y = this.view.y;
    this.destroy();

    switch (this.id) {
      case BONUS_CISEAUX: {
        // Source `Bonus.mt:18` writes `for(i=0; i<CISEAUX_COUNT, g.snake.len > 0; i++)`.
        // The C-style for-loop condition uses the comma operator, which evaluates both
        // expressions and returns the last — so the effective condition is just
        // `g.snake.len > 0`, and the `i < CISEAUX_COUNT` clause is dead code. CISEAUX
        // therefore explodes every body segment in one activation; `CISEAUX_COUNT++`
        // increments a counter that no other code reads. Earlier passes mistook the
        // comma for `&&` and capped the loop at CISEAUX_COUNT iterations, making the
        // most common bonus a mild "trim 1-2 segments" effect instead of a full body
        // wipe. Mirror the source bug verbatim.
        while (g.snake.len > 0) {
          g.snake.explode(g.snake.getColor());
        }
        Bonus.ciseauxCount += 1;
        break;
      }
      case BONUS_COFFRE: {
        const n = 5 + randomInt(5);
        for (let i = 0; i < n; i += 1) {
          const f = g.level.generateFruit();
          f.setPos(x, y);
          f.add_queue = false;
          f.jumpNear(randomInt(20) + 20, randomInt(10) + 15, 0.05, LEVEL_BOUNDS);
        }
        break;
      }
      case BONUS_POTION_BLEUE: {
        let time = 15;
        Bonus.potionBleues += 1;
        g.snake.blue = true;
        g.snake.blue_flag = true;
        const update: UpdateFn = () => {
          time -= DELTA_T;
          if (time < 2 && Bonus.potionBleues === 1 && (g.fcounter & 2) === 0) {
            g.snake.blue_flag = false;
          } else {
            g.snake.blue_flag = true;
          }
          if (time < 0) {
            Bonus.potionBleues -= 1;
            if (Bonus.potionBleues === 0) {
              g.snake.blue = false;
              g.snake.blue_flag = false;
            }
            g.removeUpdate(update);
          }
        };
        g.addUpdate(update);
        break;
      }
      case BONUS_CANNE: {
        const f = g.level.generateFruit();
        const pts = f.points() * C10;
        f.setPos(STAGE_WIDTH / 2, STAGE_WIDTH / 2);
        f.z = 100;
        f.scale *= 2;
        f.fall(0.08);
        f.pointsOverride = pts;
        f.add_queue = true;
        // Source `Bonus.mt:55` calls `f.mc.gotoAndStop("standard")` to pin
        // the parent fruit timeline at the rest frame and skip the apparait
        // pop-in animation — the only spawn-time bypass in the source.
        f.skipApparait();
        break;
      }
      case BONUS_MOLECULE: {
        g.spawnPopScore(x, y, 3000);
        g.addScore(C3000);
        g.fbarre = Math.min(FBARRE_MAX, g.fbarre + 10);
        break;
      }
      case BONUS_PLUME: {
        g.snake.speed = Math.max(SNAKE_MIN_SPEED, g.snake.speed - 1.0);
        break;
      }
      case BONUS_CLOCHE: {
        if (g.fcloche !== null) {
          return;
        }
        let n = g.snake.len;
        const cb: UpdateFn = () => {
          if (g.snake.len <= 0 || n <= 0) {
            g.fcloche = null;
            return;
          }
          const p = g.snake.endQueuePos(0);
          if (g.snake.len % 2 === 0) {
            const f = g.level.generateFruit();
            f.id = 75;
            f.view.x = p.x;
            f.view.y = p.y;
            f.x = p.x;
            f.y = p.y;
            f.pickerSprite.texture = g.assets.fruitType[clamp(75, 0, FRUIT_TYPE_FRAMES - 1)].texture;
          }
          g.snake.explode(g.snake.getColor());
          // Source explicitly calls `g.snake.draw()` after explode in the cloche callback so
          // the segment burn renders the same step as the spawn instead of one frame later.
          g.snake.draw();
          n -= 1;
        };
        g.fcloche = cb;
        break;
      }
      case BONUS_JACKPOT: {
        g.jackpot.start();
        break;
      }
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Snake
// -------------------------------------------------------------------------------------------------

class Snake {
  // Rendering containers.
  gfx: Graphics;
  shade: Graphics;
  tete: Sprite;
  // Eye sub-clips `o1` (upper) and `o2` (lower mirrored) — children of `tete`,
  // mirroring the SWF's named PlaceObject2 instances inside `DefineSprite_273`.
  // Drawn procedurally as small black ellipses (eye shape 263 is a plain
  // RGB(0,0,0) ellipse 7.5x3.8 px in the SWF). Parented under `tete` so they
  // inherit head rotation/scale automatically. Hidden when the snake is in
  // the blue/invincible state because tete frame 2 (the blue head) removes
  // both o1 and o2 from its display list — the blue head asset stands alone.
  o1: Graphics;
  o2: Graphics;
  // Eye-blink frame counter — `-1` = stopped at frame 1 (eye open, source's
  // `DoActionTag actionBytes="0700"` = stop() at the top of `DefineSprite_265`).
  // Set to `0` to start a blink; advances per fixed step through
  // `EYE_BLINK_SCALE_Y.length` frames then snaps back to `-1`.
  private eyeFrame = -1;

  // The head sprite has a small "collide" reference point in the original at sub-clip "col".
  // We pre-compute a forward collision point each step.
  collidePoint: Point = { x: 0, y: 0 };

  // Position history: appended every queue-elt-size pixels travelled.
  queue: Point[] = [];

  // Dynamics.
  x = 0;
  y = 0;
  ang = 0;
  speed = SNAKE_DEFAULT_SPEED;
  base_speed = 1;
  eat_speed = 1;
  len = SNAKE_DEFAULT_LENGTH;
  delta_ang = SNAKE_DEFAULT_TURN;

  // Internal.
  private dx = 0;
  private dy = 0;
  private dist = 0;
  private eat = 0;
  private oldAng = -100;
  private redraw = true;

  // Powerups.
  blue = false;
  blue_flag = false;

  game: MandaGame;

  constructor(game: MandaGame, parent: Container, pos: Point) {
    this.game = game;
    this.shade = new Graphics();
    this.gfx = new Graphics();
    this.tete = makeSprite(game.assets.tete[0]);
    this.tete.anchor.set(0.5);
    // Build the eye sub-clips as Graphics ellipses parented under `tete`.
    // Source `DefineSprite_273` PlaceObject2 places `o1` at sprite-local
    // (5.4, -8.55) and `o2` at sprite-local (5.4, +3.45) — see
    // EYE_*_OFFSET_Y derivation. Drawing the ellipse centred on each
    // Graphics's own origin (`drawEllipse(0, 0, ...)`) lets us scale the
    // Graphics itself for the blink without a separate pivot.
    this.o1 = new Graphics();
    this.o1.ellipse(0, 0, EYE_BASE_RADIUS_X, EYE_BASE_RADIUS_Y).fill({ color: 0x000000 });
    this.o1.x = EYE_OFFSET_X;
    this.o1.y = EYE_O1_OFFSET_Y;
    this.o2 = new Graphics();
    this.o2.ellipse(0, 0, EYE_BASE_RADIUS_X, EYE_BASE_RADIUS_Y).fill({ color: 0x000000 });
    this.o2.x = EYE_OFFSET_X;
    this.o2.y = EYE_O2_OFFSET_Y;
    // Source places `o2` with `scaleY=-1` (vertical mirror). The eye shape
    // is symmetric about its own y-axis so this is invisible at rest, but
    // becomes visible during a blink once the per-frame skew kicks in: the
    // upper eye tilts one way, the lower eye tilts the opposite way as
    // they close toward each other. Set the mirror at construction so the
    // identity-state placement matches the source's display list.
    this.o2.scale.y = -1;
    this.tete.addChild(this.o1, this.o2);

    parent.addChild(this.shade, this.gfx, this.tete);

    this.x = pos.x;
    this.y = pos.y;

    for (let i = 0; i < 50; i += 1) {
      this.queue.push({ x: pos.x, y: pos.y });
    }
  }

  endQueuePos(delta: number): Point {
    const idx = Math.max(0, this.queue.length - this.len * SNAKE_QUEUE_ELT_SIZE + delta) | 0;
    return this.queue[Math.min(idx, this.queue.length - 1)];
  }

  // Returns true on hit (self-collision or out-of-bounds).
  move(bounds: Bounds): boolean {
    let hit = false;

    // Eye-blink trigger — source `Snake.mt:74-77`:
    //   if( Std.random(Math.round(100/tmod)) == 0 ) {
    //     downcast(tete).o1.play();
    //     downcast(tete).o2.play();
    //   }
    // 1/100 per frame at TMOD=1 → expected blink every ~2.5 s at 40 FPS.
    // Only kick a new blink if the previous one has finished (eyeFrame == -1);
    // source's `play()` on a clip already mid-cycle is a no-op there too.
    if (this.eyeFrame < 0 && randomInt(Math.max(1, Math.round(100 / TMOD))) === 0) {
      this.eyeFrame = 0;
    }

    if (this.eat > 0) {
      this.eat -= (this.eat_speed * TMOD) / 2;
      this.redraw = true;
    }

    if (this.oldAng !== this.ang) {
      this.ang -= ((this.ang / (Math.PI * 2)) | 0) * Math.PI * 2;
      this.oldAng = this.ang;
      this.dx = Math.cos(this.ang);
      this.dy = Math.sin(this.ang);
    }

    const stepSpeed = this.speed * TMOD * this.base_speed;
    const esize = SNAKE_QUEUE_ELT_SIZE;
    const ds = Math.min(esize * 1.5 + this.len, 3 * esize);
    const colPt: Point = { x: this.x + this.dx * ds, y: this.y + this.dy * ds };

    let ncols = ((stepSpeed / esize) | 0) + 1;
    while (ncols > 0) {
      ncols -= 1;
      const dStep = ncols > 0 ? esize : stepSpeed % esize;
      colPt.x += this.dx * dStep;
      colPt.y += this.dy * dStep;
      if (!this.blue && this.testSelfHit(colPt)) {
        this.eat = 0;
        hit = true;
        break;
      }
    }

    this.x += this.dx * stepSpeed;
    this.y += this.dy * stepSpeed;

    this.dist += stepSpeed / esize;
    while (this.dist >= 1) {
      this.dist -= 1;
      this.queue.push({ x: this.x, y: this.y });
      this.redraw = true;
    }

    if (colPt.x < bounds.left || colPt.y < bounds.top || colPt.x > bounds.right || colPt.y > bounds.bottom) {
      this.eat = 0;
      hit = true;
    }
    this.collidePoint = colPt;
    return hit;
  }

  // Per-segment capsule self-hit test. Mirrors `Snake.drawQueue` (`Snake.mt:175-210`)
  // segment-for-segment: same queue stride (`esize`), same width formula
  // `i * s * q + lsize` where lsize=8 matches the widest (border) stroke that the
  // source's `gfx.hitTest(...,true)` reads. Each segment is treated as a capsule
  // (line + radius=width/2). Replaces the round-1 circle-vs-queue-samples
  // approximation (radius 5) which both ignored segment widths and missed hits in
  // the gaps between samples; pass-1 useful-next-work suggested this exact
  // approach. Skip the head-most segment so the neck never self-hits.
  private testSelfHit(pt: Point): boolean {
    const esize = SNAKE_QUEUE_ELT_SIZE;
    let n = this.queue.length - 1;
    if (n < 0) return false;
    const scale = Math.min(10, this.len + 3) / 20;
    const s = (scale * 15) / Math.max(1, this.len);
    const eatFlag = this.eat > 0;
    const lsize = 8; // widest stroke (border) — what gfx.hitTest sees on the gfx mc.
    // Skip the head-most segment (i = len): the lookahead colPt is built
    // forward of the head, so the neck would otherwise always self-hit.
    let pHead = this.queue[n];
    n -= esize;
    for (let i = this.len - 1; i > 0; i -= 1) {
      if (n < 0) break;
      const pTail = this.queue[n];
      const q = eatFlag ? Math.max(1, 2 - ((i - this.eat) * (i - this.eat)) / 2) : 1;
      const width = i * s * q + lsize;
      const radius = width * 0.5;
      // Distance from pt to segment [pHead, pTail].
      const sx = pTail.x - pHead.x;
      const sy = pTail.y - pHead.y;
      const len2 = sx * sx + sy * sy;
      let t = len2 > 0 ? ((pt.x - pHead.x) * sx + (pt.y - pHead.y) * sy) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const cx = pHead.x + sx * t;
      const cy = pHead.y + sy * t;
      const ddx = pt.x - cx;
      const ddy = pt.y - cy;
      if (ddx * ddx + ddy * ddy < radius * radius) {
        return true;
      }
      pHead = pTail;
      n -= esize;
    }
    return false;
  }

  hit(pt: Point): boolean {
    return this.testSelfHit(pt);
  }

  draw(): void {
    const scale = Math.min(10, this.len + 3) / 20;
    this.tete.x = this.x;
    this.tete.y = this.y;
    this.tete.rotation = this.ang;
    const t = 0.3 + 0.7 * scale;
    this.tete.scale.set(t);

    // Advance the eye-blink sub-clip timeline. Source's `o1`/`o2` are
    // `DefineSprite_265` MovieClips that, once `play()`-ed, advance one
    // frame per global tick through 12 frames; we mirror that with a
    // per-step scaleY tween. Eyes are visible in the green/normal head
    // state only (source frame 1 places `o1`/`o2` on the display list;
    // frame 2 — the blue head — removes them and renders a self-contained
    // blue head shape with no overlay eye sub-clips).
    const eyesVisible = !(this.blue && this.blue_flag);
    if (this.eyeFrame >= 0) {
      // Per-frame eye matrix decoded from the SWF tween (see EYE_BLINK_MATRIX).
      // Frame 7 is the "eye removed" frame — hide both eyes that step.
      const m = EYE_BLINK_MATRIX[Math.min(this.eyeFrame, EYE_BLINK_MATRIX.length - 1)];
      if (m === null) {
        this.o1.visible = false;
        this.o2.visible = false;
      } else {
        const [a, b, d] = m;
        // o1 (upper) composite = T(EYE_OFFSET_X, EYE_O1_OFFSET_Y) * M_eye.
        // Build via Matrix.set + setFromMatrix so position, scale, skew are
        // jointly set — Pixi's Container.setFromMatrix calls
        // matrix.decompose(this) which writes scale, rotation, skew, position.
        EYE_MATRIX_SCRATCH.set(a, b, 0, d, EYE_OFFSET_X, EYE_O1_OFFSET_Y);
        this.o1.setFromMatrix(EYE_MATRIX_SCRATCH);
        // o2 (lower) effective matrix = T(EYE_OFFSET_X, EYE_O2_OFFSET_Y) *
        // S(1, -1) * M_eye. Composing S(1,-1) on the inner matrix produces
        // [a, b, c, d] -> [a, -b, -c, -d]. With c=0 this becomes [a, -b, 0, -d].
        // The vertical mirror reflects the eye so the upper and lower eyes
        // close toward each other (matching source's `o2` placement at
        // scaleY=-1 inside `tete`).
        EYE_MATRIX_SCRATCH.set(a, -b, 0, -d, EYE_OFFSET_X, EYE_O2_OFFSET_Y);
        this.o2.setFromMatrix(EYE_MATRIX_SCRATCH);
        this.o1.visible = eyesVisible;
        this.o2.visible = eyesVisible;
      }
      this.eyeFrame += 1;
      if (this.eyeFrame >= EYE_BLINK_MATRIX.length) {
        // Snap back to stopped/open state — sprite 265's frame 1 has a
        // `stop()` action that the looped playthrough re-arms. Reset to the
        // identity placement so the next idle render uses (5.4, ±) at scale 1.
        EYE_MATRIX_SCRATCH.set(1, 0, 0, 1, EYE_OFFSET_X, EYE_O1_OFFSET_Y);
        this.o1.setFromMatrix(EYE_MATRIX_SCRATCH);
        EYE_MATRIX_SCRATCH.set(1, 0, 0, -1, EYE_OFFSET_X, EYE_O2_OFFSET_Y);
        this.o2.setFromMatrix(EYE_MATRIX_SCRATCH);
        this.o1.visible = eyesVisible;
        this.o2.visible = eyesVisible;
        this.eyeFrame = -1;
      }
    } else {
      this.o1.visible = eyesVisible;
      this.o2.visible = eyesVisible;
    }

    if (!this.redraw) {
      return;
    }
    this.redraw = false;

    this.gfx.clear();
    this.shade.clear();
    this.drawQueue(this.shade, scale, COLOR_SHADE, 8, 4);
    this.drawQueue(this.gfx, scale, this.getBorderColor(), 8, 0);
    this.drawQueue(this.gfx, scale, this.getColor(), 5, 0);

    // tete.gotoAndStop("1"|"2") — pass-2 inspection of `tete/1.png` (green normal head)
    // and `tete/2.png` (blue invincible head) confirms frames 1 and 2 are the
    // normal / invincible variants. Earlier pass tinted the green frame; we now
    // swap to the actual asset and drop the tint.
    const teteFrame = this.blue && this.blue_flag ? this.game.assets.tete[1] : this.game.assets.tete[0];
    if (this.tete.texture !== teteFrame.texture) {
      this.tete.texture = teteFrame.texture;
    }
    this.tete.tint = 0xffffff;
  }

  getColor(): number {
    return this.blue && this.blue_flag ? COLOR_SNAKE_INVINCIBLE : COLOR_SNAKE_DEFAULT;
  }

  getBorderColor(): number {
    return this.blue && this.blue_flag ? COLOR_SNAKE_BORDER_INVINCIBLE : COLOR_SNAKE_BORDER_DEFAULT;
  }

  private drawQueue(target: Graphics, scale: number, color: number, lsize: number, dy: number): void {
    let n = this.queue.length - 1;
    if (n < 0) return;
    let p = this.queue[n];
    const s = (scale * 15) / Math.max(1, this.len);
    const eatFlag = this.eat > 0;
    const esize = SNAKE_QUEUE_ELT_SIZE;
    const demi = (esize / 2) | 0;

    target.moveTo(p.x, p.y + dy);

    for (let i = this.len; i > 0; i -= 1) {
      const idx = n - esize;
      const idxMid = n - demi;
      if (idx < 0) break;
      const pNew = this.queue[idx];
      const pMid = this.queue[Math.max(0, idxMid)];
      const q = eatFlag ? Math.max(1, 2 - ((i - this.eat) * (i - this.eat)) / 2) : 1;
      const width = i * s * q + lsize;
      target.quadraticCurveTo(pMid.x, pMid.y + dy, pNew.x, pNew.y + dy);
      target.stroke({ width, color, alpha: 1, cap: 'round', join: 'round' });
      target.moveTo(pNew.x, pNew.y + dy);
      p = pNew;
      n -= esize;
    }
  }

  addQueue(): void {
    const overflow = Math.max(0, this.queue.length - this.len * SNAKE_QUEUE_ELT_SIZE - 1);
    if (overflow > 0) {
      this.queue.splice(0, overflow);
    }
    const p = this.queue[0] ?? { x: this.x, y: this.y };
    for (let i = 0; i < 10; i += 1) {
      this.queue.unshift({ x: p.x, y: p.y });
    }
    this.len += 1;
    this.redraw = true;
    this.eat = (this.len - 1) | 0;
  }

  reverse(): void {
    let delta = -1;
    let p1 = this.endQueuePos(delta);
    let p2: Point;
    do {
      p2 = this.endQueuePos(delta);
      delta += 1;
    } while (p1 === p2 && delta < 20);
    p1 = this.endQueuePos(-1);

    const overflow = Math.max(0, this.queue.length - this.len * SNAKE_QUEUE_ELT_SIZE - 1);
    if (overflow > 0) {
      this.queue.splice(0, overflow);
    }
    this.queue.reverse();

    this.ang = Math.atan2(p1.y - p2.y, p1.x - p2.x);
    this.x = p1.x;
    this.y = p1.y;
    this.redraw = true;
    this.oldAng = -100;
  }

  explode(rgb: number): void {
    // Source `Snake.explode` (`Snake.mt:247-248`) reads `pos = queue[queue.length - len*esize]`
    // and unconditionally decrements `len`. With `len = 0` the AS2 read indexes past the end
    // (returns undefined) but the runtime tolerates it and `len--` continues to -1, which is
    // exactly what `Game.gameOverMain` (`Game.mt:94, 105-108`) needs to fall into the `else`
    // branch that hides `tete` and submits the score. Earlier port versions early-returned
    // when `len <= 0` to avoid the out-of-bounds read; that guard prevented the final
    // decrement from 0 to -1, leaving the snake head visible forever and the game-over
    // finalizer (`tete.visible = false` plus `KKApi.saveScore`-equivalent end state)
    // unreachable. Read pos safely for the len=0 frame and let `len` continue to -1.
    if (this.len < 0) return;
    const safeQueueIdx = Math.max(0, Math.min(this.queue.length - 1, this.queue.length - this.len * SNAKE_QUEUE_ELT_SIZE));
    const pos = this.queue[safeQueueIdx] ?? { x: this.x, y: this.y };
    this.len -= 1;
    if (this.len < 0) {
      // Skip particle spawn / draw on the final cosmetic decrement — source's
      // pos lookup is undefined here too and the 10 particles spawn at (0, 0)
      // off-stage in AS2; mirror by issuing no particles. The decrement itself
      // is the load-bearing side-effect that `gameOverMain` consumes.
      this.redraw = true;
      return;
    }

    type Particule = { mc: Graphics; ang: number; speed: number };
    const particules: Particule[] = [];
    // Source `Snake.explode` reads `tete._xscale` / `_yscale` AFTER `len--` — i.e. the
    // head's current scale from the previous draw call (which used the pre-decrement len).
    // Mirror that by reading the live tete scale here.
    const headScale = this.tete.scale.x;
    // Source `qparticule` is a `DefineShape` filled with solid green RGB(0,153,0)
    // — verified by SWF tag stream (`DefineShapeTag shapeId=226`,
    // `<color blue="0" green="153" red="0"/>`). Source's `new Color(p).setRGB(rgb)`
    // (`Snake.mt:255-256`) is a Flash COLORTRANSFORM that REPLACES the fill colour
    // with the snake's getColor() while preserving alpha, producing solid green for
    // the normal state and solid blue-grey for invincible. Pixi `Sprite.tint`
    // multiplies, which on a green source yields darker green for the green-tint
    // case (0,91,0 instead of 0,153,0) and a dim olive for the blue-grey-tint case
    // (0,99,0 instead of 137,166,181) — the invincible-snake explode looked wrong.
    // Ground-truthed shape geometry (`Xmin/Xmax/Ymin/Ymax = -229/71/-205/95` twips
    // = 15×15 px, 8 CurvedEdgeRecords approximating a circle of radius ~7.5 px)
    // and replaced the Sprite-with-tint with a Graphics circle filled with the
    // target colour, which mirrors `setRGB`'s solid-colour replacement.
    for (let i = 0; i < 10; i += 1) {
      const sp = new Graphics();
      sp.circle(0, 0, 7.5).fill(rgb);
      sp.scale.set(headScale);
      sp.x = pos.x;
      sp.y = pos.y;
      this.game.particleLayer.addChild(sp);
      const ang = randomInt(180) / Math.PI;
      const speed = 1 + randomInt(100) / 100;
      particules.push({ mc: sp, ang, speed });
    }

    const update: UpdateFn = () => {
      for (let i = 0; i < particules.length; i += 1) {
        const p = particules[i];
        const sp = p.speed * TMOD;
        p.mc.x += Math.cos(p.ang) * sp;
        p.mc.y += Math.sin(p.ang) * sp;
        p.mc.rotation += sp * 10 * (Math.PI / 180);
        p.mc.alpha -= sp * 0.1;
        if (p.mc.alpha <= 0) {
          p.mc.removeFromParent();
          particules.splice(i, 1);
          i -= 1;
        }
      }
      if (particules.length === 0) {
        this.game.removeUpdate(update);
      }
    };
    this.game.addUpdate(update);
    this.redraw = true;
  }

  destroy(): void {
    this.tete.removeFromParent();
    this.gfx.removeFromParent();
    this.shade.removeFromParent();
  }
}

// -------------------------------------------------------------------------------------------------
// Level (fruit + bonus spawning and collision)
// -------------------------------------------------------------------------------------------------

class Level {
  game: MandaGame;
  fruits: Fruit[] = [];
  bonuses: Bonus[] = [];
  bonus_time = 0;
  bonus_inhib = 0;
  fl = 0;

  constructor(game: MandaGame) {
    this.game = game;
  }

  generateFruit(): Fruit {
    const base = (this.game.fbarre / 3) | 0;
    const ampl = Math.max(1, Math.round((this.game.fbarre * (FRUITS_MAX - base + 1)) / FBARRE_MAX));
    const id = base + randomInt(ampl);
    const safeId = clamp(id, 0, FRUIT_TYPE_FRAMES - 1);

    const view = new Container();
    // Source `Level.generateFruit` (`Level.mt:23-26`):
    //   var mc = game.dmanager.attach("fruit", PLAN_FRUITS);  // outer mc — default frame
    //   downcast(mc).f.gotoAndStop(string(id+1));              // inner sub-clip = fruit type
    // i.e. only the inner sub-clip `f` is set per id; the outer `mc` stays at its default
    // (frame 1 — verified empty: 4×5 visible pixels in a 195×134 frame). Earlier passes
    // composited `fruit[safeId % 24]` UNDER `fruitType[safeId]` to approximate the parent,
    // which doubled visible fruit pixels (fruit/2-22, 24 all carry visible glyphs that the
    // source never displays at runtime — those frames belong to the "standard"/"disparait"
    // labeled timeline blocks of the parent symbol that `Level.generateFruit` does not
    // navigate to). Render only the inner picker so the live fruit matches what the
    // source's parent-at-default-frame plus inner-`f`-at-`id+1` actually shows.
    const picker = makeSprite(this.game.assets.fruitType[safeId]);
    picker.anchor.set(0.5);
    view.addChild(picker);
    this.game.fruitLayer.addChild(view);

    const f = new Fruit(safeId, view, picker, this.game);
    this.fruits.push(f);
    this.fl += 1;
    return f;
  }

  generateBonus(): void {
    let id = 0;
    do {
      id = randomProbas(BONUS_PROBAS);
    } while (this.game.jackpot.encyclo.length < 5 && id === BONUS_JACKPOT);

    const view = new Container();
    // Source `Level.generateBonus` (`Level.mt:38-41`):
    //   var mc = game.dmanager.attach("bonus", PLAN_FRUITS); // outer parent at default frame
    //   downcast(mc).f.gotoAndStop(string(id+1));            // inner sub-clip = bonus type
    // The outer parent's atlas (`bonus/`, 23 frames) splits into ombre/standard/disparait
    // blocks; the inner sub-clip `f` is `DefineSprite_21` — 8 frames showing the 8 bonus
    // icons at full size. Earlier rounds rendered `bonus[id]` (frames 1-8 = the ombre /
    // preview block where icons appear tiny and corner-registered) — that's the parent's
    // default-frame view of the inner with its small-scale layout, not the runtime
    // appearance after `f.gotoAndStop(id+1)` advances the inner. The "standard" block at
    // frames 9-16 contains the same icon set rendered at the standard size (verified by
    // visual comparison with `DefineSprite_21/1.png..8.png`). Use that block so the live
    // bonus visible to the player matches what the source actually displays.
    const safeId = clamp(BONUS_STANDARD_OFFSET + id, 0, BONUS_FRAMES - 1);
    const icon = makeSprite(this.game.assets.bonus[safeId]);
    icon.anchor.set(0.5);
    view.addChild(icon);
    this.game.fruitLayer.addChild(view);

    const b = new Bonus(id, view, icon, this.game);
    this.bonuses.push(b);
  }

  main(): void {
    if (!this.game.game_over_flag) {
      // Fruit spawn matches Level.mt: `Std.random(Math.round(FRUITS_FREQ * fruits.length / tmod)) == 0`.
      // When `fruits.length == 0` the divisor rounds to 0 and Haxe's `Std.random(0)` returns 0 → spawn
      // every frame until the first fruit appears. We replicate that with an unconditional spawn so the
      // game starts populating immediately instead of stalling for ~9s.
      if (this.fruits.length === 0) {
        this.generateFruit();
      } else if (randomInt(Math.max(1, Math.round((FRUITS_FREQ * this.fruits.length) / TMOD))) === 0) {
        this.generateFruit();
      }

      if (this.bonus_inhib > 0) {
        this.bonus_inhib -= DELTA_T;
        this.bonus_time = 0;
      } else {
        const score = this.game.score;
        const denom = Math.max(
          1,
          Math.round(((BONUS_FREQ + score / 10000) * (this.bonuses.length + 1)) / TMOD - this.bonus_time / 6),
        );
        if (this.bonuses.length < BONUS_MAX && randomInt(denom) === 0) {
          this.bonus_time = 0;
          this.generateBonus();
        } else {
          this.bonus_time += TMOD;
        }
      }
    }

    // Snake-head AABB in world-layer coords. Source `Level.main` uses
    // `Std.hitTest(snake.collide_mc, f.mc)` (`Level.mt:72, 84`) — the two-arg
    // `Std.hitTest` form is AABB-vs-AABB intersection between the two
    // MovieClip bounding boxes. `collide_mc` is the `col` sub-clip of `tete`,
    // anchored on the head so its stage-space bounds track `tete._x/_y` (the
    // actual head position) — NOT the lookahead `collide_point` that the
    // pre-pass-12 port used. The lookahead is `(x + dx*ds, y + dy*ds)` with
    // `ds ∈ [9, 12]`, so the old test eat-zone sat 9-12 px ahead of the
    // visible head: the player ate fruit before the head touched it, and
    // fruit pinned under the head's visible position would not register.
    // Re-anchor the snake hit zone on the head, then use sprite-driven AABB
    // for both sides instead of the fixed-radius circle approximation.
    const snake = this.game.snake;
    const headHalf = this.snakeHeadHalfExtent();
    const headLeft = snake.x - headHalf;
    const headRight = snake.x + headHalf;
    const headTop = snake.y - headHalf;
    const headBottom = snake.y + headHalf;

    for (let i = 0; i < this.fruits.length; i += 1) {
      const f = this.fruits[i];
      const alive = f.update();
      if (!alive) {
        // Source `Item.update` calls `mc.gotoAndPlay("disparait")` and returns
        // false; `Level.main` removes the logical entry but does NOT
        // `destroy()` the mc — the parent timeline plays out its disparait
        // shrink and self-removes via the `removeMovieClip("")` action on
        // the final frame. Mirror by handing the view off to a fade-out
        // tick and removing from the logical array now.
        f.startDisparait(this.game);
        this.bonus_inhib += 6;
        this.game.fbarre = Math.max(0, this.game.fbarre + FBARRE_FRUIT_TIMEOUT);
        this.fruits.splice(i, 1);
        this.fl -= 1;
        i -= 1;
      } else if (
        !this.game.game_over_flag &&
        this.itemHit(f, headLeft, headTop, headRight, headBottom) &&
        this.game.eatFruit(f)
      ) {
        this.fruits.splice(i, 1);
        this.fl -= 1;
        i -= 1;
      }
    }

    for (let i = 0; i < this.bonuses.length; i += 1) {
      const b = this.bonuses[i];
      const alive = b.update();
      if (!alive) {
        // Same disparait fade-out pattern as fruit. Source `Item.update` is
        // shared between Fruit and Bonus; bonuses on natural expiry shrink
        // out via the parent timeline's disparait block.
        b.startDisparait(this.game);
        this.bonuses.splice(i, 1);
        i -= 1;
      } else if (
        !this.game.game_over_flag &&
        this.itemHit(b, headLeft, headTop, headRight, headBottom)
      ) {
        b.activate(this.game);
        this.bonuses.splice(i, 1);
        i -= 1;
      }
    }
  }

  // Half-extent of the head hit box in world-layer coords. Source `collide_mc`
  // is the `col` sub-clip of the `tete` MovieClip; its native bounds aren't
  // recoverable from the extracted PNGs, but it tracks `tete._xscale/_yscale`
  // which Snake.draw sets to `30 + 70 * scale` where
  // `scale = min(10, len+3) / 20 ∈ [0.3, 0.5]` → tete scale ∈ [0.51, 0.65].
  // We approximate `col` as a square ~14 px on each side at full tete scale
  // (matching the previous fixed radius the port used as a tuned constant
  // for "snake head + fruit halo"), scaled with the head so a small starting
  // snake has a tighter eat zone than a fully grown one — which is what the
  // source's AABB-on-`tete`-child does.
  private snakeHeadHalfExtent(): number {
    const teteScale = this.game.snake.tete.scale.x; // 0.51..0.65 depending on len
    return 14 * (teteScale / 0.65); // tuned at the upper bound; smaller heads shrink proportionally
  }

  private itemHit(item: Item, hl: number, ht: number, hr: number, hb: number): boolean {
    // Item AABB in world-layer coords (`view.x/y` is the centre because all
    // sub-sprites use anchor 0.5; `view.scale` is 0.75 to mirror the source's
    // `mc._xscale/_yscale = 75`). `item.halfW/halfH` are the per-class extent
    // (12 px for fruit/bonus by default — same value the source's
    // `f.getBounds(mc)` returns within rounding for the typical fruit-type
    // glyph). Source `Std.hitTest(c, f.mc)` reads the parent mc's bounds,
    // which Flash computes from the rendered display list — i.e. the parent
    // scale multiplied by the inner `f.mc._xscale/_yscale` set by the
    // apparait/disparait timeline. Multiply by the inner sprite's current
    // scale so the eat-zone tracks the visible glyph size during the pop-in
    // (~10% inner at frame 1 → ~109% at rest for fruit) and shrinks during
    // disparait, instead of a constant view-only AABB that lets the player
    // eat fruit while it's still visually tiny.
    const ix = item.view.x;
    const iy = item.view.y;
    const inner = item.itemInner();
    const innerScale = inner !== null ? inner.scale.x : 1;
    const half = item.halfW * item.view.scale.x * innerScale;
    const il = ix - half;
    const ir = ix + half;
    const it = iy - half;
    const ib = iy + half;
    return ir > hl && il < hr && ib > ht && it < hb;
  }
}

// -------------------------------------------------------------------------------------------------
// Jackpot (3-slot machine)
// -------------------------------------------------------------------------------------------------

type JackpotSlot = {
  bg: Sprite;
  fruit: Sprite;
  id: number;
};

class Jackpot {
  game: MandaGame;
  encyclo: number[] = [];
  slots: JackpotSlot[] = [];
  nturns = 0;
  coins = 0;
  count2 = 0;
  count3 = 0;

  constructor(game: MandaGame) {
    this.game = game;
    this.initSlots();
  }

  initSlots(): void {
    for (let i = 0; i < 3; i += 1) {
      const bg = makeSprite(this.game.assets.jackpotFrame);
      bg.anchor.set(0.5);
      bg.x = 110 + i * 30;
      bg.y = 270;
      this.game.hudLayer.addChild(bg);

      const fruit = makeSprite(this.game.assets.fruitType[0]);
      fruit.anchor.set(0.5);
      fruit.x = bg.x;
      fruit.y = bg.y + 15;
      fruit.scale.set(0.4);
      // Source `Jackpot.initSlots` calls `fruit.stop()` and leaves visibility default (true) —
      // the player sees three idle slot windows showing fruit id 0 until the first jackpot trigger.
      this.game.hudLayer.addChild(fruit);

      this.slots.push({ bg, fruit, id: 0 });
    }
  }

  addFruit(id: number): void {
    if (id === 75) return; // cloche fruit excluded
    this.encyclo.push(id);
    while (this.encyclo.length > 10) {
      this.encyclo.shift();
    }
  }

  start(): void {
    if (this.nturns <= 0) {
      this.nturns = 100;
    } else {
      this.coins += 1;
    }
  }

  payout(id: number, big: boolean): void {
    const pts = Fruit.basePoints(id) * (big ? C20 : C5);
    // Original jackpot pops via game.interf.empty(PLAN_POPSCORE) — i.e. the HUD layer,
    // not the world layer (which is mask-clipped to the play field above y=269).
    this.game.spawnHudPopScore(160, 285, pts);
    this.game.addScore(pts);
    if (big) this.count3 += 1;
    else this.count2 += 1;
  }

  main(): void {
    if (this.nturns <= 0) return;
    this.nturns -= TMOD;

    for (let i = 0; i < 3; i += 1) {
      const s = this.slots[i];
      if (this.nturns > (2 - i) * 30) {
        if (this.encyclo.length === 0) {
          continue;
        }
        const id = this.encyclo[randomInt(this.encyclo.length)];
        s.id = id;
        const safeId = clamp(id, 0, FRUIT_TYPE_FRAMES - 1);
        s.fruit.texture = this.game.assets.fruitType[safeId].texture;
        // Original: `s.fruit._y = Std.random(30)` (local y inside the slot MC, 0..30).
        // Slot's bg.y + 15 is the resting centre we used in initSlots, so jitter ±15 around it.
        s.fruit.y = s.bg.y + randomInt(30);
      } else {
        // Original sets local _y = 15 on stop → resting centre = bg.y + 15 in our flat layer.
        s.fruit.y = s.bg.y + 15;
      }
    }

    if (this.nturns <= 0) {
      const b1 = this.slots[0].id === this.slots[1].id;
      const b2 = this.slots[1].id === this.slots[2].id;
      const b3 = this.slots[0].id === this.slots[2].id;
      if (b1 && b2 && b3) {
        this.payout(this.slots[0].id, true);
      } else if (b1 || b3) {
        this.payout(this.slots[0].id, false);
      } else if (b2) {
        this.payout(this.slots[1].id, false);
      }

      if (this.coins > 0) {
        this.coins -= 1;
        this.nturns = 100;
      }
      // Source leaves slots visible after a payout (the `f` sub-clip is `stop()`-ed, keeping
      // its last frame on screen). No visibility toggle here — slots display the last id.
    }
  }
}

// -------------------------------------------------------------------------------------------------
// PopScore (digit popup with elastic scale)
// -------------------------------------------------------------------------------------------------

class PopScore {
  game: MandaGame;
  view: Container;
  digits: Sprite[] = [];

  private xtime = 0;
  private ytime = 0;
  private ptime = 1;
  private maxSize: number;
  private xspeed = 4;
  private yspeed = 4;
  private xphase = true;
  private yphase = true;
  private pphase = false;
  private update: UpdateFn;

  constructor(game: MandaGame, x: number, y: number, value: number, layer: Container) {
    this.game = game;
    const view = new Container();
    view.x = x;
    view.y = y;
    view.scale.set(0);
    layer.addChild(view);
    this.view = view;

    this.maxSize = 25 + Math.abs(value) / 100;
    this.maxSize = Math.min(Math.max(40, this.maxSize), 70);

    this.initDigits(value);

    this.update = () => this.tick();
    game.addUpdate(this.update);
  }

  private initDigits(value: number): void {
    const link = this.game.assets.scoreDigit;
    let v = Math.max(0, value | 0);
    let xCursor = 0;
    // Source `PopScore.init` assumes Flash top-left registration on each digit MovieClip:
    // `d._x = x` places the LEFT edge at x, then `x -= d._width` for the next digit, and
    // `valign` shifts by `digits[0]._height / 2` to centre vertically. Earlier rounds
    // applied `anchor.set(0.5)` to the digit sprites while still using the source's
    // top-left-anchored xCursor / yCursor math, which shifted the composite half a glyph
    // left and half a glyph up. We now leave the digit sprite at its default (0,0) anchor
    // so the math matches the source one-for-one.
    //
    // Source's `_width` is the rendered shape's bbox width — varies per digit
    // (e.g. '1' is ~24 px, others 38-39 px). Pixi's `sprite.width` returns the
    // full texture canvas width (39 px for every digit), spacing the digits
    // uniformly and offsetting any composite containing a '1' by ~7.5 px from
    // the source layout. Read per-digit visible widths from
    // SCORE_DIGIT_VISUAL_WIDTH instead so spacing matches Flash bbox semantics.
    if (v === 0) {
      const d = makeSprite(link[0]); // gotoAndStop("1") → first frame = digit 0
      this.digits.push(d);
      this.view.addChild(d);
      xCursor = -SCORE_DIGIT_VISUAL_WIDTH[0];
      d.x = -xCursor;
    } else {
      while (v > 0) {
        const digit = v % 10;
        const idx = clamp(digit, 0, SCORE_DIGIT_FRAMES - 1); // assumes frames 1..10 = 0..9
        const d = makeSprite(link[idx]);
        this.digits.push(d);
        this.view.addChild(d);
        xCursor -= SCORE_DIGIT_VISUAL_WIDTH[digit];
        d.x = xCursor;
        v = (v / 10) | 0;
      }
    }

    // Horizontal alignment.
    const halfW = Math.abs(xCursor / 2);
    for (const d of this.digits) {
      d.x += halfW;
    }
    const hw = (halfW * this.maxSize) / 100;
    if (this.view.x - hw < 10) this.view.x = 10 + hw;
    if (this.view.x + hw > 290) this.view.x = 290 - hw;

    if (this.digits.length > 0) {
      const hh = this.digits[0].height / 2;
      for (const d of this.digits) {
        d.y -= hh;
      }
    }
  }

  private tick(): void {
    if (this.pphase) {
      this.ptime -= DELTA_T;
      if (this.ptime < 0) {
        this.xphase = true;
        this.yphase = true;
        this.pphase = false;
      } else {
        return;
      }
    }

    if (this.xphase) this.xtime += DELTA_T * this.xspeed;
    if (this.yphase) this.ytime += DELTA_T * this.yspeed;

    this.view.scale.set((this.xtime * this.maxSize) / 100, (this.ytime * this.maxSize) / 100);

    if (this.ptime > 0) {
      if (this.xphase && this.xtime > 1) {
        this.xphase = false;
        if (!this.yphase) this.pphase = true;
        this.xspeed *= -1;
      }
      if (this.yphase && this.ytime > 1) {
        this.yphase = false;
        if (!this.xphase) this.pphase = true;
        this.yspeed *= -1;
      }
    }

    if ((this.xspeed < 0 && this.xtime <= 0.3) || (this.yspeed < 0 && this.ytime <= 0.3)) {
      this.game.removeUpdate(this.update);
      this.view.removeFromParent();
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Main game shell
// -------------------------------------------------------------------------------------------------

class MandaGame {
  app: Application;
  assets: MandaAssets;
  host: GameHost;

  // Layers (mirroring the depth planes from Const.mt; jackpot HUD is its own container).
  worldLayer = new Container();
  fruitShadeLayer = new Container(); // PLAN_FRUITS_SHADE
  snakeLayer = new Container(); // PLAN_SNAKE
  fruitLayer = new Container(); // PLAN_FRUITS
  particleLayer = new Container(); // PLAN_PARTICULES
  popScoreLayer = new Container(); // PLAN_POPSCORE inside dmanager (world)
  hudLayer = new Container();
  // PLAN_POPSCORE inside `interf` in the original — used by jackpot payouts so they
  // appear above the HUD instead of being clipped by the world mask.
  hudPopScoreLayer = new Container();

  snake: Snake;
  level: Level;
  jackpot: Jackpot;

  // Update callbacks (Manager.updates equivalent).
  private updates: UpdateFn[] = [];

  // Game-level state.
  fcounter = 0;
  fbarre = 0;
  nfruits = 0;
  score = 0;
  game_over_flag = false;
  runSubmitted = false;
  fcloche: UpdateFn | null = null;

  // Input.
  keys = new Set<string>();

  // HUD elements.
  scoreText: Text;
  gameOverText: Text;

  constructor(app: Application, assets: MandaAssets, host: GameHost) {
    this.app = app;
    this.assets = assets;
    this.host = host;

    const bg = makeSprite(assets.bg);
    app.stage.addChild(bg, this.worldLayer, this.hudLayer);

    // Mask the world to the play area (assets.bgMask, top-left at (5,5) in original).
    const maskSprite = makeSprite(assets.bgMask);
    maskSprite.x = 5;
    maskSprite.y = 5;
    this.worldLayer.addChild(maskSprite);
    this.worldLayer.mask = maskSprite;

    this.worldLayer.addChild(this.fruitShadeLayer, this.snakeLayer, this.fruitLayer, this.particleLayer, this.popScoreLayer);

    this.level = new Level(this);
    this.jackpot = new Jackpot(this);
    // Original Game.mt: `new Snake(dmanager, { x : 0, y : 0 })` — snake spawns at the
    // top-left of the world MC and slithers in along PI/4. Spawning at the centre
    // hides the original's "enter from corner" feel.
    this.snake = new Snake(this, this.snakeLayer, { x: 0, y: 0 });
    this.snake.ang = Math.PI / 4;

    this.scoreText = new Text({
      text: '0',
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 12,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    this.scoreText.position.set(8, 6);
    this.hudLayer.addChild(this.scoreText);

    this.gameOverText = new Text({
      text: '',
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 24,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 4 },
      },
    });
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(STAGE_WIDTH / 2, 140);
    this.hudLayer.addChild(this.gameOverText);

    // No fbarre HUD bar: the original Game.mt has no in-game widget for fbarre — it is
    // a purely internal field driving Level.generateFruit's difficulty ramp. Earlier
    // rounds carried a port-only placeholder bar; pass 14 removed it to converge with
    // source.
    this.hudLayer.addChild(this.hudPopScoreLayer);
    this.host.updateScore(0);
  }

  addScore(value: number): void {
    this.score += value;
    this.scoreText.text = String(this.score);
    this.host.updateScore(this.score);
  }

  addUpdate(fn: UpdateFn): void {
    this.updates.push(fn);
  }

  removeUpdate(fn: UpdateFn): void {
    const i = this.updates.indexOf(fn);
    if (i >= 0) this.updates.splice(i, 1);
  }

  spawnPopScore(x: number, y: number, value: number): void {
    new PopScore(this, x, y, value, this.popScoreLayer);
  }

  // Mirrors Game.interf.empty(PLAN_POPSCORE) in the original: jackpot payouts pop above the HUD.
  spawnHudPopScore(x: number, y: number, value: number): void {
    new PopScore(this, x, y, value, this.hudPopScoreLayer);
  }

  // Game.eatFruit() port.
  eatFruit(f: Fruit): boolean {
    if (f.isMoving()) return false;
    const pts = f.points();
    this.spawnPopScore(f.view.x, f.view.y, pts);
    this.jackpot.addFruit(f.id);
    if (f.add_queue) this.snake.addQueue();
    f.destroy();
    this.nfruits += 1;
    this.addScore(pts);
    this.fbarre = Math.min(FBARRE_MAX, this.fbarre + FBARRE_FRUIT_EAT);
    return true;
  }

  // Run-once-per-fixed-step.
  step(): void {
    this.fcounter += 1;
    if (this.game_over_flag) {
      this.gameOverMain();
    } else {
      this.gameMain();
    }
    // Manager.updates dispatch (clone to allow mid-iteration removal).
    const snapshot = this.updates.slice();
    for (const u of snapshot) {
      u();
    }
  }

  private gameMain(): void {
    const turnScale = Math.pow(this.snake.speed / SNAKE_DEFAULT_SPEED, 0.5);
    if (this.keys.has('ArrowLeft')) {
      this.snake.ang -= this.snake.delta_ang * turnScale * TMOD;
    }
    if (this.keys.has('ArrowRight')) {
      this.snake.ang += this.snake.delta_ang * turnScale * TMOD;
    }

    this.snake.base_speed *= Math.pow(FRICTION, TMOD);
    if (this.keys.has('ArrowUp')) {
      this.snake.base_speed = SNAKE_FAST_SPEED_COEF;
    }
    if (this.snake.base_speed < 1) this.snake.base_speed = 1;

    if (this.fcloche !== null) {
      this.fcloche();
    }

    const hit = this.snake.move(LEVEL_BOUNDS);
    if (hit) {
      this.game_over_flag = true;
    }

    this.snake.speed += SNAKE_SPEED_INCREMENT * TMOD;
    this.level.main();
    this.jackpot.main();
    this.snake.draw();
  }

  private gameOverMain(): void {
    if (this.snake.len >= 0) {
      let timer = 4;
      if (this.snake.len > 10) timer = 3;
      if (this.snake.len > 50) timer = 2;
      if (this.snake.len > 100) timer = 1;
      const denom = Math.max(1, (timer / TMOD) | 0);
      if (this.fcounter % denom === 0) {
        this.snake.explode(this.snake.getColor());
      }
      this.snake.draw();
      if (this.snake.len < 0) {
        this.snake.tete.visible = false;
      }
    } else {
      this.snake.tete.visible = false;
    }
    this.level.main();
    if (this.gameOverText.text === '') {
      this.gameOverText.text = 'GAME OVER';
      if (!this.runSubmitted) {
        this.runSubmitted = true;
        this.host.endRun({ score: this.score });
      }
    }
  }

}

// -------------------------------------------------------------------------------------------------
// Module entry point
// -------------------------------------------------------------------------------------------------

export async function mount(container: HTMLElement, context?: GameMountContext): Promise<GameInstance> {
  const app = new Application();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      background: '#000000',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    }),
    loadAssets(),
  ]);
  container.appendChild(app.canvas);

  // Reset transient global Bonus counters per mount so multiple plays start fresh.
  Bonus.ciseauxCount = 1;
  Bonus.potionBleues = 0;

  const game = new MandaGame(app, assets, context?.host ?? noopGameHost);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      game.keys.add(event.key);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      game.keys.delete(event.key);
    }
  };
  // Drop held keys on focus loss — without this, holding ArrowUp (boost)
  // and tabbing away leaves the snake stuck at full speed indefinitely.
  const onBlur = () => {
    game.keys.clear();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  let acc = 0;
  const tickerCallback = (ticker: Ticker) => {
    acc += Math.min(ticker.deltaMS / 1000, 0.1);
    let guard = 0;
    while (acc >= STEP_SECONDS && guard < 5) {
      game.step();
      acc -= STEP_SECONDS;
      guard += 1;
    }
  };
  app.ticker.add(tickerCallback);

  return {
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      app.ticker.remove(tickerCallback);
      // texture:false — textures are managed by Assets; destroying them emits
      // a per-texture warning each mount and forces a re-fetch on the next
      // mount. Manda has no off-tree GPU resources (no filters, no
      // RenderTextures), so no game.destroy() needed.
      app.destroy(true, { children: true, texture: false });
    },
  };
}
