import { Application, ColorMatrixFilter, Container, Graphics, Sprite, Text, Ticker } from 'pixi.js';
import type { GameInstance } from '../types';
import { type Frame, loadFrame, loadSeries, makeSprite, setFrame } from '../_shared/frames';

// -------------------------------------------------------------------------------------------------
// Stage and timing
// -------------------------------------------------------------------------------------------------
//
// The original SWF header is 40 FPS. The source drives motion via Timer.tmod /
// Timer.deltaT; we run a fixed-step accumulator and feed every fixed step a
// nominal `tmod` of 1.0 plus DELTA_T = STEP_SECONDS so per-step physics matches
// the original constants.
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 320;
const FPS = 40;
const STEP_SECONDS = 1 / FPS;
const TMOD = 1; // each fixed step counts as one frame at the target FPS
const DELTA_T = STEP_SECONDS; // seconds elapsed per fixed step

// The original game SWF renders into the top 300 px; KadoKado's loader overlays
// a 20 px score strip below it inside the 300x320 embed.
const SCORE_BAR_Y = 300;
const SCORE_DIGITS = 7;
const SCORE_DIGIT_X = 178;
const SCORE_DIGIT_Y = 302;
const SCORE_DIGIT_STEP = 17;
const SCORE_DIGIT_WIDTH = 15;
const SCORE_DIGIT_HEIGHT = 17;

const ASSET_ROOT = '/assets/killbulle';

// -------------------------------------------------------------------------------------------------
// Const.mt
// -------------------------------------------------------------------------------------------------
const WIDTH = 450; // playfield width — note: stage is 300 wide so we scroll horizontally
const MINY = 290;
const BLOB_PROBAS = 3000;
const BONUS_START_LEVEL = 10;
const BONUS_PROBAS = [500, 100, 10, 30, 50]; // none, time, super-grapin, shuriken, points
const C20 = 20; // KKApi.const(20)
const C5000 = 5000; // KKApi.const(5000)

// View window (camera "lens") — Game.mt clamps `root._x = -clamp(camera_x - 150, 0, WIDTH-300)`,
// so the visible window is 300 px wide of a 450-wide world.
const VIEW_WIDTH = 300;
const CAMERA_HALF = VIEW_WIDTH / 2; // = 150 — the offset Game.mt subtracts from camera_x

// Asset frame counts (verified in killbulle-assets.md).
const HERO_FRAME_COUNT = 7;
const BLOB_FRAME_COUNT = 18;
const CORDE_FRAME_COUNT = 7;
const GRAPIN_FRAME_COUNT = 2;
const BONUS_FRAME_COUNT = 4;
const BONUS_REEL_FRAME_COUNT = 30;
const EXPLOSION_FRAME_COUNT = 13;
// Death sub-clip ("fall") — DefineSprite_116 in the SWF, exported to
// `public/assets/killbulle/fall/` as 14 PNGs. The other hero sub-clips are
// loaded from their extracted reels below.
const DEATH_REEL_FRAME_COUNT = 14;

// Bonus IDs (post-decrement of bid in genBlob — bid=0 means no bonus).
const BONUS_TIME = 0;
const BONUS_SUPER_GRAPIN = 1;
const BONUS_SHURIKEN = 2;
const BONUS_POINTS = 3;

// Hero "frames" map MovieClip frame numbers from Hero.mt. The original
// `mc.gotoAndStop("N")` selects a top-level frame containing a sub-MovieClip
// animation reel; Hero.update resolves the matching extracted reel at runtime.
const enum HeroFrame {
  Idle = 1, // mc.gotoAndStop("1")
  Walking = 2, // mc.gotoAndStop("2")
  PostGrapple = 3, // mc.gotoAndStop("3")
  Grappling = 4, // mc.gotoAndStop("4")
  Special = 6, // mc.gotoAndStop("6") — shuriken activation
  Death = 7, // mc.gotoAndStop("7")
}

// Hero atlas pivots: the exported PNGs are full SWF-stage renders (464x308) with
// the hero drawn at a fixed in-canvas position. Set the pivot to the character's
// feet-center so logical (hero.x, hero.y) anchors the feet on the ground line
// (Hero.update y-target is MINY = 290; source's mc._x/_y are written directly).
//
// Pivot derived by scanning the alpha bbox of every alive frame (1, 2, 3, 4, 6):
// content x-center ≈ 230, foot-bottom y ≈ 291. Frame-1 idle bbox = (207, 246, 254, 291),
// width 47, height 45. (Earlier eyeball value 232,298 placed feet 7 px above the
// ground line — measurable visual lift.)
const HERO_PIVOT_X = 231;
const HERO_PIVOT_Y = 291;
// Hero.mt hit(): hy = this.y - mc._height/3. Source `_height` is the world-space
// extent of the hero MovieClip at its current frame. Our static atlas frames for
// alive states (idle/walk/grapple/post-grapple/special) measure 45 px tall in
// the alpha bbox; we don't have the sub-clip animation reel that the source
// overlays, so 45 is the visible height we render. The previous 30 underestimated
// the hit-center lift by 5 px (= ~13 % of a typical blob radius), so blobs grazing
// the hero's HEAD would miss the kill check and drift through the chest.
const HERO_HEIGHT_APPROX = 45;

// Death "fall" reel pivots — the 14 PNGs are tight 40×40 crops of
// DefineSprite_116 at each frame, with the in-canvas content position
// preserving the timeline's squash-and-stretch motion (scaleX/scaleY oscillate
// while translation stays fixed at (-4.4, -0.2) px in SWF coords). Bbox-center
// scan across all 14 frames clusters around (20.6, 20.4) with x sweeping
// 20.0..21.5 and y sweeping 20.0..21.0 — that drift IS the bounce, so we don't
// average it out; we pivot at canvas-center (20, 20) and let the per-frame
// content offset render the squash visually. Source places the fall sub-clip
// at (+4.8, +1.25) px from the hero MC origin; that sub-pixel hero-local
// nudge is rolled into the canvas-center pivot here as too small to matter
// against the killer-blob ride amplitude (b.dx = ±2 px/tick, dy = -10 launch).
const DEATH_PIVOT_X = 20;
const DEATH_PIVOT_Y = 20;

// R21 — the other 5 hero state reels (idle/walk/post-grapple/grapple/special),
// extracted from anonymous DefineSprite_{129,141,153,161,165} into
// public/assets/killbulle/{idle,walk,post,grapple,special}/. Each canvas size
// differs (FFDec exports tight bboxes for sub-clips with no parent placement
// context), so each reel needs its own pivot. Pivots derived by foot-baseline
// scan across all frames per reel (bbox bottom min/max stable to ±1 px,
// content-center x avg). Anchor matches the existing hero atlas (231, 291) on
// 464×308 — the tight crops just shift the foot-anchor to canvas-local coords.
//   • idle (DefineSprite_129, 50×46): foot bottom y=46, x-center 25 → (25, 46)
//   • walk (DefineSprite_141, 56×52): foot bottom 49.5 avg, x-center 23 → (24, 50)
//   • post (DefineSprite_153, 63×50): foot bottom 47.4 avg, x-center 27 → (27, 48)
//   • grapple (DefineSprite_161, 61×138): tall canvas (rope extends UP to top of
//     canvas), character body at bottom; foot bottom 136 avg, x-center 31 → (31, 136)
//   • special (DefineSprite_165, 464×294): full SWF stage render (matches the
//     existing hero atlas geometry), foot at (231, 291) — same as hero/6.png
const IDLE_PIVOT_X = 25;
const IDLE_PIVOT_Y = 46;
const WALK_PIVOT_X = 24;
const WALK_PIVOT_Y = 50;
const POST_PIVOT_X = 27;
const POST_PIVOT_Y = 48;
const GRAPPLE_PIVOT_X = 31;
const GRAPPLE_PIVOT_Y = 136;
const SPECIAL_PIVOT_X = 231;
const SPECIAL_PIVOT_Y = 291;

