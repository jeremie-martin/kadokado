import { Application, ColorMatrixFilter, Container, Graphics, RenderTexture, Sprite, Text, Ticker } from 'pixi.js';
import { noopGameHost } from '../types';
import type { GameHost, GameInstance, GameMountContext } from '../types';
import { type Frame, loadFrame, loadSeries, makeSprite, setFrame } from '../_shared/frames';

// -----------------------------------------------------------------------------
// Stage and timing
// -----------------------------------------------------------------------------
//
// SWF binary header (verified 2026-05-02): 40 FPS. The `@90D*` in project.hxml
// is a Haxe SWF target option string, not engine FPS — earlier reading of it
// as 90 FPS was wrong. `Common.hx` defines FRAME_RATE = 40 which matches the
// engine rate. We drive the harness at 40 Hz and preserve the literal `40` in
// any motion math where the original used it.
const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 300;
const FPS = 40;
const STEP_SECONDS = 1 / FPS;

const ASSET_ROOT = '/assets/linea';
const LINEA_FONT_SCORE = 'LineaNeuropolScore';
const LINEA_FONT_UI = 'LineaNeuropolUi';

// -----------------------------------------------------------------------------
// Const port (Common.hx)
// -----------------------------------------------------------------------------
//
// Depth indices (DP_BG=0, DP_BMP=1, DP_UNDER=2, DP_OBJECTS=3, DP_PERLIN=4,
// DP_BONUS=5, DP_DOT=6, DP_UI=7) are not surfaced here — the Pixi container
// hierarchy enforces z-order directly. FRAME_RATE = 40 is captured by the FPS
// constant above. Both kept as documentation only; not declared.

const MARGIN = 22;
const XMARGIN = 10;

// KKApi.const(N) returns N unchanged in the stripped runtime; values are inlined.
const LINE_BONUS = 5;
const BASE_SCORE = 2000;
const SPEED_INIT = 50;
const BASESPEED_INIT = 40;
const VSCROLL_INIT = 1;
const MINSPEED_INIT = BASESPEED_INIT - 20;
const CAMPER = 300;
const BONUS_COMBO = 12000;
const BONUS_GLOW = 20;

const BASE_DOT_UP_SPEED = -30;
const BASE_DOT_DOWN_SPEED = 30;
const BASE_DOT_LEFT_SPEED = -20;
const BASE_DOT_RIGHT_SPEED = 20;

const WIDTH_BMD = 600; // Const.WIDTH; Dotter receives WIDTH / 2 = 300 px.
const HEIGHT_BMD = 300; // Const.HEIGHT (dot playfield height)
const START_X = 50; // Const.START
const DOT_START_POS = 150; // Const.DOT_START_POS (BitmapData y for queued dots)
const MAINCYCLE_INIT = 800;
const MINADD_INIT = 250;
// const MAXADD = 50; // unused in the source loop

const BONUSX2_THRESHOLD = 100;
const BONUSX2 = 2;
const BONUSX3_THRESHOLD = 175;
const BONUSX3 = 3;
const BONUSX4_THRESHOLD = 250;
const BONUSX4 = 8; // sic — see brief; not 4

// 7 palettes x 4 colors (DOTCOLORS) + matching 7 palettes x 5 colors (OBJECTS_COLOR).
// Pre-converted from Col.rgb2Hex(r,g,b) which packs RGB into 0xRRGGBB.
function rgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

const DOTCOLORS_SOURCE: number[][] = [
  [rgb(125, 198, 34), rgb(0, 170, 189), rgb(243, 194, 0), rgb(226, 0, 120)],
  [rgb(245, 211, 0), rgb(44, 180, 49), rgb(150, 129, 183), rgb(207, 2, 38)],
  [rgb(191, 177, 211), rgb(187, 219, 136), rgb(249, 244, 0), rgb(191, 2, 34)],
  [rgb(187, 219, 136), rgb(245, 211, 0), rgb(241, 175, 0), rgb(207, 2, 38)],
  [rgb(0, 177, 174), rgb(94, 189, 71), rgb(212, 85, 33), rgb(254, 248, 134)],
  [rgb(112, 199, 212), rgb(255, 213, 114), rgb(250, 114, 54), rgb(205, 208, 10)],
  [rgb(220, 151, 161), rgb(197, 107, 35), rgb(161, 17, 53), rgb(163, 47, 117)],
];

const OBJECTS_COLOR_SOURCE: number[][] = DOTCOLORS_SOURCE.map((row) => [...row, 0xffffff]);

// -----------------------------------------------------------------------------
// Color helpers (Col.* equivalent)
// -----------------------------------------------------------------------------

function brighten(color: number, prc: number): number {
  // Col.brighten(rgb, prc): mt.bumdum.Lib.Col.brighten calls mergeCol(rgb,
  // 0xFFFFFF, prc/100), which yields `rgb * (prc/100) + 255 * (1 - prc/100)`.
  // i.e. prc=0 returns pure white, prc=100 returns the original color, prc=50
  // is halfway between original and white. R23 fix: previous port had inverted
  // semantics (prc=100 ⇒ white) which made bonus glows / vertical guides /
  // square tints all read more washed-out than the source intended.
  const t = Math.min(100, Math.max(0, prc)) / 100;
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const nr = Math.round(r * t + 255 * (1 - t));
  const ng = Math.round(g * t + 255 * (1 - t));
  const nb = Math.round(b * t + 255 * (1 - t));
  return rgb(nr, ng, nb);
}

function darken(color: number, prc: number): number {
  const t = Math.min(100, Math.max(0, prc)) / 100;
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return rgb(Math.round(r * (1 - t)), Math.round(g * (1 - t)), Math.round(b * (1 - t)));
}

// -----------------------------------------------------------------------------
// Geom helpers (mt.white.Geom equivalent — degree-based trig)
// -----------------------------------------------------------------------------
//
// The original Geom uses degree-input cos/sin and a Bresenham bitmap-line draw.
// We keep the degree API so call sites translate 1:1.

function gcos(deg: number): number {
  return Math.cos((deg * Math.PI) / 180);
}
function gsin(deg: number): number {
  return Math.sin((deg * Math.PI) / 180);
}

// -----------------------------------------------------------------------------
// Random helpers
// -----------------------------------------------------------------------------

function stdRandom(n: number): number {
  // Std.random(n): integer in [0, n-1]. Std.random(0) returns 0 in Haxe.
  if (n <= 1) return 0;
  return Math.floor(Math.random() * n);
}

// -----------------------------------------------------------------------------
// Asset loading
// -----------------------------------------------------------------------------

type LineaAssets = {
  back: Frame;
  border: Frame;
  start: Frame;
  ui: Frame;
  addLine: Frame; // mcAddLine (single-frame in archive; original had 2 frames for glow)
  square: Frame[]; // 4-frame mcSquare (1 normal, 2 camping ramp, 3 hover, 4 exit)
  bonus: Frame[]; // 2-frame mcBonus (glow toggle)
  soloBonus: Frame; // mcSoloBonus child used by mcBonus
  bonusParts: Frame[]; // 6-frame mcBonusParts (radial particles)
  part: Frame; // mcPart dot-explosion particle
  bonusScore: Frame; // floating "score" popup
  lineScore: Frame; // floating line-add popup
  bonusCombo: Frame; // 4-of-4 combo popup
};

async function loadAssets(): Promise<LineaAssets> {
  const bonusPartPivots = [
    [0.1, 0.1],
    [0.1, -0.3],
    [-0.65, -0.4],
    [0, 0.1],
    [0, -1],
    [-0.05, -0.1],
  ] as const;
  const [back, border, start, ui, addLine, square, bonus, soloBonus, bonusParts, part, bonusScore, lineScore, bonusCombo] =
    await Promise.all([
      loadFrame(`${ASSET_ROOT}/back.png`, 0, 0),
      loadFrame(`${ASSET_ROOT}/border.png`, 0, 0),
      loadFrame(`${ASSET_ROOT}/start.png`, 14, 14),
      loadFrame(`${ASSET_ROOT}/templates/ui-template.png`, 0, 0),
      loadFrame(`${ASSET_ROOT}/add-line.png`, 21, 21),
      loadSeries(`${ASSET_ROOT}/square`, 4, 0, 0),
      loadSeries(`${ASSET_ROOT}/bonus`, 2, -5.5, -1.9),
      loadFrame(`${ASSET_ROOT}/solo-bonus.png`, 0.1, 0.1),
      Promise.all(bonusPartPivots.map(([x, y], i) => loadFrame(`${ASSET_ROOT}/bonus-parts/${i + 1}.png`, x, y))),
      loadFrame(`${ASSET_ROOT}/part.png`, 2.5, 15),
      loadFrame(`${ASSET_ROOT}/templates/bonus-score-template.png`, 73.5, 5.6),
      loadFrame(`${ASSET_ROOT}/templates/line-score-template.png`, 38.25, 20.6),
      loadFrame(`${ASSET_ROOT}/templates/bonus-combo-template.png`, -3, -4.5),
    ]);
  return { back, border, start, ui, addLine, square, bonus, soloBonus, bonusParts, part, bonusScore, lineScore, bonusCombo };
}

async function loadLineaFonts(): Promise<void> {
  if (!('fonts' in document) || typeof FontFace === 'undefined') return;
  const fonts = [
    new FontFace(LINEA_FONT_SCORE, `url(${ASSET_ROOT}/fonts/neuropol-score.ttf)`),
    new FontFace(LINEA_FONT_UI, `url(${ASSET_ROOT}/fonts/neuropol-ui.ttf)`),
  ];
  const loaded = await Promise.all(fonts.map((font) => font.load()));
  for (const font of loaded) document.fonts.add(font);
}

// -----------------------------------------------------------------------------
// Phys (mt.bumdum.Phys equivalent)
// -----------------------------------------------------------------------------
//
// The original Phys is a tiny per-frame physics record attached to a sprite.
// Used fields here: timer (countdown frames), fadeType (alpha curve mode),
// fadeLimit, sleep, vx, vy, weight, x, y. Only the subset actually referenced
// in Game.hx / Dotter.hx is implemented.