// Bonus parent clip frames stop on id+1, but every frame contains one or more
// nested MovieClips that keep auto-playing. These pivots anchor the exported
// child reels back to their parent-frame registration points.
const BONUS_TIME_PIVOT_X = 29;
const BONUS_TIME_PIVOT_Y = 28.15;
const BONUS_SUPER_PIVOT_X = 23.95;
const BONUS_SUPER_PIVOT_Y = 20.4;
const BONUS_SHURIKEN_PIVOT_X = 14.5;
const BONUS_SHURIKEN_PIVOT_Y = 8;
const BONUS_POINTS_PIVOT_X = 29.9;
const BONUS_POINTS_PIVOT_Y = 24.85;

// Explosion atlas pivots (full SWF-stage renders, 464x374). Pivot is the source
// MovieClip's registration point — i.e. the spot that ends up at the spawn
// coordinate. We derive it from the bbox center of frame 1 / 13 (the puff frames
// where the burst is at its smallest, hugging the registration point): both
// center at (235, 142). Mid-frames expand outward symmetrically around this
// point, confirming it's the registration anchor. Earlier eyeball value
// (200, 130) put the burst centre +35 px right and +12 px down from the kill
// site — at blob size 150 (1.5× scale) that's a 52×18 px screen-space offset,
// the most visible pivot artifact in the port.
const EXPLOSION_PIVOT_X = 235;
const EXPLOSION_PIVOT_Y = 142;

// Grapin spawn baseline (Grapin.mt: BASEY = MINY - 30).
const GRAPIN_BASEY = MINY - 30;

// -------------------------------------------------------------------------------------------------
// Asset loading
// -------------------------------------------------------------------------------------------------

type KillbulleAssets = {
  bg: Frame;
  bg2: Frame;
  hero: Frame[];
  idle: Frame[];
  walk: Frame[];
  post: Frame[];
  grapple: Frame[];
  special: Frame[];
  death: Frame[];
  blob: Frame[];
  corde: Frame[];
  grapin: Frame[];
  bonusReels: Frame[][];
  explosion: Frame[];
};

async function loadAssets(): Promise<KillbulleAssets> {
  const [
    bg,
    bg2,
    hero,
    idle,
    walk,
    post,
    grapple,
    special,
    death,
    blob,
    corde,
    grapin,
    bonusTime,
    bonusSuper,
    bonusShuriken,
    bonusPoints,
    explosion,
  ] = await Promise.all([
    loadFrame(`${ASSET_ROOT}/bg.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/bg2.png`, 0, 0),
    loadSeries(`${ASSET_ROOT}/hero`, HERO_FRAME_COUNT, HERO_PIVOT_X, HERO_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/idle`, Hero.SUB_TOTAL_IDLE, IDLE_PIVOT_X, IDLE_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/walk`, Hero.SUB_TOTAL_WALKING, WALK_PIVOT_X, WALK_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/post`, Hero.SUB_TOTAL_POST_GRAPPLE, POST_PIVOT_X, POST_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/grapple`, Hero.SUB_TOTAL_GRAPPLING, GRAPPLE_PIVOT_X, GRAPPLE_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/special`, Hero.SUB_TOTAL_SPECIAL, SPECIAL_PIVOT_X, SPECIAL_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/fall`, DEATH_REEL_FRAME_COUNT, DEATH_PIVOT_X, DEATH_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/blob`, BLOB_FRAME_COUNT, 52, 56), // tight crop ~ 105x113 → centered
    loadSeries(`${ASSET_ROOT}/corde`, CORDE_FRAME_COUNT, 3, 0), // 6x28 segment, anchor top-center
    loadSeries(`${ASSET_ROOT}/grapin`, GRAPIN_FRAME_COUNT, 7, 0), // 15x49, anchor top-center
    loadSeries(`${ASSET_ROOT}/bonus-time`, BONUS_REEL_FRAME_COUNT, BONUS_TIME_PIVOT_X, BONUS_TIME_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/bonus-super`, BONUS_REEL_FRAME_COUNT, BONUS_SUPER_PIVOT_X, BONUS_SUPER_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/bonus-shuriken`, BONUS_REEL_FRAME_COUNT, BONUS_SHURIKEN_PIVOT_X, BONUS_SHURIKEN_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/bonus-points`, BONUS_REEL_FRAME_COUNT, BONUS_POINTS_PIVOT_X, BONUS_POINTS_PIVOT_Y),
    loadSeries(`${ASSET_ROOT}/anim-explose`, EXPLOSION_FRAME_COUNT, EXPLOSION_PIVOT_X, EXPLOSION_PIVOT_Y),
  ]);
  const bonusReels = [bonusTime, bonusSuper, bonusShuriken, bonusPoints];
  return { bg, bg2, hero, idle, walk, post, grapple, special, death, blob, corde, grapin, bonusReels, explosion };
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function randomInt(max: number): number {
  if (max <= 1) {
    return 0;
  }
  return Math.floor(Math.random() * max);
}

// Tools.randomProbas: weighted-random returning index 0..weights.length-1.
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

// Blob/explosion colour transform — Flash `Color.setTransform({ra,rb,ga,gb,ba,bb,aa,ab})`
// where each output channel = channel*(a/100) + b/255. Both Blob.setColor (on the live blob)
// and Hero.hit / Blob.hit (on the spawned explosion) use the same per-bonus-state tables.
//
// We cache the two filter instances per game so every blob/explosion shares the same two
// `ColorMatrixFilter` GPU bindings. Allocating a fresh filter per call (the previous
// approach) leaked one shader pipeline binding per spawn — the parent app.destroy(true,
// {children, texture}) doesn't dispatch Filter.destroy on filters attached to children
// (it only walks the display tree). The shared instances are destroyed in
// KillbulleGame.destroy().
function buildBlobColorFilter(hasBonus: boolean): ColorMatrixFilter {
  const t = hasBonus
    ? { ra: 82, rb: 150, ga: 86, gb: 10, ba: 52, bb: -51, aa: 100, ab: 0 }
    : { ra: 82, rb: 40, ga: 86, gb: 30, ba: 52, bb: -51, aa: 100, ab: 0 };
  const filter = new ColorMatrixFilter();
  // 4x5 matrix rows: [Rmul,_,_,_,Roff, _,Gmul,_,_,Goff, _,_,Bmul,_,Boff, _,_,_,Amul,Aoff].
  filter.matrix = [
    t.ra / 100, 0, 0, 0, t.rb / 255,
    0, t.ga / 100, 0, 0, t.gb / 255,
    0, 0, t.ba / 100, 0, t.bb / 255,
    0, 0, 0, t.aa / 100, t.ab / 255,
  ];
  return filter;
}

type UpdateFn = () => boolean;

// -------------------------------------------------------------------------------------------------
// Hero
// -------------------------------------------------------------------------------------------------

class Hero {
  game: KillbulleGame;
  view: Sprite;

  // Hero.mt fields.
  grapin: Grapin | null = null;
  died = false;
  x = 0;
  y = 0;
  dx = 0;
  dy = 0;
  frame = 0;
  moving = false;
  acc = 0;
  dir: -1 | 1 = 1;
  lock = false;
  super_grapin_time = 0;
  death_timer = 0;
  // Hero.mt's hit() does `b.bonus = Std.cast(this)` after killing the blob. Since
  // Blob.update() unconditionally writes `bonus.mc._x = x; bonus.mc._y = y` every
  // tick, this aliases the blob's "carry-on" target onto the hero — so the hero
  // MC is pinned to the (now size-50) bouncing blob for the 1.5 s death timer.
  // We can't replicate the type-pun in TS, so we keep an explicit reference and
  // copy the killer blob's position into our view in render().
  killer: Blob | null = null;

  // mc._currentframe equivalent (see HeroFrame enum).
  currentFrame: HeroFrame = HeroFrame.Idle;
  // sub-clip total frames — R19 FFDec dump of `gfx.swf` (chid 166 hero) reveals each
  // top-level frame contains a `sub` MovieClip pointing at a different child sprite,
  // and the per-state sub-clip frame counts are: idle=DefineSprite_129 (26 frames),
  // walking=DefineSprite_141 (20), post-grapple=DefineSprite_153 (18),
  // grappling=DefineSprite_161 (21), special=DefineSprite_165 (12),
  // death=DefineSprite_116 ("fall", 14). R1-R15 had assumed `mc.sub` was missing
  // from the SWF (asset gap) and used a single tentative `SUB_TOTAL_FRAMES = 8`
  // for both the walk-cycle wrap AND the post-grapple unlock check — that was
  // wrong on two counts. (1) The wrap formula in Hero.mt:90-91 is a state-gated
  // `frame -= (mc.sub._totalframes - 4)`, applied only while currentFrame == 2
  // (walking), which for the 20-frame walk reel becomes `frame -= 16` — not the
  // R14-claimed "true modulo" (`frame -= mc.sub._totalframes`). The difference
  // is invisible for our 2-pose proxy (both give the same `floor(frame/4)%2`
  // alternation in steady state) but the source citation in R14 was wrong.
  // (2) The post-grapple unlock check `mc._currentframe >= 3 && frame >=
  // mc.sub._totalframes` (Hero.mt:158) tests against the CURRENT state's
  // sub-clip total, not a fixed 8. PostGrapple unlock should fire after 18 ticks
  // (~0.45 s at 40 FPS), not 8 (~0.20 s). Special after 12 (~0.30 s), not 8.
  // Grappling state holds the lock implicitly via the `grapin != null` guard
  // until the rope completes; once null, the unlock check fires at 21 ticks.
  // R19 ports the per-state totals so timing matches source.
  static readonly SUB_TOTAL_IDLE = 26; // DefineSprite_129
  static readonly SUB_TOTAL_WALKING = 20; // DefineSprite_141
  static readonly SUB_TOTAL_POST_GRAPPLE = 18; // DefineSprite_153
  static readonly SUB_TOTAL_GRAPPLING = 21; // DefineSprite_161
  static readonly SUB_TOTAL_SPECIAL = 12; // DefineSprite_165
  static readonly SUB_TOTAL_DEATH = 14; // DefineSprite_116 "fall"

  // Returns the active state's sub-clip total frame count — the value source's
  // `mc.sub._totalframes` would resolve to at runtime given the current
  // `mc._currentframe`.
  private subTotalFrames(): number {
    switch (this.currentFrame) {
      case HeroFrame.Idle:
        return Hero.SUB_TOTAL_IDLE;
      case HeroFrame.Walking:
        return Hero.SUB_TOTAL_WALKING;
      case HeroFrame.PostGrapple:
        return Hero.SUB_TOTAL_POST_GRAPPLE;
      case HeroFrame.Grappling:
        return Hero.SUB_TOTAL_GRAPPLING;
      case HeroFrame.Special:
        return Hero.SUB_TOTAL_SPECIAL;
      case HeroFrame.Death:
        return Hero.SUB_TOTAL_DEATH;
      default:
        return Hero.SUB_TOTAL_WALKING;
    }
  }

  constructor(g: KillbulleGame) {
    this.game = g;
    this.view = makeSprite(g.assets.hero[0]);
    g.heroLayer.addChild(this.view);
    this.x = WIDTH / 2;
    this.y = MINY;
    this.gotoAndStop(HeroFrame.Idle);
  }

  destroy(): void {
    this.view.removeFromParent();
  }

  // Equivalent of mc.gotoAndStop("N").
  gotoAndStop(frame: HeroFrame): void {
    this.currentFrame = frame;
  }

  kill(): void {
    this.dy = -10;
    this.dx = this.x < WIDTH / 2 ? 2 : -2;
    this.died = true;
    this.death_timer = 1.5;
    this.frame = 0;
    this.gotoAndStop(HeroFrame.Death);
  }

  // Hero.mt hit(): scan blobs, register death on overlap.
  hit(): void {
    const hx = this.x;
    const hy = this.y - HERO_HEIGHT_APPROX / 3;
    const r = 8;
    const blobs = this.game.blobs;
    for (let i = 0; i < blobs.length; i += 1) {
      const b = blobs[i];
      const ddx = b.x - hx;
      const ddy = b.y - hy;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d < b.size / 2.4 + r) {
        this.x = b.x;
        this.y = b.y;
        this.kill();
        // Hero.mt: shrink blob to size 50 and play its color in an explosion.
        b.size = 50;
        b.applyVisualScale();
        this.game.spawnExplosion(b.x, b.y, 50, b);
        // Hero.mt: `b.bonus.mc.removeMovieClip(); b.bonus = Std.cast(this);` —
        // the blob's bonus pointer is replaced with the hero (type-cast). Since
        // Blob.update unconditionally pokes `bonus.mc._x/_y`, the hero MC then
        // tracks the bouncing blob until death_timer expires. We mirror that by
        // remembering the killer blob; render() copies its position when died.
        if (b.bonus !== null) {
          b.bonus.detach();
          b.bonus = null;
        }
        this.killer = b;
        break;
      }
    }
  }

  // Hero.mt special(): shuriken bonus activation.
  special(): void {
    this.frame = 0;
    this.gotoAndStop(HeroFrame.Special);
    this.moving = false;
    this.lock = true;
  }

  update(): void {
    if (this.super_grapin_time > 0) {
      this.super_grapin_time -= DELTA_T;
    }

    this.frame += TMOD;
    // Hero.mt:88-93 — the wrap is gated on `mc._currentframe == 2` (walking)
    // and rolls `frame -= (mc.sub._totalframes - 4)` so the value stays in
    // `[totalframes-4, totalframes)` after the first cycle. R19 confirmed the
    // walking sub-clip is `DefineSprite_141` (20 frames), so the wrap target
    // is `frame -= 16`. R14 had documented this as a "true modulo" — that was
    // a misreading of source; the formula is `-= (total - 4)`, not `-= total`.
    // For our 2-pose `floor(frame/4)%2` proxy the two formulas happen to
    // produce the same alternating cadence (4-tick segments toggle 0/1 either
    // way), so visual output is unchanged; only the source citation is fixed.
    if (this.currentFrame === HeroFrame.Walking) {
      const total = Hero.SUB_TOTAL_WALKING;
      if (this.frame >= total) {
        this.frame -= total - 4;
      }
    }

    // Grapple lifecycle.
    if (this.grapin !== null) {
      if (!this.grapin.update()) {
        this.grapin = null;
      }
    } else if (this.game.spaceHeld && !this.died && !this.lock) {
      const g = new Grapin(this.game);
      this.grapin = g;
      if (!g.update()) {
        this.grapin = null;
      }
      this.frame = 0;
      this.moving = false;
      this.gotoAndStop(HeroFrame.Grappling);
    }

    if (this.died) {
      if (this.death_timer > 0) {
        this.death_timer -= DELTA_T;
        if (this.death_timer <= 0) {
          this.game.gameOver();
        }
      }
      this.render();
      return;
    }

    if (!this.lock) {
      if (this.game.keys.has('ArrowLeft')) {
        if (!this.moving) {
          this.moving = true;
          this.frame = 0;
          this.gotoAndStop(HeroFrame.Walking);
        }
        this.dir = -1;
        if (this.acc > 0) this.acc = 0;
        this.acc -= 1 * TMOD;
        if (this.acc < -5) this.acc = -5;
      } else if (this.game.keys.has('ArrowRight')) {
        if (!this.moving) {
          this.moving = true;
          this.frame = 0;
          this.gotoAndStop(HeroFrame.Walking);
        }
        this.dir = 1;
        if (this.acc < 0) this.acc = 0;
        this.acc += 1 * TMOD;
        if (this.acc > 5) this.acc = 5;
      } else {
        this.acc *= Math.pow(0.8, TMOD);
        if (this.moving) {
          this.moving = false;
          this.frame = 0;
          this.gotoAndStop(HeroFrame.PostGrapple);
        }
      }
      this.x += this.acc * TMOD;
    }

    if (this.moving) {
      // stay in walking frame
    } else if (this.currentFrame === HeroFrame.Walking) {
      this.gotoAndStop(HeroFrame.Idle);
    } else if (this.currentFrame >= HeroFrame.PostGrapple && this.frame >= this.subTotalFrames()) {
      // Hero.mt:158 — `mc._currentframe >= 3 && frame >= mc.sub._totalframes`
      // unlocks and returns to idle. The threshold is the CURRENT state's
      // sub-clip total frame count, not a fixed value. R19 corrects the port
      // from a fixed 8-tick lock (~0.20 s) to per-state values measured from
      // the SWF: PostGrapple (chid 153) = 18 ticks (~0.45 s), Grappling
      // (chid 161) = 21 ticks (~0.53 s), Special (chid 165) = 12 ticks
      // (~0.30 s). Players were exiting post-grapple recovery 2.25× faster
      // than source.
      this.lock = false;
      this.acc = 0;
      this.gotoAndStop(HeroFrame.Idle);
    }

    if (this.x <= 30) this.x = 30;
    else if (this.x >= WIDTH - 20) this.x = WIDTH - 20;

    if (this.game.blob_timer <= 0) {
      this.hit();
    }

    this.render();
  }

  // Called by Game.main after blobs[].update() so the dead hero's view tracks
  // the killer blob's *current* (post-tick) position — matching source's
  // Blob.update writing `bonus.mc._x = x` after its own integration, with the
  // bonus pointer aliased to the hero via Std.cast.
  pinToKiller(): void {
    if (!this.died || this.killer === null) return;
    if (this.game.blobs.indexOf(this.killer) < 0) return;
    this.view.x = this.killer.x;
    this.view.y = this.killer.y;
  }

  private render(): void {
    // Hero.mt vertical bobbing: max(0, sin(x*PI/17)) * 3. The bob is suppressed
    // on death because Hero.update returns early before computing it; the dead
    // hero MC is left wherever Blob.update last placed it. Our `pinToKiller()`
    // step (called after blobs update) handles the carry-along; here we only
    // set up the initial position for tick T (which Blob.update will overwrite).
    if (this.died && this.killer !== null && this.game.blobs.indexOf(this.killer) >= 0) {
      this.view.x = this.killer.x;
      this.view.y = this.killer.y;
    } else {
      const bob = Math.max(0, Math.sin((this.x * Math.PI) / 17)) * 3;
      this.view.x = this.x;
      this.view.y = this.y - bob;
    }
    this.view.scale.x = this.dir;
    this.view.scale.y = 1;

    // R21 — Resolve which sub-clip reel to play and which frame to show.
    // Source's Hero.update calls `mc.sub.gotoAndStop(string(1+(int(frame) %
    // mc.sub._totalframes)))` every tick, where `mc.sub` resolves to the
    // sub-clip placed in the current top-level frame's PlaceObject2 (chid 129
    // for frame 1 idle / 141 walk / 153 post-grapple / 161 grappling /
    // 165 special / 116 fall — verified via FFDec swf2xml against
    // DefineSprite_166's frame timeline). All 6 sub-clip reels are now in
    // public/assets/killbulle/{idle,walk,post,grapple,special,fall}/ — R21
    // extracted the 5 anonymous reels (idle/walk/post/grapple/special) from
    // their DefineSprite_<n> folders in extracted-assets/ (which had been
    // sitting there since R1 but were not copied into public/ because they
    // lacked ExportAssets names). Death (fall) wired in R20.
    let reel: Frame[];
    switch (this.currentFrame) {
      case HeroFrame.Idle:
        reel = this.game.assets.idle;
        break;
      case HeroFrame.Walking:
        reel = this.game.assets.walk;
        break;
      case HeroFrame.PostGrapple:
        reel = this.game.assets.post;
        break;
      case HeroFrame.Grappling:
        reel = this.game.assets.grapple;
        break;
      case HeroFrame.Special:
        reel = this.game.assets.special;
        break;
      case HeroFrame.Death:
        reel = this.game.assets.death;
        break;
      default:
        reel = this.game.assets.idle;
        break;
    }
    const total = reel.length;
    const idx = total > 0 ? ((Math.floor(this.frame) % total) + total) % total : 0;
    setFrame(this.view, reel[idx]);
  }
}