type PhysFade = 0 | 1 | 2 | 3 | 4 | 5;

class Phys {
  view: Container;
  timer: number;
  // Source default fadeLimit = 10 (Phys.hx:25 — `fadeLimit = 10;` in `new`),
  // unless the call site overrides it. The fade switch only fires when
  // `timer < fadeLimit` (Phys.hx:68), so this default gates fade-in to the
  // last 10 frames of the timer.
  fadeLimit = 10;
  fadeType: PhysFade = 0;
  // Source `sleep : Float` is nullable (Haxe Int default). `Phys.update`
  // gates on `if (sleep != null)`; on `sleep < 0` after decrement the field
  // resets to null. We mirror with `number | null` so an explicit `sleep = 0`
  // still gives a one-frame stall (matching source: `sleep--` → -1 → wake on
  // the SAME frame after the early return), while an unset/default field
  // skips the gate entirely. R28: `sleep = 0` default previously meant any
  // call site using the field's initial value got zero stall, vs source's
  // one-frame stall after explicit assignment of 0. See `score()` and
  // `removeBonusHit` — the source assigns `p.sleep = sleep` (default 0)
  // unconditionally, so every score popup and bonus particle had a missing
  // 1-frame stall in the port. Most prominent on `mcBonusScore` with
  // sleep=20 (Game.hx:388) where source lingers 21 frames vs port's 20.
  sleep: number | null = null;
  vx = 0;
  vy = 0;
  // weight is GRAVITY (additive vy increment per frame), not a multiplier.
  // Source: `vy += weight*tmod` (Phys.hx:47). null/undefined = no gravity.
  weight: number | null = null;
  // The original kept absolute target coords on `x`/`y`; we mirror that.
  x = 0;
  y = 0;

  constructor(view: Container, timer = 15) {
    this.view = view;
    this.timer = timer;
    this.x = view.x;
    this.y = view.y;
  }

  step(): boolean {
    // Source Phys.update (Phys.hx:36-44):
    //   if(sleep!=null){ sleep--; if(sleep<0){ sleep=null; root._visible=true;
    //     root.play(); } return; }
    // The early `return;` fires unconditionally while `sleep != null`. The
    // wake transition (sleep → null) happens AFTER the decrement crosses
    // below zero, on the SAME frame, but still returns. Net effect: a Phys
    // with `sleep = N` (for N >= 0) has N+1 frames of stillness before
    // physics begins on frame N+2. Port previously used `if (sleep > 0)`
    // which only stalls N frames. R28: switched to nullable `sleep` and
    // matched the wake-on-`sleep < 0` semantics so an explicit `sleep = 0`
    // still produces a 1-frame stall.
    if (this.sleep !== null) {
      this.sleep -= 1;
      if (this.sleep < 0) this.sleep = null;
      return true;
    }
    if (this.timer <= 0) {
      return false;
    }
    if (this.weight !== null) this.vy += this.weight;
    this.view.x += this.vx;
    this.view.y += this.vy;
    this.timer -= 1;

    // Source `if (timer < fadeLimit)` gates the fade switch (Phys.hx:68).
    // c = timer/fadeLimit (clamped >= 0 for the last frame).
    if (this.timer < this.fadeLimit) {
      const c = Math.max(0, this.timer) / Math.max(1, this.fadeLimit);
      switch (this.fadeType) {
        case 0:
          // Source `case 0: _xscale = c*scale; _yscale = c*scale`
          // (Phys.hx:72-74). R26: previously fell through to the alpha default;
          // R20's audit incorrectly claimed there was no `case 0` branch.
          // Affects `removeBonusHit` particles (`new Phys(part, 13)` with no
          // explicit fadeType): they now shrink in both axes over the last
          // 10 frames instead of fading alpha. Matches the source's
          // shrinking-confetti aesthetic for bonus-pickup particles.
          this.view.scale.x = c;
          this.view.scale.y = c;
          break;
        case 1:
          // Source: `_visible = Std.int(timer)%4 > 1` flicker. Unused by
          // Linea but mirrored for completeness.
          this.view.visible = Math.trunc(this.timer) % 4 > 1;
          break;
        case 2:
          // Source: `root.play()` (animation tick). No animation in the port;
          // call site is commented out in Game.hx:415, so this is inert.
          break;
        case 3:
          // Source: `root._yscale = c*scale`. yscale only, NOT alpha.
          this.view.scale.y = c;
          break;
        case 4:
          // Source: `_alpha = c*alpha; Filt.blur(root, (1-c)*16, 0)`.
          // Blur omitted (no filter dep); alpha matches.
          this.view.alpha = c;
          break;
        case 5:
          // Source: `_xscale = c*scale`. xscale only, NOT alpha.
          this.view.scale.x = c;
          break;
        default:
          // Source default branch: `_alpha = c*alpha`.
          this.view.alpha = c;
          break;
      }
    }
    return this.timer > 0;
  }
}

// -----------------------------------------------------------------------------
// Dotter — BitmapData trail approximated with a Pixi RenderTexture.
// -----------------------------------------------------------------------------
//
// Faithful to Dotter.hx, with the BitmapData calls replaced by:
//  - a RenderTexture (`plane`) we render single-pixel Graphics into per dot move
//  - a "scroll" implemented by drawing the prior-frame texture offset by `-scr`
//  - the shimmer ColorTransform replaced by a per-frame tint sweep on the sprite
//    (a true colorTransform would require a fragment shader; tint is the closest
//    no-shader approximation in Pixi 8).
//
// NOTE: the BitmapData→RenderTexture port loses pixel-perfect equivalence with
// the original in the following ways:
//   1. The shimmer ColorTransform is not bit-identical (we tint the host sprite
//      instead of compositing per-pixel).
//   2. A small alpha-offset (128) the original applied each frame to keep
//      drawn pixels from fading is not modelled; trails persist by virtue of
//      the rt-on-rt blit instead.

interface DotState {
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  color: number;
  color32: number; // ARGB packed (alpha 0xFF when ready)
  stopped: boolean;
  started: boolean;
  ready: boolean;
  merged: boolean;
  idx: number;
  uid: number;
  a: number;
}

class Dotter {
  // Logical dot list.
  dots: DotState[] = [];
  cannotGoY = false;

  private app: Application;
  private host: Container;
  private plane: RenderTexture;
  private scratch: RenderTexture;
  private viewSprite: Sprite;
  private gfx: Graphics;
  private shimmerFilter: ColorMatrixFilter;
  private nextUid = 0;

  private startPos: number;
  private startAim: number;
  private margin: number;
  private xMargin: number;
  private yMargin: number;
  private widthBmd: number;
  private heightBmd: number;
  private marginThickness = 1;

  private xSpeed = 0;
  private ySpeed = 0;
  private scroll = 0;
  private ldy = 0;
  private sinct = 0;

  constructor(
    app: Application,
    host: Container,
    width: number,
    height: number,
    xMargin: number,
    yMargin: number,
  ) {
    this.app = app;
    this.host = host;
    this.widthBmd = width;
    this.heightBmd = height;
    this.startPos = Math.round(width / 2);
    this.startAim = Math.round(width / 6);
    this.margin = 10;
    this.xMargin = xMargin;
    this.yMargin = yMargin;

    this.plane = RenderTexture.create({ width, height, resolution: 1, antialias: false });
    this.scratch = RenderTexture.create({ width, height, resolution: 1, antialias: false });
    this.viewSprite = new Sprite(this.plane);
    this.host.addChild(this.viewSprite);
    this.gfx = new Graphics();
    // Shimmer ColorTransform: source applies a per-frame RGB multiplier of
    // 0.98 + sin(t)/100 to the BitmapData (Dotter.hx, see linea.md:144). Pixi
    // 8 has no BitmapData.colorTransform; we replicate it by attaching a
    // ColorMatrixFilter to the temp sprite during scrollPlane's plane→scratch
    // copy. That makes the shimmer cumulative on RT pixels (matching source
    // semantics: trails slowly fade) instead of a one-shot display tint.
    this.shimmerFilter = new ColorMatrixFilter();
  }

  destroy(): void {
    this.viewSprite.removeFromParent();
    this.plane.destroy(true);
    this.scratch.destroy(true);
    this.gfx.destroy();
    this.shimmerFilter.destroy();
  }

  setOnStage(x: number, y: number): void {
    // Original places the bitmap at the BitmapData's own coordinate system;
    // the host already lives in the gameplay layer so we simply position the
    // view sprite. Callers pass the on-screen offset.
    this.viewSprite.position.set(x, y);
  }

  /** Visible width: sprite shows only the leftmost `vw` columns of the BMD. */
  setVisibleWidth(vw: number, vh: number): void {
    // The viewSprite renders the whole RenderTexture; mask to the visible area.
    const rect = new Graphics();
    rect.rect(0, 0, vw, vh).fill({ color: 0xffffff });
    this.host.addChild(rect);
    this.viewSprite.mask = rect;
  }

  addDot(color = 0xffffff): void {
    const aim = this.dots.filter((d) => !d.ready);
    const dot: DotState = {
      x: 0,
      y: this.startPos + aim.length * 10,
      prevX: 0,
      prevY: this.startPos + aim.length * 10,
      color,
      color32: 0xff000000 | (color & 0xffffff),
      stopped: false,
      started: false,
      ready: false,
      merged: false,
      idx: 0,
      uid: this.nextUid++,
      a: 0,
    };
    this.dots.push(dot);
    // Seed plane pixel at (0, startPos), matching `plane.setPixel32(0, startPos, col)`.
    this.drawPixel(0, this.startPos, dot.color32);
  }

  getFirst(): DotState | undefined {
    return this.dots[0];
  }
  getReady(): DotState[] {
    return this.dots.filter((d) => d.ready);
  }
  getStarted(): DotState[] {
    return this.dots.filter((d) => d.started);
  }
  getLength(): number {
    return this.dots.length;
  }
  remove(uid: number): void {
    const i = this.dots.findIndex((d) => d.uid === uid);
    if (i >= 0) this.dots.splice(i, 1);
  }
  updateSpeed(vx: number, vy: number): void {
    this.xSpeed = vx;
    this.ySpeed = vy;
  }