// -------------------------------------------------------------------------------------------------
// Blob
// -------------------------------------------------------------------------------------------------

class Blob {
  game: KillbulleGame;
  view: Sprite;
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  size: number;
  dir: number;
  bonus: Bonus | null;
  // Animation phase for the 18-frame blob atlas — Blob.mt has no explicit
  // animation state; we cycle frames as a coarse "alive idle" loop.
  private animPhase = 0;

  constructor(g: KillbulleGame, size: number, b: Bonus | null) {
    this.game = g;
    this.bonus = b;
    this.size = size;
    this.speed = 5 + g.level / 20;
    this.y = -100;
    this.dx = 2.5;
    this.dy = 1;
    this.dir = randomInt(2) * 2 - 1;
    this.x = g.hero.x + this.dir * 50;

    this.view = makeSprite(g.assets.blob[0]);
    this.applyColor(false);
    g.blobLayer.addChild(this.view);
    this.applyVisualScale();

    if (this.bonus !== null) {
      this.bonus.attachTo(this);
      this.applyColor(true);
    }
  }

  destroy(): void {
    this.view.removeFromParent();
    if (this.bonus !== null) {
      this.bonus.detach();
      this.bonus = null;
    }
  }

  applyVisualScale(): void {
    // Blob.mt: mc._xscale = mc._yscale = size (size in 0..N units;
    // the source uses 50/100/150/... so dividing by 100 maps to scale).
    const s = this.size / 100;
    this.view.scale.set(s);
  }

  // Blob.mt setColor() ports verbatim via Pixi's ColorMatrixFilter, replicating
  // Flash's Color.setTransform({ra,rb,ga,gb,ba,bb,aa,ab}) which yields:
  //   out_channel = channel * (a/100) + (b/255)
  // (Flash a coefficients are 0..100 percent, b coefficients are -255..255 byte offsets.)
  applyColor(hasBonus: boolean): void {
    this.view.filters = [this.game.blobColorFilter(hasBonus)];
    this.view.tint = 0xffffff;
  }

  // Blob.mt hit(): explode and either split into halves or release bonus.
  // Returns the array of replacement blobs (empty if this blob fully dies / releases bonus).
  //
  // Tsize bookkeeping mirrors source exactly: source's `Blob.hit()` only writes
  // `game.tsize -= size` on the BONUS-release branch (Blob.mt:92). The split branch
  // pushes children to `game.blobs[]` WITHOUT touching tsize, and the small-no-bonus
  // branch silently does nothing. Net source quirks the port now reproduces:
  //   • 150-blob split → children are 100+100 (mass +50) but tsize stays the original
  //     150 — source's tsize is permanently 50-low after such a split.
  //   • size<25 no-bonus blob death → no tsize decrement; tsize is 50-high.
  // Earlier the port centralised tsize updates in `killBlob` (R1), which "corrected"
  // these source-side miscounts. Since the tsize value feeds the spawn-rate
  // formula `random(int((tsize/100)*(BLOB_PROBAS/sqrt(level))/tmod))`, the port's
  // accurate tsize led to slower spawning than the original; restoring source's
  // bookkeeping puts the spawn cadence back on the source's gameplay curve.
  hit(): Blob[] {
    this.game.spawnExplosion(this.x, this.y, this.size / 2, this);
    this.game.level += 1;

    const dsize = this.size === 150 ? 100 : this.size / 2;
    const replacements: Blob[] = [];

    if (this.size >= 25 && this.bonus === null) {
      const a = new Blob(this.game, dsize, null);
      a.x = this.x + this.size / 4;
      a.y = this.y;
      a.dy = -Math.abs(this.dy);
      a.dir = 1;
      a.update();
      replacements.push(a);

      const b = new Blob(this.game, dsize, null);
      b.x = this.x - this.size / 4;
      b.y = this.y;
      b.dy = -Math.abs(this.dy);
      b.dir = -1;
      b.update();
      replacements.push(b);
    } else if (this.bonus !== null) {
      // Release bonus (it falls under gravity until picked up). Source line 92
      // also decrements `game.tsize -= size` ONLY here.
      this.bonus.fall();
      this.bonus = null;
      this.game.tsize -= this.size;
    }
    // else: small blob with no bonus — vanishes silently (source would null-deref here).

    this.view.removeFromParent();
    return replacements;
  }

  update(): boolean {
    this.dy += 0.9 * TMOD;
    const s = (this.speed / 15) * TMOD;
    this.x += this.dir * this.dx * s;
    this.y += this.dy * s;

    if (this.y > MINY - this.size / 2) {
      this.y = MINY - this.size / 2;
      this.dy = -20 - Math.sqrt(this.size);
    }

    if (this.x < this.size / 2) {
      this.x = this.size - this.x;
      this.dir *= -1;
    } else if (this.x > WIDTH - this.size / 2) {
      this.x = WIDTH * 2 - this.size - this.x;
      this.dir *= -1;
    }

    // Flash MovieClips auto-play their timeline at the SWF FPS unless `stop()` is called;
    // Blob.mt never calls stop on the blob clip, so the 18-frame atlas advances at ~1 frame
    // per tick (40 FPS). Newly-attached clips display frame 1 before advancing; `genBlob()`
    // calls update() immediately after construction, so render the current phase before
    // ticking it forward.
    const frameIndex = Math.floor(this.animPhase) % this.game.assets.blob.length;
    setFrame(this.view, this.game.assets.blob[frameIndex]);
    this.animPhase += TMOD;

    if (this.bonus !== null) {
      this.bonus.followBlob(this.x, this.y);
    }
    this.view.x = this.x;
    this.view.y = this.y;
    return true;
  }
}

// -------------------------------------------------------------------------------------------------
// Bonus
// -------------------------------------------------------------------------------------------------

type BonusPart = {
  sprite: Sprite;
  frames: Frame[];
};

class Bonus {
  game: KillbulleGame;
  id: number;
  view: Container;
  x = 0;
  y = 0;
  dx = 0;
  dy = 0;
  falling = false;
  private alive = true;
  private animPhase = 0;
  private parts: BonusPart[] = [];

  constructor(g: KillbulleGame, id: number) {
    this.game = g;
    const safeId = clamp(id, 0, BONUS_FRAME_COUNT - 1);
    this.id = safeId;
    this.view = new Container();
    this.view.scale.set(0.5); // mc._xscale = 50 → 0.5
    this.buildView(safeId);
    g.bonusLayer.addChild(this.view);
    g.addUpdate(() => this.animate());
  }

  private addPart(frames: Frame[], x: number, y: number, scale = 1): void {
    const sprite = makeSprite(frames[0]);
    sprite.x = x;
    sprite.y = y;
    sprite.scale.set(scale);
    this.view.addChild(sprite);
    this.parts.push({ sprite, frames });
  }

  private buildView(id: number): void {
    switch (id) {
      case BONUS_TIME:
        // DefineSprite_29_bonus frame 1: child DefineSprite_11 at y=-137 twips.
        this.addPart(this.game.assets.bonusReels[BONUS_TIME], 0, -137 / 20);
        break;
      case BONUS_SUPER_GRAPIN:
        // Frame 2: child DefineSprite_16 at (-1,-12) twips.
        this.addPart(this.game.assets.bonusReels[BONUS_SUPER_GRAPIN], -1 / 20, -12 / 20);
        break;
      case BONUS_SHURIKEN: {
        // Frame 3: five copies of child DefineSprite_21, each with its own Flash matrix.
        const reel = this.game.assets.bonusReels[BONUS_SHURIKEN];
        this.addPart(reel, -179 / 20, -278 / 20, 0.7531891);
        this.addPart(reel, 334 / 20, -97 / 20, 0.6308594);
        this.addPart(reel, 39 / 20, -18 / 20, 0.7340851);
        this.addPart(reel, 117 / 20, 193 / 20, 0.7959595);
        this.addPart(reel, -364 / 20, 148 / 20, 0.5352936);
        break;
      }
      case BONUS_POINTS:
        // Frame 4: child DefineSprite_28 at (-2,-3) twips.
        this.addPart(this.game.assets.bonusReels[BONUS_POINTS], -2 / 20, -3 / 20);
        break;
      default:
        break;
    }
  }

  private animate(): boolean {
    if (!this.alive) {
      return false;
    }
    const frameIndex = Math.floor(this.animPhase) % BONUS_REEL_FRAME_COUNT;
    for (const part of this.parts) {
      setFrame(part.sprite, part.frames[frameIndex % part.frames.length]);
    }
    this.animPhase += TMOD;
    return true;
  }

  attachTo(blob: Blob): void {
    this.x = blob.x;
    this.y = blob.y;
    this.view.x = this.x;
    this.view.y = this.y;
  }

  followBlob(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.view.x = x;
    this.view.y = y;
  }

  detach(): void {
    this.alive = false;
    if (this.view.parent !== null) {
      this.view.removeFromParent();
    }
  }

  fall(): void {
    this.dx = 0;
    this.dy = 2;
    this.falling = true;
    this.game.addUpdate(() => this.update());
  }

  // Bonus.mt activate().
  activate(): void {
    switch (this.id) {
      case BONUS_TIME:
        this.game.flash(0x00ff00);
        this.game.blob_timer = 5;
        break;
      case BONUS_SUPER_GRAPIN:
        this.game.flash(0xff0000);
        this.game.hero.super_grapin_time = 20;
        break;
      case BONUS_SHURIKEN: {
        // Bonus.mt: hit() every blob in the array (snapshot first, since hit() removes them).
        const snapshot = this.game.blobs.slice();
        for (const b of snapshot) {
          this.game.killBlob(b);
        }
        this.game.flash(0x0000ff);
        this.game.hero.special();
        break;
      }
      case BONUS_POINTS:
        this.game.stats.b += 1;
        this.game.flash(0xffffff);
        this.game.addScore(C5000);
        break;
      default:
        break;
    }
  }

  // Bonus.mt update() — used as the falling-update callback after fall().
  update(): boolean {
    this.dy += 0.9 * TMOD;
    this.y += this.dy * TMOD;
    this.x += this.dx * TMOD;

    const my = MINY - 10;
    if (this.y > my) {
      this.y = my * 2 - this.y;
      this.dy *= -0.5;
      if (Math.abs(this.dy) < 1) {
        this.dy = 0;
        this.y = my;
      }
    }

    const ddx = this.x - this.game.hero.x;
    const ddy = this.y - this.game.hero.y;
    const d = Math.sqrt(ddx * ddx + ddy * ddy);
    if (d < 30 && !this.game.hero.died) {
      this.activate();
      this.detach();
      return false;
    }

    this.view.x = this.x;
    this.view.y = this.y;
    return true;
  }
}

// -------------------------------------------------------------------------------------------------
// Grapin (grapple)
// -------------------------------------------------------------------------------------------------