  private drawPixel(x: number, y: number, color32: number): void {
    if (x < 0 || y < 0 || x >= this.widthBmd || y >= this.heightBmd) return;
    const alpha = ((color32 >>> 24) & 0xff) / 255;
    const rgbColor = color32 & 0xffffff;
    this.gfx.clear();
    this.gfx.rect(x, y, 1, 1).fill({ color: rgbColor, alpha: alpha === 0 ? 1 : alpha });
    this.app.renderer.render({ container: this.gfx, target: this.plane, clear: false });
  }

  private drawBitmapLine(x0: number, y0: number, x1: number, y1: number, color32: number): void {
    // Bresenham equivalent, using Graphics rects.
    const alpha = ((color32 >>> 24) & 0xff) / 255 || 1;
    const rgbColor = color32 & 0xffffff;
    this.gfx.clear();
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    let sx = x0 < x1 ? 1 : -1;
    let sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    let safety = 0;
    while (safety < 4000) {
      if (x >= 0 && y >= 0 && x < this.widthBmd && y < this.heightBmd) {
        this.gfx.rect(x, y, 1, 1);
      }
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
      safety += 1;
    }
    this.gfx.fill({ color: rgbColor, alpha });
    this.app.renderer.render({ container: this.gfx, target: this.plane, clear: false });
  }

  private scrollPlane(dx: number): void {
    // Pixi 8 has no BitmapData.scroll; we render plane → scratch shifted by -dx.
    // Apply the shimmer ColorMatrixFilter on the same blit so the per-frame
    // RGB multiplier is baked into the RT (matching source: bmd.colorTransform
    // mutates the BitmapData in place; trails fade gradually as k < 1 each
    // frame). Filter is attached/detached around this single render to avoid
    // affecting any subsequent dot-Graphics draws into the plane.
    const tmp = new Sprite(this.plane);
    tmp.x = dx; // dx is negative when scrolling left
    tmp.filters = [this.shimmerFilter];
    this.app.renderer.render({ container: tmp, target: this.scratch, clear: true });
    tmp.filters = [];
    // Swap.
    const old = this.plane;
    this.plane = this.scratch;
    this.scratch = old;
    this.viewSprite.texture = this.plane;
    tmp.destroy();
  }

  /** Per-frame trail update (Dotter.update). */
  update(sx: number, sy: number, scr: number, cbk: (d: DotState) => void): void {
    this.scroll = scr;
    // Shimmer ColorTransform: source applies a sine-modulated RGB multiplier
    // (~0.98 ± sin/100) per frame to the BitmapData. We update the matrix in
    // sync with sinct, then scrollPlane bakes it into the plane via a filter
    // on the temp blit sprite. Diagonal entries are the per-channel multiplier
    // k; alpha row carries `alphaOffset = 128` (Dotter.hx:105 — verified via
    // FFDec-extracted source, was R11/R14-deferred as ambiguous). Pixi's
    // matrix offset column is normalized to [0..1], so 128/255 ≈ 0.5019.
    // This boosts every pixel's alpha by +128 each frame; trail pixels written
    // at low alpha (0x60) become opaque within ~2 frames, matching the source
    // semantics where trails persist as solid pixels rather than alpha-fading.
    const k = 0.98 + Math.sin((this.sinct * Math.PI) / 180) / 100;
    this.shimmerFilter.matrix = [
      k, 0, 0, 0, 0,
      0, k, 0, 0, 0,
      0, 0, k, 0, 0,
      0, 0, 0, 1, 128 / 255,
    ];
    this.scrollPlane(-scr);

    this.sinct += 5;

    const linked = this.dots.filter((d) => d.started);
    const first = linked[0];
    const last = linked[linked.length - 1];
    const min = this.margin;

    const free = this.dots.filter((d) => !d.started);
    const aim = this.dots.filter((d) => !d.ready);
    let idx = -2;
    let firstWent = false;
    const count = aim.length;

    for (const dot of linked) {
      idx += 1;
      let dx = 0;
      let dy = 0;

      if (!dot.ready && first) {
        const dest = dot.idx === 0 ? min * (this.dots.length - aim.length) : dot.idx * min;

        if (Math.abs(first.x - dot.x) <= 3 && Math.abs(first.y + dest - dot.y) <= 3) {
          dot.ready = true;
          dot.x = first.x;
          dot.y = first.y + dest;
          if (dot.idx === 0) dot.idx = idx + 1;
          dot.a = idx * 90;
          if (!dot.merged) {
            cbk(dot);
          } else {
            dot.merged = false;
          }
          this.moveDot(dot, dx, dy);
          continue;
        }

        const t = this.heightBmd - this.xMargin - (dest << 1);
        if (first.y >= t) {
          this.moveDot(dot, dx, dy);
          continue;
        }

        const vx = (sx * (dot.idx + 1)) / 2;
        const vy = (sy * (dot.idx + 1)) / 2;
        const vary = first.y + dest - dot.y;
        const varx = first.x - dot.x;
        const a = Math.atan2(vary, varx);
        const ddx = Math.cos(a) * vx;
        const ddy = Math.sin(a) * vy;
        this.moveDot(dot, Math.ceil(ddx), Math.ceil(ddy));
        continue;
      }

      if (dot.stopped) {
        this.moveDot(dot, dx, dy);
        continue;
      }

      if (count === 1 && first) {
        if (
          (dot.y <= this.yMargin + this.marginThickness && this.ySpeed > 0) ||
          (dot.y >= this.heightBmd - this.yMargin - this.marginThickness && this.ySpeed < 0) ||
          (dot.y < this.heightBmd - this.yMargin - this.marginThickness && dot.y > this.yMargin)
        ) {
          dy = this.ySpeed;
          this.cannotGoY = false;
        } else {
          this.cannotGoY = true;
        }
      } else if (first && last) {
        if (
          (first.y <= this.yMargin - this.marginThickness && this.ySpeed > 0) ||
          (dot.idx === first.idx && dot.y <= this.yMargin - this.marginThickness && this.ySpeed > 0) ||
          (dot.y >= this.heightBmd - this.yMargin - this.marginThickness && this.ySpeed < 0) ||
          (first.y >= this.heightBmd - this.yMargin - this.marginThickness && this.ySpeed < 0) ||
          (last.y >= this.heightBmd - this.yMargin - this.marginThickness && this.ySpeed < 0) ||
          (last.y <= this.heightBmd - this.yMargin - this.marginThickness &&
            first.y >= this.yMargin &&
            dot.y >= this.yMargin) ||
          firstWent
        ) {
          if (dot.idx === first.idx) firstWent = true;
          dy = this.ySpeed;
          this.cannotGoY = false;
        } else {
          if (dot.idx === first.idx) firstWent = false;
          dy = 0;
          this.cannotGoY = true;
        }
      }

      if (
        (dot.x <= this.xMargin && this.xSpeed > 0) ||
        (dot.x >= this.heightBmd - this.xMargin && this.xSpeed < 0) ||
        (dot.x > this.xMargin && dot.x < this.heightBmd - this.xMargin)
      ) {
        dx = this.xSpeed;
      }

      if (first && dot.color !== first.color) {
        // 'merge' is unused/false in the original game; mirror the dead branch.
        if (dot.merged) dot.ready = false;
      }

      this.moveDot(dot, dx, dy);
    }

    for (const dot of free) {
      if (dot.x < this.startAim) {
        this.moveDot(dot, sx, 0);
        continue;
      }
      dot.started = true;
      this.moveDot(dot, 0, 0);
    }
  }

  private moveDot(dot: DotState, dx: number, dy: number): void {
    const x = dot.x;
    const y = dot.y;
    const col = dot.ready ? dot.color32 : 0x60888888;

    if (dy === 0) {
      const span = this.scroll + dx;
      // Single horizontal trail segment per frame; rendered as one line for perf.
      if (span > 0) {
        this.drawBitmapLine(x, y, x + span - 1, y, col);
      } else if (span < 0) {
        this.drawBitmapLine(x + span, y, x, y, col);
      } else {
        this.drawPixel(x, y, col);
      }
      dot.prevX = dot.x;
      dot.prevY = dot.y;
      dot.x += dx;
      this.ldy = 0;
      return;
    }

    const x1 = x + this.scroll;
    const y1 = y + dy;
    this.drawPixel(x, y, col);
    this.drawBitmapLine(x, y, x1, y1, col);

    if (this.ldy <= 0) {
      if (dy > 0) {
        this.drawPixel(x + 2, y + 1, col);
        this.drawPixel(x + 3, y + 1, col);
        this.drawPixel(x + 2, y + 2, 0x60000000);
      }
    }
    dot.prevX = dot.x;
    dot.prevY = dot.y;
    dot.y += dy;
    this.ldy += dy;
  }
}

// -----------------------------------------------------------------------------
// Object types (Game.hx typedefs)
// -----------------------------------------------------------------------------

type SquareObject = {
  view: Sprite;
  frames: Frame[];
  currentFrame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  vscroll: number;
  added: boolean;
  camper: boolean;
  line: false;
  bonus: false;
  lineDone: false;
  color: number;
  phys: Phys | null;
};

type LineObject = {
  view: Sprite;
  frames: Frame[];
  currentFrame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  vscroll: number;
  added: boolean;
  camper: false;
  line: true;
  bonus: false;
  lineDone: boolean;
  color: number;
  phys: Phys | null;
};

type AnyObject = SquareObject | LineObject;

type BonusHit = {
  view: Sprite;
  hit: boolean;
  ox: number; // local x relative to the parent BONUS view
  oy: number; // local y relative to the parent BONUS view
};

type BonusObject = {
  view: Container;
  parts: BonusHit[];
  currentFrame: number;
  x: number;
  y: number;
  width: number;
  height: number;
  color: number;
  hit: boolean;
  b1: BonusHit;
  b2: BonusHit;
  b3: BonusHit;
  b4: BonusHit;
  phys: Phys | null;
};