class Grapin {
  game: KillbulleGame;
  view: Sprite;
  cordes: Sprite[] = [];
  cordeYs: number[] = []; // remember each rope-segment's anchor y for fadeout
  cordePhases: number[] = []; // Flash auto-plays each rope MovieClip after attach
  x: number;
  y: number;
  speed: number;
  rot = false;
  superg = false;
  name: 'alive' | 'gone' = 'alive'; // mirror of Grapin.mt's mc._name "alive" check

  constructor(g: KillbulleGame) {
    this.game = g;
    this.superg = g.hero.super_grapin_time > 0;
    this.x = g.hero.x;
    this.y = GRAPIN_BASEY;
    this.speed = 8;

    this.view = makeSprite(g.assets.grapin[this.superg ? 1 : 0]);
    g.grapinLayer.addChild(this.view);
  }

  private animateCordes(): void {
    const frames = this.game.assets.corde;
    for (let i = 0; i < this.cordes.length; i += 1) {
      const idx = Math.floor(this.cordePhases[i]) % frames.length;
      setFrame(this.cordes[i], frames[idx]);
      this.cordePhases[i] += TMOD;
    }
  }

  // Grapin.mt destroyCordes(): rope fadeout + hook drift after a hit/escape.
  // Registered via game.addUpdate(); returns true while still alive.
  destroyCordes(): boolean {
    this.animateCordes();
    for (let i = 0; i < this.cordes.length; i += 1) {
      const c = this.cordes[i];
      c.alpha -= 0.1 * TMOD;
      if (c.alpha <= 0) {
        c.removeFromParent();
        this.cordes.splice(i, 1);
        this.cordeYs.splice(i, 1);
        this.cordePhases.splice(i, 1);
        i -= 1;
      }
    }

    this.speed *= Math.pow(1.05, TMOD);

    if (this.rot) {
      this.view.rotation += ((40 * TMOD) * Math.PI) / 180;
      this.view.x += (this.speed / 6) * TMOD;
      this.view.y += (Math.abs(this.speed) / 3) * TMOD;
      this.view.scale.x *= Math.pow(0.98, TMOD);
      this.view.scale.y = this.view.scale.x;
    } else {
      this.view.y -= this.speed * TMOD;
    }

    if (this.view.y > 320 || this.view.y < -20) {
      if (this.view.parent !== null) {
        this.view.removeFromParent();
      }
      this.name = 'gone';
    }

    return this.cordes.length > 0 || this.name === 'alive';
  }

  // Grapin.mt hits(): test against blobs; on hit register score, decide bounce/superg.
  // Returns true if the hook should stop (i.e. grapple cycle ends).
  hits(): boolean {
    if (this.game.hero.died) {
      return false;
    }

    const blobs = this.game.blobs;
    for (let i = 0; i < blobs.length; i += 1) {
      const b = blobs[i];
      const s = (b.size / 2) | 0;
      if (this.x >= b.x - s && this.x <= b.x + s && this.y <= b.y + s) {
        this.game.killBlob(b);
        this.rot = this.y >= b.y;
        if (this.rot) {
          // Grapin.mt: `dmanager.swap(mc, 1)` reparents the hook MovieClip to
          // depth 1, BELOW PLAN_CORDE=2 / PLAN_HERO=3 / PLAN_BLOB=4. We mirror
          // that by reparenting from `grapinLayer` to `grapinBackLayer` (the
          // depth-1 sibling at the bottom of `worldLayer`'s stack), so the
          // spinning hook renders behind ropes, hero, and blobs during its
          // fadeout — matching the source's "hook tucks under the playfield"
          // visual. Earlier rounds (R2) approximated this by reordering within
          // `grapinLayer`, which kept the hook in front of the blobs.
          if (this.view.parent !== this.game.grapinBackLayer) {
            this.game.grapinBackLayer.addChild(this.view);
          }
          if (randomInt(2) === 0) {
            this.speed *= -1;
          }
        }

        const pts = s * C20;
        this.game.stats.s += 1;
        this.game.stats.ts += pts;
        this.game.addScore(pts);

        if (this.superg) {
          this.speed = Math.abs(this.speed);
          this.rot = false;
          // Grapin.mt: `continue` → the for loop's `i++` advances past the
          // slot we just removed, so the blob originally at i+1 (which got
          // shifted into slot `i` by `game.blobs.remove(this)`) is SKIPPED.
          // That's a source-side quirk: super-grapin only pierces every other
          // blob in its column, not every one. Mirror it by letting the
          // natural for-loop increment fire (no `i = -1` rewind here).
          continue;
        }
        return true;
      }
    }
    return false;
  }

  // Grapin.mt update(): rise, render rope segments, test hits.
  update(): boolean {
    this.y -= this.speed * TMOD;

    const ncordes = 1 + (((GRAPIN_BASEY - this.y) / 25) | 0);
    for (let i = 0; i < ncordes; i += 1) {
      let c = this.cordes[i];
      if (c === undefined) {
        c = makeSprite(this.game.assets.corde[0]);
        const yAnchor = GRAPIN_BASEY - 25 * (i - 1);
        c.y = yAnchor;
        this.game.cordeLayer.addChild(c);
        this.cordes.push(c);
        this.cordeYs.push(yAnchor);
        this.cordePhases.push(0);
      }
      c.scale.y = 1; // _yscale = 100
      c.x = this.x;
    }
    this.animateCordes();

    // Stretch the topmost rope segment to span exactly to the hook.
    if (this.cordes.length > 0) {
      const last = this.cordes[this.cordes.length - 1];
      const lastY = this.cordeYs[this.cordeYs.length - 1];
      // _yscale = (last._y - y) * 4 → percentage * 4 → in TS, scale = (lastY - y) * 4 / 100.
      last.scale.y = ((lastY - this.y) * 4) / 100;
    }

    const hit = this.hits();

    this.view.x = this.x;
    this.view.y = this.y;

    if (this.y < -100 || hit) {
      if (this.y < -100 && this.view.parent !== null) {
        this.view.removeFromParent();
        this.name = 'gone';
      }
      this.game.addUpdate(() => this.destroyCordes());
      return false;
    }
    return true;
  }
}

// -------------------------------------------------------------------------------------------------
// Game
// -------------------------------------------------------------------------------------------------

type Stats = { b: number; s: number; ts: number };

class ScoreStrip {
  view = new Container();
  private readonly digits: Text[] = [];

  constructor() {
    const bar = new Graphics();
    bar.rect(0, SCORE_BAR_Y, STAGE_WIDTH, STAGE_HEIGHT - SCORE_BAR_Y).fill(0xcfe87e);
    bar.rect(0, SCORE_BAR_Y, STAGE_WIDTH, 2).fill(0xf0f8a5);
    bar.rect(0, STAGE_HEIGHT - 2, STAGE_WIDTH, 2).fill(0xb5d764);
    this.view.addChild(bar);

    for (let i = 0; i < SCORE_DIGITS; i += 1) {
      const x = SCORE_DIGIT_X + i * SCORE_DIGIT_STEP;
      const y = SCORE_DIGIT_Y;
      const capsule = new Graphics();
      capsule.roundRect(x, y, SCORE_DIGIT_WIDTH, SCORE_DIGIT_HEIGHT, 6).fill(0xffffff);
      capsule.roundRect(x + 1, y + 1, SCORE_DIGIT_WIDTH - 2, SCORE_DIGIT_HEIGHT - 2, 5).fill(0x7fefff);
      capsule.roundRect(x + 2, y + 2, SCORE_DIGIT_WIDTH - 4, SCORE_DIGIT_HEIGHT - 4, 5).fill(0x25bde1);
      capsule.roundRect(x + 3, y + 3, SCORE_DIGIT_WIDTH - 6, SCORE_DIGIT_HEIGHT - 6, 4).fill(0x1d9bd2);
      this.view.addChild(capsule);

      const digit = new Text({
        text: '0',
        style: {
          fontFamily: 'Arial, Helvetica, sans-serif',
          fontSize: 12,
          fontWeight: '900',
          fill: 0xffffff,
          stroke: { color: 0x2aa6d6, width: 1 },
        },
      });
      digit.anchor.set(0.5);
      digit.position.set(x + SCORE_DIGIT_WIDTH / 2, y + SCORE_DIGIT_HEIGHT / 2 + 0.5);
      this.digits.push(digit);
      this.view.addChild(digit);
    }
  }

  setScore(value: number): void {
    const safe = Math.max(0, Math.floor(value));
    const text = String(safe).slice(-SCORE_DIGITS).padStart(SCORE_DIGITS, '0');
    for (let i = 0; i < SCORE_DIGITS; i += 1) {
      this.digits[i].text = text[i];
    }
  }
}

class KillbulleGame {
  app: Application;
  assets: KillbulleAssets;

  // Layers mirror mt.DepthManager's plan model. In Flash, each plan is a
  // 1000-depth bucket and objects inside the same plan render by attach order.
  // PLAN_BLOB / PLAN_GRAPIN / PLAN_BONUS all equal 4, so they must share one
  // Container; separate PLAN-4 layers would force a static z-order the source
  // does not have.
  bgLayer = new Container(); // PLAN 0  (bg)
  worldLayer = new Container(); // hosts everything that scrolls horizontally
  // grapinBackLayer = depth 1 in source's `dmanager.swap(mc, 1)`: hooks reparent
  // here on bounce so the spinning hook renders BEHIND PLAN_CORDE (2), PLAN_HERO
  // (3), and PLAN_BLOB (4). Lives inside worldLayer so it scrolls with the
  // playfield.
  grapinBackLayer = new Container(); // depth 1 — bounced grapin hooks
  bg2Layer = new Container(); // PLAN 2  (bg2, attached before rope segments)
  cordeLayer = new Container(); // PLAN_CORDE (2) — inside world
  heroLayer = new Container(); // PLAN_HERO  (3)
  plan4Layer = new Container(); // PLAN_BLOB / PLAN_GRAPIN / PLAN_BONUS / explosions
  blobLayer = this.plan4Layer;
  grapinLayer = this.plan4Layer;
  bonusLayer = this.plan4Layer;
  effectsLayer = this.plan4Layer;
  hudLayer = new Container();

  hero: Hero;
  blobs: Blob[] = [];

  // Game state.
  level = 1;
  tsize = 0;
  blob_timer = 0;
  flash_timer = 0;
  flash_color = 0;
  camera_x = WIDTH / 2;
  stats: Stats = { b: 0, s: 0, ts: 0 };
  game_score = 0;
  game_over_flag = false;

  // Update queue (Game.updates equivalent).
  private updates: UpdateFn[] = [];

  // Input.
  keys = new Set<string>();
  spaceHeld = false;

  // Background sprites (cached for camera parallax).
  private bgSprite: Sprite;
  private bg2Sprite: Sprite;

  // Loader-style score strip. `stats.s` / `stats.b` remain internal KKApi stats
  // in source; the player only sees the bottom score display.
  scoreStrip: ScoreStrip;
  gameOverText: Text;

  // Flash overlay — solid-fill Graphics rect drawn over the game root with
  // additive blend, so it brightens the picture toward `flash_color` regardless
  // of underlying pixels. Replicates Game.mt's `Color.setTransform({ra=ga=ba=100,
  // rb/gb/bb = color_byte * d, …})` which is a strict additive transform on the
  // root MovieClip. The KadoKado score strip is loader UI, so it stays above the
  // flash just like the original. Earlier port used the bg texture as a tinted
  // plate, which gave a shaped multiplicative tint instead of a uniform additive
  // flash.
  private flashOverlay: Graphics;

  // Shared blob/explosion filter cache. Reused for every Blob.applyColor and
  // explosion spawn so we don't allocate (and leak) a fresh GPU pipeline on
  // every blob hit.
  private blobFilters: { plain: ColorMatrixFilter; bonus: ColorMatrixFilter } | null = null;

  blobColorFilter(hasBonus: boolean): ColorMatrixFilter {
    if (this.blobFilters === null) {
      this.blobFilters = {
        plain: buildBlobColorFilter(false),
        bonus: buildBlobColorFilter(true),
      };
    }
    return hasBonus ? this.blobFilters.bonus : this.blobFilters.plain;
  }

  constructor(app: Application, assets: KillbulleAssets) {
    this.app = app;
    this.assets = assets;

    // Build backgrounds. Source attaches both to the panned root MovieClip,
    // then only counter-pans `bg` with `bg._x = -root._x / 3`; `bg2` remains
    // at root-local x=0 and scrolls with the foreground.
    this.bgSprite = makeSprite(assets.bg);
    this.bgLayer.addChild(this.bgSprite);
    this.bg2Sprite = makeSprite(assets.bg2);
    this.bg2Layer.addChild(this.bg2Sprite);

    // Compose the panned root in source plan order:
    // PLAN 0 bg, PLAN 1 bounced hook, PLAN 2 bg2 then rope segments,
    // PLAN 3 hero, PLAN 4 blobs/grapins/bonuses/explosions by attach order.
    app.stage.addChild(this.worldLayer, this.hudLayer);
    this.worldLayer.addChild(this.bgLayer, this.grapinBackLayer, this.bg2Layer, this.cordeLayer, this.heroLayer, this.plan4Layer);

    // Flash overlay — solid white rect drawn over the entire stage with additive
    // blend so the tint+alpha combination produces an additive colour flash that
    // affects every pixel uniformly, like Flash's `Color.setTransform({ra=ga=ba=100,
    // rb=R*d, gb=G*d, bb=B*d})` on the root MovieClip.
    this.flashOverlay = new Graphics();
    this.flashOverlay.rect(0, 0, STAGE_WIDTH, STAGE_HEIGHT).fill({ color: 0xffffff, alpha: 1 });
    this.flashOverlay.blendMode = 'add';
    this.flashOverlay.tint = 0xffffff;
    this.flashOverlay.alpha = 0;
    app.stage.addChild(this.flashOverlay);
    // Re-add HUD on top of the flash overlay.
    app.stage.removeChild(this.hudLayer);
    app.stage.addChild(this.hudLayer);

    this.hero = new Hero(this);

    this.scoreStrip = new ScoreStrip();

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

    this.hudLayer.addChild(this.scoreStrip.view, this.gameOverText);

    this.updateHud();
  }

  addUpdate(fn: UpdateFn): void {
    this.updates.push(fn);
  }

  addScore(value: number): void {
    this.stats.ts += 0; // ts is shot-attributed; addScore mirrors KKApi.addScore which is global
    this.game_score += value;
    this.updateHud();
  }

  updateHud(): void {
    this.scoreStrip.setScore(this.game_score);
  }

  flash(color: number): void {
    this.flash_timer = 100;
    this.flash_color = color;
  }

  // Game.mt genBlob().
  genBlob(): void {
    const sizeRoll = randomProbas([100, this.level * 10, this.level]);
    let size = (sizeRoll + 1) * 50;
    const bid = randomProbas(BONUS_PROBAS);
    let bonus: Bonus | null = null;
    if (this.level >= BONUS_START_LEVEL && bid > 0) {
      bonus = new Bonus(this, bid - 1);
      size = 50;
    }
    const b = new Blob(this, size, bonus);
    if (b.update()) {
      this.tsize += size;
      this.blobs.push(b);
    } else {
      b.destroy();
    }
  }