// -----------------------------------------------------------------------------
// Game scene
// -----------------------------------------------------------------------------

const enum GameStep {
  Waiting = 1,
  Playing = 2,
  Ending = 3,
}

class LineaGame {
  app: Application;
  assets: LineaAssets;
  root: Container;
  host: GameHost;

  // Layered containers (DepthManager replacement; addChildAt order = layer order).
  bgLayer = new Container();
  bmpLayer = new Container();
  underLayer = new Container();
  objectsLayer = new Container();
  bonusLayer = new Container();
  dotLayer = new Container();
  uiLayer = new Container();

  // UI elements.
  mcStart: Sprite;
  mcStartPhys: Phys | null = null;
  bonus2: Graphics;
  bonus3: Graphics;
  bonus4: Graphics;
  uiPanel: Sprite;
  uiTopBorder: Sprite;
  uiBottomBorder: Sprite;
  scoreText: Text;
  multiplierText: Text;
  difFactorText: Text;
  gameOverText: Text;
  uidots: Graphics[] = [];

  // World state.
  scroller: ScrollerLayer;
  dotter: Dotter;

  objects: AnyObject[] = [];
  abonus: BonusObject[] = [];
  particles: { view: Container; phys: Phys; ttl: number }[] = [];
  step: GameStep = GameStep.Waiting;
  signalSent = false;
  gameOver = false;
  stopScroll = false;
  start = false;
  // Source initializes startCycle to 0 (default Int) so the very first frame
  // hits the `<= 0` branch and toggles mcStart.visible immediately.
  startCycle = 0;
  ocycle = BONUS_GLOW;
  bcycle = BONUS_GLOW;
  lastWasBonus = true;
  colorTheme = 0;
  palette: number[] = []; // working DOTCOLORS[colorTheme] (popped from)
  objectsPalette: number[] = []; // OBJECTS_COLOR[colorTheme]
  lastX = 0;
  mainCycle = MAINCYCLE_INIT;
  camping = 0;
  camper = 2;
  scrollAmt = Math.round(BASESPEED_INIT / 10);
  speedConst = SPEED_INIT;
  baseSpeedConst = BASESPEED_INIT;
  vscrollConst = VSCROLL_INIT;
  minAddConst = MINADD_INIT;
  bonusMul = 0;
  scoreVal = 0;
  pHit = 0;
  pBonus = 0;
  pLines = 0;

  // Per-step input snapshot (Const.DOT_X_SPEED / Y_SPEED in source).
  dotXSpeed = 0;
  dotYSpeed = 0;

  // Screen shake.
  shk = 0;
  shkFrict = 0.5;
  shkActive = false;

  // Color flash state for sprites. Each entry owns its own ColorMatrixFilter
  // so the lerp `out = sp_rgb*(1-p) + col*p` (Flash `Col.setPercentColor`)
  // can be reproduced — Pixi v8 multiplicative `tint` only darkens, so we
  // cannot lerp the sprite RGB toward an arbitrary target color through tint
  // alone. Pattern mirrors `kslash/enemies.ts:Monster.applyFlashFilter`.
  flasher: { sp: Sprite; prc: number; coef: number; col: number; filter: ColorMatrixFilter }[] = [];

  // Source's `keymod` accumulator (Game.hx:179-187): once `tmod` is added each
  // engine tick and 0.8 is subtracted after each updateAll, the loop runs
  // updateAll an average of ~1.2 times per engine tick (at tmod=1.0 steady
  // state). The harness already runs step_() at the engine 40 Hz, so we
  // replicate the inner-loop smoothing here to keep the gameplay rate at
  // ~48 Hz like the original — without it, scrolling/scoring/difficulty ramp
  // run ~20% slower than the source.
  keymod = 0;

  keys = new Set<string>();

  constructor(app: Application, assets: LineaAssets, host: GameHost) {
    this.app = app;
    this.assets = assets;
    this.host = host;
    this.root = new Container();
    app.stage.addChild(this.root);
    this.root.addChild(this.bgLayer, this.bmpLayer, this.underLayer, this.objectsLayer, this.bonusLayer, this.dotLayer, this.uiLayer);

    this.colorTheme = stdRandom(DOTCOLORS_SOURCE.length);
    this.palette = [...DOTCOLORS_SOURCE[this.colorTheme]];
    this.objectsPalette = [...OBJECTS_COLOR_SOURCE[this.colorTheme]];

    // Background tiling (single layer in linea).
    this.scroller = new ScrollerLayer(app, this.bgLayer, assets.back, 300, 300);

    // Borders.
    this.uiTopBorder = makeSprite(assets.border);
    this.uiTopBorder.y = 0;
    this.uiLayer.addChild(this.uiTopBorder);
    this.uiBottomBorder = makeSprite(assets.border);
    this.uiBottomBorder.y = 280;
    this.uiLayer.addChild(this.uiBottomBorder);

    // Start overlay.
    this.mcStart = makeSprite(assets.start);
    this.mcStart.y = 65;
    this.mcStart.x = 0;
    this.uiLayer.addChild(this.mcStart);

    // Random palette accent color (single random pick, reused for the two
    // horizontal accent lines and the brightened vertical guides). Source:
    // `Game.hx:119` — `var lineCol = DOTCOLORS[colorTheme][Std.random(...)];`.
    const lineCol = this.palette[stdRandom(this.palette.length)];

    // Horizontal accent lines at y=20 and y=280 across the full 300 px stage,
    // tinted with the random palette color (Game.hx:120-121).
    // `addUILine(DP_UI, 0, 20, 300, 0, lineCol)` → `Geom.drawLine(l, 300, 0,
    // col, false, 0.25, 100)` = 0.25-px-thick fully-opaque horizontal line.
    // R7 doc claimed these were drawn in `drawHorizontalLines` but the function
    // was never present in the port; reinstated in R21.
    this.addAccentLine(0, 20, 300, lineCol);
    this.addAccentLine(0, 280, 300, lineCol);

    // Multiplier threshold guides (DP_UNDER) — under-stage vertical color bars.
    const guideCol = brighten(lineCol, 90);
    this.addUnderGuide(100, guideCol);
    this.addUnderGuide(175, guideCol);
    this.addUnderGuide(250, guideCol);

    // x2 / x3 / x4 tier glows under HUD.
    const themeBase = this.objectsPalette[0];
    this.bonus2 = this.makeBonusGlow(100, 280, brighten(themeBase, 50), 75);
    this.bonus3 = this.makeBonusGlow(175, 280, brighten(themeBase, 70), 75);
    this.bonus4 = this.makeBonusGlow(250, 280, brighten(themeBase, 90), 50);
    this.bonus2.visible = false;
    this.bonus3.visible = false;
    this.bonus4.visible = false;
    this.uiLayer.addChild(this.bonus2, this.bonus3, this.bonus4);

    // UI panel + texts.
    this.uiPanel = makeSprite(assets.ui);
    this.uiLayer.addChild(this.uiPanel);

    this.scoreText = new Text({
      text: '0',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 11, fontWeight: '700', fill: 0xffffff, stroke: { color: lineCol, width: 2 } },
    });
    this.scoreText.position.set(50, 6);
    this.scoreText.visible = false;
    this.uiLayer.addChild(this.scoreText);