  // Helper used by Grapin and Bonus(shuriken): kill a blob, replacing it
  // with whatever children/bonus-fall it produces in the global blobs[] array.
  //
  // Tsize is intentionally NOT updated here — source's `Blob.hit()` does
  // `game.blobs.remove(this)` followed by either spawning splits (no tsize change)
  // or `bonus.fall(); game.tsize -= size`. The bonus-path decrement now lives
  // inside `Blob.hit()` itself (matching Blob.mt:92), so this helper only
  // performs the splice + replacement push and lets `Blob.hit()` own the
  // (possibly stale) tsize accounting source uses.
  killBlob(b: Blob): void {
    const idx = this.blobs.indexOf(b);
    if (idx < 0) {
      return;
    }
    this.blobs.splice(idx, 1);
    const replacements = b.hit();
    for (const r of replacements) {
      this.blobs.push(r);
    }
  }

  spawnExplosion(x: number, y: number, scaleSize: number, src: Blob | Hero | null): void {
    const sprite = makeSprite(this.assets.explosion[0]);
    sprite.x = x;
    sprite.y = y;
    const s = scaleSize / 100;
    sprite.scale.set(s);
    // Source's `b.setColor(e)` (Blob.mt:65 and Hero.mt:66) tints the explosion clip
    // with the SAME per-channel `Color.setTransform` matrix used for the blob — so the
    // burst inherits the blob's purple/orange palette instead of rendering as the raw
    // (white) explosion sheet. Use the source blob's current bonus state to pick the
    // matrix; non-Blob sources (none today, but kept for parity with Hero.mt's signature)
    // fall through to the no-filter default.
    if (src instanceof Blob) {
      sprite.filters = [this.blobColorFilter(src.bonus !== null)];
    }
    this.effectsLayer.addChild(sprite);

    let frame = 0;
    let justSpawned = true;
    const update: UpdateFn = () => {
      // `animExplose` is a self-playing MovieClip in Flash. A newly attached
      // clip displays frame 1 for the render pass in which it was created;
      // our update queue is drained later in that same tick, so skip one queue
      // call to avoid starting every burst on frame 2.
      if (justSpawned) {
        justSpawned = false;
        return true;
      }
      frame += TMOD;
      const idx = Math.floor(frame);
      if (idx >= this.assets.explosion.length) {
        sprite.removeFromParent();
        return false;
      }
      setFrame(sprite, this.assets.explosion[idx]);
      return true;
    };
    this.addUpdate(update);
  }

  gameOver(): void {
    if (this.game_over_flag) return;
    this.game_over_flag = true;
    this.gameOverText.text = 'GAME OVER';
  }

  // Game.mt main().
  main(): void {
    if (this.blob_timer > 0) {
      this.blob_timer -= DELTA_T;
    }

    if (this.flash_timer > 0) {
      this.flash_timer -= 10 * TMOD;
      if (this.flash_timer <= 0) {
        this.flashOverlay.alpha = 0;
      } else {
        const d = this.flash_timer / 100;
        // Game.mt: ra=ga=ba=100, rb=R*d, gb=G*d, bb=B*d on the root Color.
        // That's a strict additive transform `out = pixel + flash_color*d`.
        // Replicate via a white rect tinted to flash_color (so the rect's RGB
        // is flash_color), alpha=d (so contribution is flash_color*d), with
        // additive blend so it adds rather than over-blends.
        this.flashOverlay.tint = this.flash_color;
        this.flashOverlay.alpha = d;
      }
    }

    // Spawn rate scales with total blob mass and inverse-sqrt(level).
    // Game.mt: Std.random(int((tsize/100) * (BLOB_PROBAS / sqrt(level)) / Timer.tmod)) == 0.
    // Single roll — the previous version double-rolled and made spawns ~quadratically rarer.
    // Std.random(0) in MTASC returns 0, which gives an always-true gate when tsize == 0,
    // so the first blob spawns immediately on a fresh level.
    const denomBase = Math.floor((this.tsize / 100) * (BLOB_PROBAS / Math.sqrt(this.level)) / TMOD);
    if (denomBase <= 0 || randomInt(denomBase) === 0) {
      this.genBlob();
    }

    this.hero.update();

    const p = Math.pow(0.9, TMOD);
    this.camera_x = this.camera_x * p + this.hero.x * (1 - p);

    const offset = -clamp(this.camera_x - CAMERA_HALF, 0, WIDTH - VIEW_WIDTH);
    this.worldLayer.x = offset;
    // Game.mt: root._x = offset; bg._x = -root._x / 3; bg2 stays at x=0.
    // Because bg is a child of the panned root, its screen x is offset - offset/3.
    this.bgSprite.x = -offset / 3;
    this.bg2Sprite.x = 0;

    if (this.blob_timer <= 0) {
      for (let i = 0; i < this.blobs.length; i += 1) {
        if (!this.blobs[i].update()) {
          this.tsize -= this.blobs[i].size;
          this.blobs[i].destroy();
          this.blobs.splice(i, 1);
          i -= 1;
        }
      }
    }

    // Hero.mt: after blobs update (so the killer blob has its new position),
    // re-pin the dead hero MC to the killer blob — matching source's
    // `bonus.mc._x = x` write inside Blob.update with `bonus = Std.cast(hero)`.
    this.hero.pinToKiller();

    // Drain update queue (snapshot iteration to allow callbacks to mutate it).
    for (let i = 0; i < this.updates.length; i += 1) {
      if (!this.updates[i]()) {
        this.updates.splice(i, 1);
        i -= 1;
      }
    }

    this.updateHud();
  }

  destroy(): void {
    for (const b of this.blobs) {
      b.destroy();
    }
    this.blobs = [];
    this.hero.destroy();
    this.updates = [];
    if (this.blobFilters !== null) {
      this.blobFilters.plain.destroy();
      this.blobFilters.bonus.destroy();
      this.blobFilters = null;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Module entry
// -------------------------------------------------------------------------------------------------

export async function mount(container: HTMLElement): Promise<GameInstance> {
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

  const game = new KillbulleGame(app, assets);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      game.keys.add(event.key);
      return;
    }
    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      game.spaceHeld = true;
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      game.keys.delete(event.key);
      return;
    }
    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      game.spaceHeld = false;
    }
  };
  const onPointerDown = (event: PointerEvent) => {
    // Primary button only. Right-click pointerdown without filtering would
    // latch spaceHeld=true and the contextmenu would swallow the pointerup,
    // leaving the grapin endlessly firing.
    if (event.button !== 0) return;
    event.preventDefault();
    game.spaceHeld = true;
  };
  // pointerup / pointercancel live on window: when the user presses on the
  // canvas and drags off before releasing, the canvas-only listener never
  // fires and spaceHeld stays latched.
  const onPointerUp = (event: PointerEvent) => {
    if (event.button !== 0 && event.type === 'pointerup') return;
    event.preventDefault();
    game.spaceHeld = false;
  };
  // Suppress the browser context menu over the canvas.
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };
  // Clear key state on focus loss so held arrows / Space don't latch when the
  // tab loses focus mid-press.
  const onBlur = () => {
    game.keys.clear();
    game.spaceHeld = false;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  app.canvas.addEventListener('pointerdown', onPointerDown);
  app.canvas.addEventListener('contextmenu', onContextMenu);

  let acc = 0;
  const tickerCallback = (ticker: Ticker) => {
    acc += Math.min(ticker.deltaMS / 1000, 0.1);
    let guard = 0;
    while (acc >= STEP_SECONDS && guard < 5) {
      game.main();
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
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      app.canvas.removeEventListener('pointerdown', onPointerDown);
      app.canvas.removeEventListener('contextmenu', onContextMenu);
      app.ticker.remove(tickerCallback);
      game.destroy();
      // texture:false — keep Assets-managed textures alive for the next mount.
      // The shared blob/explosion ColorMatrixFilters are destroyed in
      // game.destroy(); no other off-tree GPU resources to release.
      app.destroy(true, { children: true, texture: false });
    },
  };
}