    this.multiplierText = new Text({
      text: '',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 2 } },
    });
    this.multiplierText.position.set(160, 6);
    this.multiplierText.visible = false;
    this.uiLayer.addChild(this.multiplierText);

    this.difFactorText = new Text({
      text: '1',
      style: { fontFamily: LINEA_FONT_UI, fontSize: 15, fontStyle: 'italic', fill: 0xffffff, stroke: { color: 0x000000, width: 2 } },
    });
    this.difFactorText.anchor.set(0.5, 0);
    this.difFactorText.position.set(283, 3);
    this.uiLayer.addChild(this.difFactorText);

    this.gameOverText = new Text({
      text: '',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 22, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
    });
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2);
    this.gameOverText.visible = false;
    this.uiLayer.addChild(this.gameOverText);

    // Dotter.
    const dotterHost = new Container();
    this.bmpLayer.addChild(dotterHost);
    this.dotter = new Dotter(app, dotterHost, Math.ceil(WIDTH_BMD / 2), HEIGHT_BMD, XMARGIN, MARGIN);
    this.dotter.setOnStage(0, 0);
    this.dotter.setVisibleWidth(STAGE_WIDTH, HEIGHT_BMD);
    this.host.updateScore(0);

    // First dot from palette + matching UI dot.
    const firstColor = this.palette.pop() ?? 0xffffff;
    this.dotter.addDot(firstColor);
    this.addDotToUI(firstColor);

    // Source initializes scroll = round(BASESPEED / 10) and DOT_X_SPEED = round(RIGHT_SPEED / 5)
    this.dotXSpeed = Math.round(BASE_DOT_RIGHT_SPEED / 5);
  }

  // Per-fixed-step entry point. Mirrors `Game.update` (Game.hx:175-188):
  //   keymod += tmod;
  //   scroller.update(...);   // ONCE per engine tick
  //   updateAll();             // once
  //   keymod -= 0.8;
  //   while( keymod > 1 ) { keymod -= 0.8; updateAll(); }
  // At fixed-step (tmod = 1.0) this averages ~1.2 updateAll's per engine tick,
  // i.e. ~48 Hz gameplay logic on top of a 40 Hz scroller — the source's
  // intended rate. Dropping the keymod smoothing made the port run gameplay
  // ~20% slower than the original.
  step_(): void {
    this.keymod += 1; // tmod = 1.0 at fixed step
    this.scroller.update(1, this.dotXSpeed, this.dotYSpeed);
    this.updateAll();
    this.keymod -= 0.8;
    let guard = 0;
    while (this.keymod > 1 && guard < 6) {
      this.keymod -= 0.8;
      this.updateAll();
      guard += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // updateAll (Game.updateAll)
  // ---------------------------------------------------------------------------
  private updateAll(): void {
    this.onKeyDown();

    if (this.shkActive) this.updateFxShake();
    if (this.flasher.length > 0) this.updateFxFlash();

    this.updateParticles();

    if (!this.stopScroll) this.scrollDots();

    switch (this.step) {
      case GameStep.Waiting: {
        const dot = this.dotter.getFirst();
        if (!dot) break;
        if (dot.x < START_X) {
          // Source: `if( startCycle-- <= 0 )` — post-decrement, so the check
          // happens BEFORE the decrement. We replicate by checking first.
          if (this.startCycle <= 0) {
            dot.started = true;
            dot.ready = true;
            this.mcStart.visible = !this.mcStart.visible;
            this.startCycle = 10;
          } else {
            this.startCycle -= 1;
          }
        } else {
          // mcStart Phys with fadeType 4 → fade out over 15 frames.
          this.mcStartPhys = new Phys(this.mcStart, 15);
          this.mcStartPhys.fadeType = 4;
          this.start = true;
          this.dotXSpeed = 0;
          this.step = GameStep.Playing;
        }
        break;
      }
      case GameStep.Playing: {
        this.scrollObjects();
        this.scrollBonus();
        const readyCount = this.dotter.getReady().length;
        const dotMod = Math.max(readyCount, 1);
        // Source: KKApi.addScore( ceil( SPEED/100 * bonus * dotMod ) ), gated
        // implicitly because bonus stays 0 until scrollDots tier-checks the
        // first dot. We mirror the gate explicitly to avoid the +1 from ceil(0).
        const inc = this.bonusMul > 0 ? Math.ceil((this.speedConst / 100) * this.bonusMul * dotMod) : 0;
        this.scoreVal += inc;
        const xfactor = this.bonusMul + dotMod - 1;
        if (xfactor <= 0) this.difFactorText.text = '-';
        else if (xfactor < 1) this.difFactorText.text = '1';
        else this.difFactorText.text = String(xfactor).slice(0, 3);
        this.scoreText.text = String(this.scoreVal);
        this.host.updateScore(this.scoreVal);
        break;
      }
      case GameStep.Ending: {
        this.stopScroll = true;
        this.gameOver = true;
        break;
      }
    }

    // Phys-driven mcStart fade.
    if (this.mcStartPhys && !this.mcStartPhys.step()) {
      this.mcStart.visible = false;
      this.mcStartPhys = null;
    }

    // Difficulty ramp every MAINCYCLE frames.
    // Source: `if( mainCycle-- <= 0 )` — post-decrement, so we check first.
    if (this.mainCycle <= 0) {
      if (this.minAddConst < WIDTH_BMD - 45) this.minAddConst += 3;
      this.vscrollConst += 1;
      this.baseSpeedConst = Math.round(this.baseSpeedConst + 2);
      this.scrollAmt = Math.round(this.baseSpeedConst / 10);
      this.mainCycle = MAINCYCLE_INIT;
    } else {
      this.mainCycle -= 1;
    }

    if (this.gameOver && !this.signalSent) {
      // KKApi.gameOver({Phit, PBonus, PLines, PCamper})
      this.signalSent = true;
      this.host.endRun({ score: this.scoreVal });
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard input (Game.onKeyDown)
  // ---------------------------------------------------------------------------
  private onKeyDown(): void {
    if (!this.start) return;
    this.dotYSpeed = 0;
    this.dotXSpeed = 0;
    this.speedConst = this.baseSpeedConst;
    this.camping += 1;

    if (this.keys.has('ArrowUp')) {
      this.dotYSpeed = Math.round(BASE_DOT_UP_SPEED / 10);
      this.speedConst = MINSPEED_INIT;
      if (this.dotXSpeed !== 0) this.camping = 0;
    }
    if (this.keys.has('ArrowDown')) {
      this.dotYSpeed = Math.round(BASE_DOT_DOWN_SPEED / 10);
      this.speedConst = MINSPEED_INIT;
      if (this.dotXSpeed !== 0) this.camping = 0;
    }
    if (this.keys.has('ArrowLeft')) {
      this.dotXSpeed = Math.round(BASE_DOT_LEFT_SPEED / 10);
      if (this.dotYSpeed !== 0) this.camping = 0;
    }
    if (this.keys.has('ArrowRight')) {
      this.dotXSpeed = Math.round(BASE_DOT_RIGHT_SPEED / 10);
      if (this.dotYSpeed !== 0) this.camping = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Scroll dots / multiplier tier toggling (Game.scrollDots)
  // ---------------------------------------------------------------------------
  private scrollDots(): void {
    this.dotter.updateSpeed(this.dotXSpeed, this.dotYSpeed);

    const cbk = (d: DotState) => {
      // mcLineScore on dot ready: floating popup positioned at dot.
      // score() adds the dotter screen offset internally; pass BMD coords directly.
      this.score(d.x, d.y, 'line', this.dotter.getLength() - 1);
      this.addDotToUI(d.color);
    };

    this.dotter.update(
      Math.ceil(BASE_DOT_RIGHT_SPEED / 5),
      Math.ceil(BASE_DOT_DOWN_SPEED / 5),
      this.scrollAmt,
      cbk,
    );

    const first = this.dotter.getFirst();
    if (!first) return;
    const tx = first.x + this.scrollAmt;

    if (tx >= BONUSX4_THRESHOLD) {
      this.bonusMul = BONUSX4;
      this.bonus2.visible = true;
      this.bonus3.visible = true;
      this.bonus4.visible = true;
    } else if (tx >= BONUSX3_THRESHOLD) {
      this.bonusMul = BONUSX3;
      this.bonus2.visible = true;
      this.bonus3.visible = true;
      this.bonus4.visible = false;
    } else if (tx >= BONUSX2_THRESHOLD) {
      this.bonusMul = BONUSX2;
      this.bonus2.visible = true;
      this.bonus3.visible = false;
      this.bonus4.visible = false;
    } else {
      this.bonusMul = 1;
      this.bonus2.visible = false;
      this.bonus3.visible = false;
      this.bonus4.visible = false;
    }
  }

  private dotterScreenX(): number {
    return 0;
  }
  private dotterScreenY(): number {
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Object spawning (Game.addObject)
  // ---------------------------------------------------------------------------
  private addObject(): void {
    if (this.objects.length <= 0) {
      this.lastX = HEIGHT_BMD;
    }

    // Camping-spawn: every 30 inert frames, tag an extra "camper" obstacle.
    if (this.camping > 30) {
      this.camping = 0;
      this.camper += 1;
      const first = this.dotter.getFirst();
      let yPos = first ? first.y : MARGIN;
      const sq = this.makeSquare(this.camper > CAMPER ? 1 : 0);
      sq.x = this.lastX;
      const sqHeight = sq.height;
      if (yPos >= HEIGHT_BMD - MARGIN - sqHeight) {
        yPos = Math.ceil(HEIGHT_BMD - MARGIN - sqHeight / 2);
      } else if (yPos > MARGIN + sqHeight) {
        yPos = Math.floor(yPos - sqHeight / 2);
      } else if (yPos < MARGIN + sqHeight) {
        yPos = Math.floor(MARGIN - sqHeight / 3);
      }
      sq.y = yPos;
      sq.vscroll = 0;
      sq.camper = true;
      // Source uses Std.random(DOTCOLORS[colorTheme].length) — bound by live palette
      // size, not OBJECTS_COLOR length. With an empty palette stdRandom(0)=0.
      const tintCol = brighten(this.objectsPalette[stdRandom(this.palette.length)], 80);
      sq.view.tint = tintCol;
      sq.color = tintCol;
      this.placeSquare(sq);
      this.objects.push(sq);
      this.lastX = sq.x + sq.width * 1.1;
      return;
    }

    if (stdRandom(50) === 0 && !this.lastWasBonus) {
      const b = this.makeBonus();
      b.x = HEIGHT_BMD + this.scrollAmt;
      b.y = MARGIN + stdRandom(Math.ceil(HEIGHT_BMD - MARGIN * 2 - b.height));
      // Source bounds by DOTCOLORS[colorTheme].length (the live palette), not
      // OBJECTS_COLOR length.
      const c = this.objectsPalette[stdRandom(this.palette.length)];
      b.color = c;
      for (const part of b.parts) part.view.tint = c;
      this.placeBonus(b);
      this.abonus.push(b);
      this.lastX = b.x + 5;
      this.lastWasBonus = true;
      return;
    }

    if (stdRandom(100) <= LINE_BONUS && this.palette.length > 0 && !this.lastWasBonus) {
      const ln = this.makeLine();
      ln.vscroll = stdRandom(2) === 0 ? -1 : 1;
      ln.x = HEIGHT_BMD + this.scrollAmt;
      ln.y = MARGIN + stdRandom(Math.floor(HEIGHT_BMD - MARGIN * 2 - ln.height));
      this.placeLine(ln);
      this.objects.push(ln);
      this.lastX = ln.x + ln.width * 1.5;
      this.lastWasBonus = true;
      return;
    }

    const sq = this.makeSquare(this.camper > CAMPER ? 1 : 0);
    sq.x = HEIGHT_BMD + this.scrollAmt * this.objects.length;
    sq.y = this.getY(sq);
    sq.vscroll = stdRandom(2) === 0 ? -1 - (this.camper % 2) : 1 + (this.camper % 2);
    // Source bounds by DOTCOLORS[colorTheme].length (live palette), not
    // OBJECTS_COLOR length.
    const tintCol = brighten(this.objectsPalette[stdRandom(this.palette.length)], 80);
    sq.view.tint = tintCol;
    sq.color = tintCol;
    this.placeSquare(sq);
    this.objects.push(sq);
    this.lastX = sq.x + sq.width * 1.1;
    this.lastWasBonus = false;
  }

  private getY(o: { height: number }): number {
    let y = stdRandom(HEIGHT_BMD);
    if (y <= MARGIN) return MARGIN - 1;
    if (y >= HEIGHT_BMD - MARGIN - o.height) {
      y = HEIGHT_BMD - MARGIN - Math.floor(o.height) + 2;
      return y;
    }
    return y;
  }

  // ---------------------------------------------------------------------------
  // scrollObjects (Game.scrollObjects)
  // ---------------------------------------------------------------------------
  private scrollObjects(): void {
    if (this.objects.length <= 0) {
      this.addObject();
      return;
    }

    for (let i = 0; i < this.objects.length; i += 1) {
      const p = this.objects[i];
      // Source `Game.scrollObjects` recomputes `linked = dotter.getStarted()` and
      // `first = linked.first()` inside the per-object loop (Game.hx:475-476).
      // Capturing once outside the loop went stale after `dotter.remove(d.uid)`
      // on a square hit (line 1311 below), leaving `first` pointing at a
      // removed dot and shifting subsequent leading-dot comparisons one frame
      // off. Now refreshed per object to match source.
      const linked = this.dotter.getStarted();
      const first = linked[0];

      if (p.line) {
        if (this.palette.length <= 0) {
          this.objects.splice(i, 1);
          p.view.removeFromParent();
          i -= 1;
          continue;
        }
        // Source: `if( ocycle-- <= 0 )` — post-decrement.
        if (this.ocycle <= 0) {
          p.currentFrame = p.currentFrame === 0 ? 1 : 0;
          if (p.frames.length > 0) setFrame(p.view, p.frames[p.currentFrame % p.frames.length]);
          this.ocycle = BONUS_GLOW;
        } else {
          this.ocycle -= 1;
        }
      }

      if (first && first.x > p.x + p.width) {
        if (!p.line && this.camper > CAMPER) {
          if (p.frames.length >= 4) setFrame(p.view, p.frames[3]); // gotoAndStop(4) → exit
        }
        const ph = new Phys(p.view, 15);
        ph.fadeType = 5;
        ph.fadeLimit = 5;
        ph.vx = -this.scrollAmt;
        if (p.phys === null) p.phys = ph; // mark fade-out so the cleanup loop drives it
        this.objects.splice(i, 1);
        i -= 1;
        this.particles.push({ view: p.view, phys: ph, ttl: 15 });
        continue;
      }

      if (first && p.x - first.x <= 1 && first.x <= p.x + p.width) {
        for (const d of linked) {
          if (!p.line && this.camper > CAMPER) {
            const centerX = p.x + p.width / 2;
            const centerY = p.y + p.height / 2;
            const dx = centerX - d.x;
            const dy = centerY - d.y;
            if (Math.sqrt(dx * dx + dy * dy) < p.width * 3) {
              if (p.frames.length >= 3) setFrame(p.view, p.frames[2]); // hover
            }
          }

          if (!d.started) continue;
          if (!this.hit(p, d.x, d.y)) continue;

          if (p.line) {
            if (this.palette.length > 0 && !p.lineDone) {
              p.lineDone = true;
              const newCol = this.palette.pop();
              if (newCol !== undefined) this.dotter.addDot(newCol);
              this.pLines += 1;
              this.objects.splice(i, 1);
              i -= 1;
              const ph = new Phys(p.view, 10);
              ph.fadeType = 3;
              ph.fadeLimit = 20;
              this.particles.push({ view: p.view, phys: ph, ttl: 10 });
              break;
            }
            const ph = new Phys(p.view, 10);
            ph.fadeType = 3;
            this.particles.push({ view: p.view, phys: ph, ttl: 10 });
            continue;
          }

          // Square hit: return color to palette, remove dot.
          this.palette.push(d.color);
          this.fxShake(3);
          if (!d.ready) this.lastWasBonus = false;
          this.dotter.remove(d.uid);
          this.removeUIDot(d.color);
          this.fxFlash(p.view, 100, 0.8, d.color);
          if (this.dotter.getLength() <= 0) {
            this.step = GameStep.Ending;
          }
          this.pHit += 1;
          d.stopped = true;
          this.blowLine(d.x, d.y, d.color);
        }
      }

      if (p.x <= this.minAddConst && !p.added) {
        p.added = true;
        this.addObject();
      }

      if (p.x + p.width < -5) {
        if (p.line) this.lastWasBonus = false;
        this.objects.splice(i, 1);
        i -= 1;
        p.view.removeFromParent();
        continue;
      }

      p.x -= this.scrollAmt;
      p.view.x = p.x;

      if (!p.line) {
        if (p.vscroll > 0) {
          if (p.y + p.height >= HEIGHT_BMD - MARGIN) p.vscroll = -p.vscroll;
        }
        if (p.vscroll < 0) {
          if (p.y <= MARGIN) p.vscroll = -p.vscroll;
        }
      } else {
        if (p.vscroll > 0 && p.y + p.height >= HEIGHT_BMD - MARGIN) p.vscroll = -p.vscroll;
        if (p.vscroll < 0 && p.y <= MARGIN) p.vscroll = -p.vscroll;
      }

      const dy = (p.vscroll * this.vscrollConst) / 10;
      const dyCorr = this.dotter.cannotGoY ? 0 : this.dotYSpeed;
      p.y += dy - dyCorr;
      p.view.y = p.y + this.dotterScreenY();
    }
  }

  // ---------------------------------------------------------------------------
  // scrollBonus (Game.scrollBonus)
  // ---------------------------------------------------------------------------
  private scrollBonus(): void {
    const linked = this.dotter.getStarted();
    const first = linked[0];

    for (let i = 0; i < this.abonus.length; i += 1) {
      const b = this.abonus[i];

      b.x -= this.scrollAmt;
      b.view.x = b.x;
      const dy = this.vscrollConst / 10;
      b.y += dy - (this.dotter.cannotGoY ? 0 : this.dotYSpeed);
      b.view.y = b.y + this.dotterScreenY();

      if (b.x + b.width < -5) {
        this.lastWasBonus = false;
        this.abonus.splice(i, 1);
        i -= 1;
        b.view.removeFromParent();
        continue;
      }

      if (b.hit) continue;

      // Source: `if( bcycle-- <= 0 )` — post-decrement.
      if (this.bcycle <= 0) {
        b.currentFrame = b.currentFrame === 0 ? 1 : 0;
        this.bcycle = BONUS_GLOW;
      } else {
        this.bcycle -= 1;
      }

      if (first && first.x > b.x + b.width) {
        const ph = new Phys(b.view, 10);
        ph.fadeType = 5;
        ph.vx = -this.scrollAmt;
        this.particles.push({ view: b.view, phys: ph, ttl: 10 });
        this.abonus.splice(i, 1);
        i -= 1;
        continue;
      }

      let mult = 0;
      let hitX = 0;
      let hitY = 0;
      for (const d of linked) {
        if (b.x - d.x > 3) continue;

        if (this.hit2(b, b.b1, d.x, d.y) && !b.b1.hit) {
          this.removeBonusHit(b.b1, b, 0);
          mult += 1;
        }
        if (this.hit2(b, b.b2, d.x, d.y) && !b.b2.hit) {
          this.removeBonusHit(b.b2, b, 1);
          mult += 1;
        }
        if (this.hit2(b, b.b3, d.x, d.y) && !b.b3.hit) {
          this.removeBonusHit(b.b3, b, 2);
          mult += 1;
        }
        if (this.hit2(b, b.b4, d.x, d.y) && !b.b4.hit) {
          this.removeBonusHit(b.b4, b, 3);
          mult += 1;
        }
        hitX = d.x;
        hitY = d.y;
      }

      if (mult <= 0) continue;
      b.hit = true;

      if (mult >= 4) {
        this.score(hitX, hitY - 50, 'combo', BONUS_COMBO);
        this.pBonus += BONUS_COMBO;
        this.scoreVal += BONUS_COMBO;
        this.host.updateScore(this.scoreVal);
        continue;
      }

      this.score(hitX, hitY - 50, 'bonus', BASE_SCORE, mult, 20);
      const s = BASE_SCORE * mult;
      this.pBonus += s;
      this.scoreVal += s;
      this.host.updateScore(this.scoreVal);
    }
  }

  private removeBonusHit(bh: BonusHit, parent: BonusObject, sleep: number): void {
    bh.hit = true;
    const totalFrames = this.assets.bonusParts.length;
    const angStep = 360 / totalFrames;
    for (let i = 1; i < totalFrames; i += 1) {
      const part = makeSprite(this.assets.bonusParts[i % totalFrames]);
      part.tint = parent.color;
      part.x = bh.ox + parent.view.x;
      part.y = bh.oy + parent.view.y;
      this.bonusLayer.addChild(part);
      const an = (i + 1) * angStep;
      // Source `removeBonus` (Game.hx:417-418) overrides the just-constructed
      // Phys's authoritative `x`/`y` to `part._x + cos(an)*1` / `part._y +
      // sin(an)*1` BEFORE the first Phys.update — so the very first tick
      // advances the visual to part._x + cos(an)*6 (1 init offset + cos(an)*5
      // velocity), not part._x + cos(an)*5. The port had skipped this 1-pixel
      // launch offset; nudge `part.x/y` here so the Phys constructor captures
      // the offset position in `view.x/y`, matching source-equivalent visuals.
      part.x += gcos(an) * 1;
      part.y += gsin(an) * 1;
      const ph = new Phys(part, 13);
      ph.vx = gcos(an) * 5;
      ph.vy = gsin(an) * 5;
      ph.weight = 1.02;
      ph.sleep = sleep;
      this.particles.push({ view: part, phys: ph, ttl: 13 });
    }
    const hitPhys = new Phys(bh.view, 5);
    this.particles.push({ view: bh.view, phys: hitPhys, ttl: 5 });
  }

  // ---------------------------------------------------------------------------
  // Score popup (Game.score) — name picks asset; fadetype 4 for upward float.
  // ---------------------------------------------------------------------------
  private score(x: number, y: number, kind: 'line' | 'bonus' | 'combo', value: number, mult = 0, sleep = 0): void {
    // Source font sizes extracted via FFDec from gfx.xml DefineEditText:
    //   mcBonusCombo (chid 22 / score field chid 20): fontHeight 500 twips = 25 px
    //   mcLineScore  (chid 25 / score field chid 24): fontHeight 500 twips = 25 px
    //   mcBonusScore (chid 29 / score chid 26 + mult chid 28): 460 / 400 twips = 23 / 20 px
    //
    // R19 fixed font sizes but left TextField placement at (4, 4) — wrong on
    // every popup. R24: rendered the asset PNGs and traced the static placeholder
    // glyphs to recover the source's TextField anchor positions. The popup
    // template arts contain BAKED static glyphs (the "+" before line / combo
    // scores; the "X" between mult and score on bonus). The R7 port also
    // displayed the bonus mult with a wrong "x" prefix that compounded with
    // the asset's static "X" to read like "2000xX1". Source `b.mult.text =
    // Std.string( mult )` writes the raw digit; the asset's "X" is the
    // separator. Fix: drop the prefix, and place each TextField over its
    // matching placeholder on the asset (mult LEFT of "X", score RIGHT of "X"
    // for mcBonusScore; bottom-row score for mcLineScore / mcBonusCombo).
    let frame: Frame;
    let valueSize = 23;
    const multSize = 20;
    // Anchor positions are in exported-template bitmap coordinates. The
    // container pivot below restores the Flash symbol origin, while these
    // coordinates keep text aligned inside the original DefineEditText bounds.
    let valueX = 103.5;
    let valueY = 0;
    let multX = 16.5;
    let multY = 2;
    switch (kind) {
      case 'line':
        // line-score.png is 77x45 — "+ N" sits in the bottom row, the "+" is
        // static and "N" is the TextField (count of new dots, not a money score).
        frame = this.assets.lineScore;
        valueSize = 25;
        valueX = 51;
        valueY = 15;
        break;
      case 'combo':
        // bonus-combo.png is 148x81 — "bonus Combo" header + "+ NNNNN" footer.
        // Score TextField overlays the NNNNN placeholder.
        frame = this.assets.bonusCombo;
        valueSize = 25;
        valueX = 82;
        valueY = 50;
        break;
      default:
        // bonus-score.png is 154x28 — "N X NNNNN", mult LEFT of static "X",
        // score RIGHT. Anchors derived by tracing the placeholder glyphs.
        frame = this.assets.bonusScore;
        valueSize = 23;
        valueX = 103.5;
        valueY = 1;
        multX = 18;
        multY = 3;
    }
    const view = new Container();
    view.pivot.set(frame.pivotX, frame.pivotY);
    const sp = new Sprite(frame.texture);
    view.addChild(sp);
    const txt = new Text({
      text: String(value),
      style: { fontFamily: LINEA_FONT_SCORE, fontSize: valueSize, fill: 0xffffff },
    });
    txt.anchor.set(0.5, 0);
    txt.x = valueX;
    txt.y = valueY;
    view.addChild(txt);
    if (mult > 0) {
      // Source: `b.mult.text = Std.string( mult )`. NO "x" prefix — the
      // mcBonusScore asset has a static "X" between the two TextFields.
      const multTxt = new Text({
        text: String(mult),
        style: { fontFamily: LINEA_FONT_SCORE, fontSize: multSize, fill: 0xffffff },
      });
      multTxt.anchor.set(0.5, 0);
      multTxt.x = multX;
      multTxt.y = multY;
      view.addChild(multTxt);
    }
    view.x = x;
    view.y = y + this.dotterScreenY();
    this.uiLayer.addChild(view);
    const ph = new Phys(view, 15);
    ph.fadeType = 4;
    ph.vy = -1.2;
    ph.sleep = sleep;
    this.particles.push({ view, phys: ph, ttl: 15 + sleep });
  }

  // ---------------------------------------------------------------------------
  // blowLine — dot collision explosion, 40 particles in 4 radial shells.
  // ---------------------------------------------------------------------------
  private blowLine(x: number, y: number, color: number): void {
    const r = 2;
    const max = 10;
    const angStep = 360 / max;
    for (let j = 0; j < 4; j += 1) {
      for (let i = 0; i < max; i += 1) {
        const part = makeSprite(this.assets.part);
        part.tint = color;
        const an = angStep * i;
        part.x = x + gcos(an) * (r * j) + this.dotterScreenX();
        part.y = y + gsin(an) * (r * j) + this.dotterScreenY();
        part.rotation = (an * Math.PI) / 180;
        this.dotLayer.addChild(part);
        const ph = new Phys(part, 20);
        ph.vx = gcos(an) * (8 / (j + 1)) - (this.step < GameStep.Ending ? this.scrollAmt : 0);
        ph.vy = gsin(an) * (8 / (j + 1));
        this.particles.push({ view: part, phys: ph, ttl: 20 });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Hit tests (Game.hit / hit2)
  // ---------------------------------------------------------------------------
  private hit(o: AnyObject, x: number, y: number): boolean {
    if (o.line) {
      const dx = x - o.x;
      const dy = y - o.y;
      return Math.sqrt(dx * dx + dy * dy) < 15;
    }
    if (x < o.x) return false;
    if (x > o.x + o.width) return false;
    return y >= o.y && y <= o.y + o.height;
  }

  private hit2(parent: BonusObject, bh: BonusHit, x: number, y: number): boolean {
    const dx = parent.view.x + bh.ox - x;
    const dy = parent.view.y + bh.oy - y - this.dotterScreenY();
    return Math.sqrt(dx * dx + dy * dy) < 8;
  }

  // ---------------------------------------------------------------------------
  // FX (shake / flash)
  // ---------------------------------------------------------------------------
  fxShake(sh: number, shf = 0.5): void {
    this.shk = sh;
    this.shkFrict = shf;
    this.shkActive = true;
    this.updateFxShake();
  }
  private updateFxShake(): void {
    this.root.y = this.shk;
    this.shk *= -this.shkFrict;
    if (Math.abs(this.shk) < 0.2) {
      this.root.y = 0;
      this.shkActive = false;
    }
  }
  fxFlash(sp: Sprite, prc = 100, coef = 0.75, col = 0xffffff): void {
    for (const f of this.flasher) if (f.sp === sp) return;
    const filter = new ColorMatrixFilter();
    sp.filters = [filter];
    const f = { sp, prc, coef, col, filter };
    this.applyFlashMatrix(f);
    this.flasher.push(f);
  }
  private applyFlashMatrix(f: { sp: Sprite; prc: number; col: number; filter: ColorMatrixFilter }): void {
    // Source `Col.setPercentColor(sp, prc, col)` lerps each RGB channel of the
    // sprite toward `col` by p = prc/100 (so out = in*(1-p) + col*p).
    // Pixi v8 ColorMatrixFilter applies `out = M * in + offset`, where the
    // 5th column is the per-channel offset normalized to 0..1.
    const p = Math.max(0, Math.min(1, f.prc / 100));
    const d = 1 - p;
    const r = ((f.col >> 16) & 0xff) / 0xff;
    const g = ((f.col >> 8) & 0xff) / 0xff;
    const b = (f.col & 0xff) / 0xff;
    f.filter.matrix = [
      d, 0, 0, 0, r * p,
      0, d, 0, 0, g * p,
      0, 0, d, 0, b * p,
      0, 0, 0, 1, 0,
    ];
  }
  private clearFlashFilter(f: { sp: Sprite; filter: ColorMatrixFilter }): void {
    f.sp.filters = [];
    f.filter.destroy();
  }
  private updateFxFlash(): void {
    // Source order (Col.setPercentColor → _flhPrc *= _flhCoef): apply the
    // CURRENT prc to the matrix first, then decay for the next frame. The
    // port's R12 implementation decayed first, which advanced the visual by
    // one frame relative to the source. R14: swap to source order so the
    // first updateFxFlash after fxFlash() re-renders at 100% (matching the
    // source's one-frame hold) before the geometric decay begins.
    for (let i = 0; i < this.flasher.length; i += 1) {
      const f = this.flasher[i];
      this.applyFlashMatrix(f);
      f.prc *= f.coef;
      if (f.prc < 1) {
        this.clearFlashFilter(f);
        this.flasher.splice(i, 1);
        i -= 1;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Particles (Phys-driven popups, score floats, line-add fades)
  // ---------------------------------------------------------------------------
  private updateParticles(): void {
    for (let i = 0; i < this.particles.length; i += 1) {
      const p = this.particles[i];
      const alive = p.phys.step();
      if (!alive) {
        p.view.removeFromParent();
        this.particles.splice(i, 1);
        i -= 1;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // UI dot inventory
  // ---------------------------------------------------------------------------
  private addDotToUI(color: number): void {
    const w = 20;
    const g = new Graphics();
    // Source `Geom.drawRectangle(s, w=20, h=5, strokeCol=darken(color,50), 100,
    // fillCol=color, 100, thickness=1)` draws fill BEHIND stroke (Flash's
    // `lineStyle` then `beginFill` is rendered with the line on top of the
    // fill). In Pixi 8 the later `.fill()/.stroke()` call layers ON TOP, so
    // `.stroke().fill()` hides the stroke under the fill. Match the R13
    // makeBonusGlow ordering (`.fill().stroke()`) so the dark border is
    // actually visible — was an oversight from R1.
    g.rect(0, 0, w, 5).fill({ color }).stroke({ width: 1, color: darken(color, 50) });
    g.y = 7.5;
    g.x = 10 + this.uidots.length * w + 5;
    (g as Graphics & { _color: number })._color = color;
    this.uidots.push(g);
    this.uiLayer.addChild(g);
  }
  private removeUIDot(color: number): void {
    for (let i = 0; i < this.uidots.length; i += 1) {
      const u = this.uidots[i] as Graphics & { _color: number };
      if (u._color === color) {
        this.uidots.splice(i, 1);
        const ph = new Phys(u, 20);
        ph.fadeType = 4;
        this.particles.push({ view: u, phys: ph, ttl: 20 });
        i -= 1;
      }
    }
    for (let i = 0; i < this.uidots.length; i += 1) {
      this.uidots[i].x = 10 + i * 20 + 5;
    }
  }

  // ---------------------------------------------------------------------------
  // Sprite factories
  // ---------------------------------------------------------------------------
  private makeSquare(frame: 0 | 1): SquareObject {
    const frames = this.assets.square;
    const safeIdx = Math.min(frame, frames.length - 1);
    const sp = makeSprite(frames[safeIdx]);
    return {
      view: sp,
      frames,
      currentFrame: safeIdx,
      x: 0,
      y: 0,
      width: sp.width,
      height: sp.height,
      vscroll: 1,
      added: false,
      camper: false,
      line: false,
      bonus: false,
      lineDone: false,
      color: 0xffffff,
      phys: null,
    };
  }
  private placeSquare(s: SquareObject): void {
    s.view.x = s.x;
    s.view.y = s.y + this.dotterScreenY();
    this.objectsLayer.addChild(s.view);
  }

  private makeLine(): LineObject {
    const sp = makeSprite(this.assets.addLine);
    return {
      view: sp,
      frames: [this.assets.addLine],
      currentFrame: 0,
      x: 0,
      y: 0,
      width: sp.width,
      height: sp.height,
      vscroll: 1,
      added: false,
      camper: false,
      line: true,
      bonus: false,
      lineDone: false,
      color: 0xffffff,
      phys: null,
    };
  }
  private placeLine(l: LineObject): void {
    l.view.x = l.x;
    l.view.y = l.y + this.dotterScreenY();
    this.bonusLayer.addChild(l.view);
  }

  private makeBonus(): BonusObject {
    const view = new Container();
    // Four sub-hitboxes — authoritative positions extracted via FFDec from
    // gfx.swf DefineSprite chid:32 (mcBonus). PlaceObject2 matrices put each
    // mcSoloBonus child at translateX=112, translateY ∈ {40, 240, 440, 660}
    // twips; converting twips→pixels (÷20) yields x=5.6, y={2, 12, 22, 33}.
    // The parent MovieClip itself has no art; the visible pickup is these four
    // children. Keeping them separate lets the hit child shrink away over 5
    // frames exactly like `removeBonus(mc, b)` in Game.hx.
    const w = this.assets.bonus[0].texture.width;
    const h = this.assets.bonus[0].texture.height;
    const mkHit = (cx: number, cy: number): BonusHit => {
      const hv = makeSprite(this.assets.soloBonus);
      hv.x = cx;
      hv.y = cy;
      view.addChild(hv);
      return { view: hv, hit: false, ox: cx, oy: cy };
    };
    const b1 = mkHit(5.6, 2);
    const b2 = mkHit(5.6, 12);
    const b3 = mkHit(5.6, 22);
    const b4 = mkHit(5.6, 33);
    return {
      view,
      parts: [b1, b2, b3, b4],
      currentFrame: 0,
      x: 0,
      y: 0,
      width: w,
      height: h,
      color: 0xffffff,
      hit: false,
      b1,
      b2,
      b3,
      b4,
      phys: null,
    };
  }
  private placeBonus(b: BonusObject): void {
    b.view.x = b.x;
    b.view.y = b.y + this.dotterScreenY();
    this.bonusLayer.addChild(b.view);
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------
  private addUnderGuide(x: number, color: number): void {
    const g = new Graphics();
    g.rect(0, 0, 1, 260).fill({ color, alpha: 0.2 });
    g.x = x;
    g.y = 20;
    this.underLayer.addChild(g);
  }

  // Source `Game.hx:120-121` draws two horizontal palette-tinted accent lines
  // across the full playfield width at y=20 and y=280 via `addUILine` →
  // `Geom.drawLine(l, x1, y1=0, col, false, 0.25, alpha=100)`. Thickness 0.25
  // px, full alpha, palette-tinted; sits above the border PNGs to tie the
  // playfield edges to the random color theme. Pixi has no sub-pixel stroke,
  // so we draw a 1-px-tall rect at the same alpha — the visual is one row of
  // tinted pixels rather than a Flash sub-pixel-blended hairline, but the
  // palette-color framing is preserved.
  private addAccentLine(x: number, y: number, width: number, color: number): void {
    const g = new Graphics();
    g.rect(0, 0, width, 1).fill({ color, alpha: 1 });
    g.x = x;
    g.y = y;
    this.uiLayer.addChild(g);
  }

  private makeBonusGlow(x: number, y: number, color: number, width: number): Graphics {
    // Source `addBonusGlow` draws the rectangle with a single 0.8 alpha on both
    // fill and stroke (`Cs.setAlpha(mc, 0.8)` on the parent MovieClip). The
    // previous port stacked container `g.alpha = 0.8` on top of `fill alpha:0.8`,
    // yielding an effective fill alpha of 0.64 (R4 cosmetic bug). Drop the
    // container alpha and apply 0.8 explicitly to the stroke so both fill and
    // stroke read at exactly 0.8, matching the source's single-multiply.
    const g = new Graphics();
    g.rect(0, 0, width, 20).fill({ color, alpha: 0.8 }).stroke({ color, width: 1, alpha: 0.8 });
    g.x = x;
    g.y = y;
    return g;
  }

  // Release GPU resources owned outside the display tree. Dotter holds two
  // RenderTextures (`plane` is bound to the viewSprite, `scratch` is a
  // double-buffer not in any container) plus a Graphics scratchpad — none
  // of those are reached by `app.destroy({children:true})`.
  destroy(): void {
    // Release any in-flight fxFlash ColorMatrixFilters (each is owned outside
    // the display tree's automatic destroy walk because we wrap a `filters`
    // array, not a child sprite).
    for (const f of this.flasher) this.clearFlashFilter(f);
    this.flasher.length = 0;
    this.dotter.destroy();
    this.scroller.destroy();
  }
}

// -----------------------------------------------------------------------------
// Scroller — single-layer background (Scroller.hx port simplified for linea)
// -----------------------------------------------------------------------------

type ScrollerTile = Sprite & { _created?: boolean; ydiff?: number };

class ScrollerLayer {
  app: Application;
  host: Container;
  frame: Frame;
  width: number;
  height: number;
  margin = 0;
  tiles: ScrollerTile[] = [];

  constructor(app: Application, host: Container, frame: Frame, viewWidth: number, viewHeight: number) {
    this.app = app;
    this.host = host;
    this.frame = frame;
    this.width = viewWidth;
    this.height = viewHeight;
    this.add(0);
  }

  private add(x: number): void {
    const sp = makeSprite(this.frame) as ScrollerTile;
    sp.x = x;
    if (this.tiles.length === 0) {
      this.margin = sp.height >= this.height ? (sp.height - this.height) / 2 : (this.height - sp.height) / 2;
    }
    sp.y = -this.margin;
    sp.ydiff = 0;
    this.host.addChild(sp);
    this.tiles.push(sp);
  }

  // Source: Scroller.update(xSpeed, xMod, ySpeed). Linea calls with
  // xSpeed=1, xMod=DOT_X_SPEED, ySpeed=DOT_Y_SPEED, so vertical input drives a
  // small parallax-style bg shift bounded by `margin` on both sides.
  update(xSpeed: number, xMod: number, ySpeed: number): void {
    if (xSpeed === 0 && ySpeed === 0) return;
    for (let i = 0; i < this.tiles.length; i += 1) {
      const s = this.tiles[i];
      if (xSpeed !== 0) {
        if (s.x <= 0 && !s._created) {
          this.add(s.x + s.width);
          s._created = true;
        }
        if (s.x + s.width <= 0) {
          s.removeFromParent();
          this.tiles.splice(i, 1);
          i -= 1;
          continue;
        }
        const adj = xMod < 0 && Math.abs(xMod) > xSpeed ? 0 : xMod;
        s.x -= xSpeed + adj;
      }

      if (ySpeed === 0) continue;

      const ydiff = s.ydiff ?? 0;
      // Inside the margin band: tile freely tracks the dot Y input.
      if (Math.abs(ydiff) < this.margin) {
        s.y -= ySpeed;
        s.ydiff = ydiff + ySpeed;
        continue;
      }
      // At top of band, dot moving down (ySpeed > 0): allow only if tile not
      // already past the upper margin (mirrors source: s._y >= margin gate).
      if (ydiff <= 0 && ydiff <= this.margin && ySpeed > 0) {
        if (s.y >= this.margin) continue;
        s.y -= ySpeed;
        s.ydiff = ydiff + ySpeed;
        continue;
      }
      // At bottom of band, dot moving up (ySpeed < 0): allow only when tile is
      // at the upper bound.
      if (ydiff >= 0 && ydiff >= this.margin && ySpeed < 0 && s.y <= 0) {
        s.y -= ySpeed;
        s.ydiff = ydiff + ySpeed;
        continue;
      }
    }
  }

  destroy(): void {
    for (const t of this.tiles) t.removeFromParent();
    this.tiles = [];
  }
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export async function mount(container: HTMLElement, context?: GameMountContext): Promise<GameInstance> {
  const app = new Application();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      background: '#000000',
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    }),
    Promise.all([loadLineaFonts(), loadAssets()]).then(([, loadedAssets]) => loadedAssets),
  ]);
  container.appendChild(app.canvas);

  const game = new LineaGame(app, assets, context?.host ?? noopGameHost);

  const tracked = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const onKeyDown = (event: KeyboardEvent) => {
    if (tracked.has(event.key)) {
      event.preventDefault();
      game.keys.add(event.key);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (tracked.has(event.key)) {
      event.preventDefault();
      game.keys.delete(event.key);
    }
  };
  // Clear arrow-key state on focus loss so the dot doesn't keep drifting after
  // the tab loses focus mid-press.
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
    while (acc >= STEP_SECONDS && guard < 8) {
      game.step_();
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
      // Release Dotter's off-tree RenderTextures (the `scratch` double-buffer
      // is never parented to a Container, so app.destroy({children:true})
      // would leak it). Then tear down Pixi without destroying textures —
      // textures are owned by the global Assets cache, and destroying them
      // here would (a) emit a "Texture managed by Assets was destroyed"
      // warning every mount/destroy cycle and (b) force a full asset re-fetch
      // on every replay.
      game.destroy();
      app.destroy(true, { children: true, texture: false });
    },
  };
}
