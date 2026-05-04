// Game — port of Game.hx. Owns the state machine (Scroll/Intro/Play/GameOver),
// procedural map generation, plasma backdrop, scoring, and the entity lists.

import { Application, BlurFilter, ColorMatrixFilter, Container, Graphics, Matrix, RenderTexture, Sprite, Text } from 'pixi.js';
import type { GameHost } from '../types';
import { loadFrame, loadSeries, makeSprite, setFrame } from '../_shared/frames';

import {
  ASSET_ROOT,
  BALL_DRUNK,
  BALL_FIRE,
  BALL_HALO,
  BALL_ICE,
  BALL_KAMIKAZE,
  BALL_STANDARD,
  BALL_YOYO,
  BH,
  BW,
  DIR,
  DOOR_COEF,
  MAX_BALL,
  MCH,
  MCW,
  PAD_AIMANT,
  PAD_GLUE,
  PAD_LASER,
  PAD_PROTECTION,
  PAD_SHAKE,
  PAD_SIDE,
  PAD_TIME,
  PQ,
  SIDE,
  SKIN,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  XMAX,
  YMAX,
  getX,
  getY,
} from './constants';
import type { AlphabounceAssets, FxParticle, GameContext } from './game-context';
import { Ball } from './ball';
import { Pad } from './pad';
import { Block } from './block';
import { Option, OPTION_NAMES, getOptionColor } from './option';
import { Event, Javelot, Quasar, Unification, Wave } from './events';
import { Laser, Shot } from './shots';
import { killPart, makePart, updateParticles } from './fx';

// Step states.
const enum Step {
  Scroll,
  Intro,
  Play,
  GameOver,
}

const FONT_TITLE = 'Alphabounce Kiloton Title';
const FONT_SCORE = 'Alphabounce Kiloton Score';

async function loadBrowserFont(family: string, url: string): Promise<void> {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return;
  const font = new FontFace(family, `url(${url})`);
  await font.load();
  document.fonts.add(font);
}

async function loadAlphabounceFonts(root: string): Promise<void> {
  await Promise.all([
    loadBrowserFont(FONT_TITLE, `${root}/kiloton-condensed-bold.ttf`),
    loadBrowserFont(FONT_SCORE, `${root}/kiloton-condensed.ttf`),
    loadBrowserFont('Alphabounce Verdana', `${root}/verdana-bold.ttf`),
  ]);
}

export async function loadAssets(): Promise<AlphabounceAssets> {
  const root = ASSET_ROOT;
  await loadAlphabounceFonts(root);
  const [
    brush,
    greenBar,
    iceStone,
    javelot,
    laser,
    ondeRay,
    option,
    pad,
    padSide,
    padMid,
    padMidPowerBase,
    padPower,
    partBubble,
    partGlue,
    partIceShard,
    partLight,
    partLine,
    partLineUp,
    part,
    pinkBar,
    quasar,
    score,
    scroll,
    scrollBg,
    title,
    titleLevel,
    wave,
    ball,
    bg,
    blink,
    block,
    blockLife,
    ice,
    onde,
    partExplode,
    partGlass,
    partSpark,
    partTwinkle,
    protection,
    shape,
    side,
  ] = await Promise.all([
    loadFrame(`${root}/brush.png`, 0, 0),
    loadFrame(`${root}/green-bar.png`, 0, 0),
    loadFrame(`${root}/ice-stone.png`, 0, 0),
    loadFrame(`${root}/javelot.png`, 0, 0),
    loadFrame(`${root}/laser.png`, 0, 0),
    loadFrame(`${root}/onde-ray.png`, 0, 0),
    loadFrame(`${root}/option.png`, 0, 0),
    loadFrame(`${root}/pad.png`, 0, 0),
    loadSeries(`${root}/pad-side`, 8, 0, 0),
    loadSeries(`${root}/pad-mid`, 7, 0, 0),
    loadFrame(`${root}/pad-mid-power-base/1.png`, 0, 0),
    loadFrame(`${root}/pad-power/1.png`, 50, 1),
    loadFrame(`${root}/part-bubble.png`, 0, 0),
    loadFrame(`${root}/part-glue.png`, 0, 0),
    loadFrame(`${root}/part-ice-shard.png`, 0, 0),
    loadFrame(`${root}/part-light.png`, 0, 0),
    loadFrame(`${root}/part-line.png`, 0, 0),
    loadFrame(`${root}/part-line-up.png`, 0, 0),
    loadFrame(`${root}/part.png`, 0, 0),
    loadFrame(`${root}/pink-bar.png`, 0, 0),
    loadFrame(`${root}/quasar.png`, 0, 0),
    loadFrame(`${root}/score.png`, 0, 0),
    loadFrame(`${root}/scroll.png`, 0, 0),
    loadFrame(`${root}/scroll-bg.png`, 0, 0),
    loadFrame(`${root}/title.png`, 0, 0),
    loadFrame(`${root}/title-level.png`, 0, 0),
    loadFrame(`${root}/wave.png`, 0, 0),
    loadSeries(`${root}/ball`, 8, 19.5, 12),
    loadSeries(`${root}/bg`, 6, 0, 0),
    // FFDec exports mcBlink's whole 191px sweep bounds; Flash's origin is the
    // clipped 30x10 block mask at x≈79/y≈1 inside that canvas.
    loadSeries(`${root}/blink`, 9, 79, 1),
    loadSeries(`${root}/block`, 6, 0, 0),
    loadSeries(`${root}/block-life`, 5, 0, 0),
    loadSeries(`${root}/ice`, 2, 0, 0),
    loadSeries(`${root}/onde`, 11, 0, 0),
    // The exported sprite has 45 frames, but the SWF runs a frame action after
    // frame 23 that stops/removes the visible burst before the blank tail and
    // final reset-shaped frame. Loading only the playable visible run prevents a
    // destroyed block from flashing back as frame 45.
    loadSeries(`${root}/part-explode`, 23, 15.5, 10.5),
    loadSeries(`${root}/part-glass`, 2, 0, 0),
    loadSeries(`${root}/part-spark`, 2, 0, 0),
    loadSeries(`${root}/part-twinkle`, 6, 0, 0),
    loadSeries(`${root}/protection`, 14, 0, 0),
    loadSeries(`${root}/shape`, 8, 0, 0),
    loadSeries(`${root}/side`, 10, 0, 0),
  ]);
  return {
    brush,
    greenBar,
    iceStone,
    javelot,
    laser,
    ondeRay,
    option,
    pad,
    padSide,
    padMid,
    padMidPowerBase,
    padPower,
    partBubble,
    partGlue,
    partIceShard,
    partLight,
    partLine,
    partLineUp,
    part,
    pinkBar,
    quasar,
    score,
    scroll,
    scrollBg,
    title,
    titleLevel,
    wave,
    ball,
    bg,
    blink,
    block,
    blockLife,
    ice,
    onde,
    partExplode,
    partGlass,
    partSpark,
    partTwinkle,
    protection,
    shape,
    side,
  };
}

type TitlePopup = {
  view: Container;
  text: Text;
  bl: number; // blur amount — fed straight into BlurFilter.strengthX (matches source `Filt.blur(mc, mc.bl, 0)`)
  blur: BlurFilter;
  t: number; // timer countdown
  blink: boolean;
  frameAcc: number;
};

export class AlphabounceGame implements GameContext {
  app: Application;
  assets: AlphabounceAssets;
  host: GameHost;

  // Layers (DepthManager equivalent).
  root = new Container();
  bgLayer = new Container();
  plasmaLayer = new Container();
  underPartsLayer = new Container();
  blockLayer = new Container();
  sideLayer = new Container();
  blockOverlayLayer = new Container();
  padLayer = new Container();
  optionLayer = new Container();
  ballLayer = new Container();
  partsLayer = new Container();
  interLayer = new Container();

  // World state (GameContext fields).
  grid: Array<Array<Block | null>> = [];
  blocks: Block[] = [];
  balls: Ball[] = [];
  options: Option[] = [];
  events: Event[] = [];
  shots: Shot[] = [];
  particles: FxParticle[] = [];
  pad!: Pad;

  lvl = 0;
  block = 0;
  blockTotal = 0;
  levelTimer = 0;
  autoLaunchTimer = 0;
  flSafe = false;
  flDoor = false;
  flPress = false;
  flClick = false;
  tmod = 1;
  timeCoef: number | null = null;
  accTimer = 0;
  scroll = 1;

  // Step state.
  private step: Step = Step.Scroll;

  // Background frame.
  bg: Sprite;
  // Side panels (left/right boundary "doors") — 2 instances of multi-frame mcSide.
  // The intro reverse-steps the left panel (closing it as you enter), and the
  // right panel forward-steps once `flDoor` opens. Round 13: per-frame ticker
  // gated by `tmod` (each panel accumulates fractional frames); replaces the
  // round-1 snap-to-last frame.
  sides: Sprite[] = [];
  sideFrameIdx: number[] = [0, 0];
  // Fractional-frame accumulators per panel (left = 0, right = 1). 1 unit of
  // tmod ≈ 1 SWF frame, matching `mc.play()` advancing 1 frame per engine tick.
  sideAcc: number[] = [0, 0];

  // Plasma.
  plasmaRT: RenderTexture;
  plasmaScratchRT: RenderTexture;
  plasmaSprite: Sprite;
  // Offscreen sprite/filter chain used to bake Flash's BitmapData blur +
  // alpha-offset decay into the plasma texture.
  private plasmaDecaySprite: Sprite;
  private plasmaBlur: BlurFilter | null = null;
  private plasmaAlphaDecay: ColorMatrixFilter | null = null;
  pq = PQ;

  // Title overlay (intro "NIVEAU N").
  mcTitle: { view: Container; text: Text; timer: number } | null = null;
  // Floating titles ("EXTENSION", "AIMANT", ...).
  titles: TitlePopup[] = [];

  // Procedural model.
  model: Array<Array<number | null>> = [];
  // bmpPaint emulation: per-cell color array filled by genPalette.
  bmpPaint: number[][] = [];

  // Score.
  score = 0;
  scoreText: Text;
  gameOverText: Text;

  // Ended flag — ensures KKApi.gameOver-like signal fires once.
  signalSent = false;

  constructor(app: Application, assets: AlphabounceAssets, host: GameHost) {
    this.app = app;
    this.assets = assets;
    this.host = host;

    app.stage.addChild(this.root);
    this.root.addChild(
      this.bgLayer,
      this.plasmaLayer,
      this.underPartsLayer,
      this.blockLayer,
      this.sideLayer,
      this.blockOverlayLayer,
      this.padLayer,
      this.optionLayer,
      this.ballLayer,
      this.partsLayer,
      this.interLayer,
    );

    // Background.
    this.bg = makeSprite(assets.bg[0]);
    this.bgLayer.addChild(this.bg);

    // 2 side instances at left & right (mirrored x-scale).
    // Left panel starts at the last (open) frame so the level-entry intro can
    // animate it closed in a per-frame reverse step (round 13).
    const lastSide = assets.side.length - 1;
    this.sideFrameIdx = [lastSide, 0];
    for (let i = 0; i < 2; i += 1) {
      const sp = makeSprite(assets.side[this.sideFrameIdx[i]]);
      sp.x = i * MCW;
      sp.scale.x = -(i * 2 - 1);
      this.sides.push(sp);
      this.sideLayer.addChild(sp);
    }

    // Plasma RenderTexture (downsampled by PQ).
    const pw = Math.max(1, Math.floor(MCW * this.pq));
    const ph = Math.max(1, Math.floor(MCH * this.pq));
    this.plasmaRT = RenderTexture.create({ width: pw, height: ph });
    this.plasmaScratchRT = RenderTexture.create({ width: pw, height: ph });
    // Source creates the plasma BitmapData as transparent black:
    // `new BitmapData(..., true, 0x00000000)`. Pixi render textures can
    // contain undefined GPU memory until first cleared; if that memory is
    // white, the add-blended plasma sprite washes the whole playfield out.
    this.clearPlasmaTexture(this.plasmaRT);
    this.clearPlasmaTexture(this.plasmaScratchRT);
    this.plasmaSprite = new Sprite(this.plasmaRT);
    this.plasmaSprite.scale.set(1 / this.pq);
    this.plasmaSprite.blendMode = 'add';

    // Source applies BlurFilter to the BitmapData and then
    // ColorTransform(..., alphaOffset=-2). Bake that into a scratch RT each
    // frame instead of drawing a full-screen multiply fader: multiply blending
    // fills transparent pixels in Pixi, which turns the add-blended plasma
    // layer white.
    this.plasmaDecaySprite = new Sprite(this.plasmaRT);
    this.plasmaBlur = new BlurFilter({ strength: 2 });
    this.plasmaAlphaDecay = new ColorMatrixFilter();
    this.plasmaAlphaDecay.matrix = [
      1, 0, 0, 0, 0,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, -2 / 255,
    ];
    this.plasmaDecaySprite.filters = [this.plasmaBlur, this.plasmaAlphaDecay];
    this.plasmaLayer.addChild(this.plasmaSprite);

    // Pad.
    this.pad = new Pad(this);

    // Score HUD.
    this.scoreText = new Text({
      text: '0',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 12, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 3 } },
    });
    this.scoreText.position.set(8, STAGE_HEIGHT - 18);
    this.interLayer.addChild(this.scoreText);

    this.gameOverText = new Text({
      text: '',
      style: { fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 22, fontWeight: '700', fill: 0xffffff, stroke: { color: 0x000000, width: 4 } },
    });
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(STAGE_WIDTH * 0.5, STAGE_HEIGHT * 0.5);
    this.interLayer.addChild(this.gameOverText);

    // Initial scroll (entry transition).
    this.initScroll(1);
    this.host.updateScore(0);
  }

  // ---------------------------------------------------------------------------
  // Per-tick update
  // ---------------------------------------------------------------------------
  step_(): void {
    // tmod-based slow-mo when pad.flStop is true.
    if (this.pad.flStop) {
      if (this.timeCoef === null) this.timeCoef = 1;
      this.timeCoef = Math.max(this.timeCoef - 0.1, 0.1);
    } else if (this.timeCoef !== null) {
      this.timeCoef = Math.min(this.timeCoef + 0.1, 1);
      if (this.timeCoef >= 1) this.timeCoef = null;
    }
    this.tmod = this.timeCoef ?? 1;

    switch (this.step) {
      case Step.Scroll:
        this.updateScroll();
        break;
      case Step.Intro:
        this.updateIntro();
        break;
      case Step.Play:
        this.updatePlay();
        break;
      case Step.GameOver:
        this.updateGameOver();
        break;
    }

    // Right-side door ticker (round 13): once `flDoor` is set, advance the
    // right panel one frame per tmod tick toward fully-open. Runs across all
    // post-Scroll phases so the door keeps animating even if game ends mid-open.
    this.updateRightDoor();

    this.updatePlasma();
    this.updateTitle();
    this.flClick = false;
  }

  private updateSprites(): void {
    // Iterate snapshots to allow safe mutation.
    // Source `Sprite.spriteList` updates in creation order; the pad is created
    // before balls/options, so its same-frame movement must be visible to ball
    // pad-collision checks.
    if (this.pad) this.pad.update();
    const balls = this.balls.slice();
    for (const b of balls) if (b.alive) b.update();
    const opts = this.options.slice();
    for (const o of opts) if (o.alive) o.update();
    const shots = this.shots.slice();
    for (const s of shots) if (s.alive) s.update();
    updateParticles(this);
  }

  // ---------------------------------------------------------------------------
  // Scroll phase
  // ---------------------------------------------------------------------------
  private initScroll(n: number): void {
    this.step = Step.Scroll;
    this.scroll = n;
    this.pad.init();
    setFrame(this.bg, this.assets.bg[this.lvl % this.assets.bg.length]);
    this.initGrid();
    this.fillGrid();
    this.accTimer = 0;
    this.flDoor = false;
    this.updateScroll();
  }

  private updateScroll(): void {
    this.scroll = Math.min(this.scroll + 0.05 * this.tmod, 1);
    this.root.x = (1 - this.scroll) * MCW;
    this.pad.x += 3;
    this.pad.updatePos();
    if (this.scroll === 1) this.initIntro();
  }

  // ---------------------------------------------------------------------------
  // Intro phase
  // ---------------------------------------------------------------------------
  private initIntro(): void {
    this.step = Step.Intro;
    const view = new Container();
    const banner = new Graphics()
      .rect(0, 0, MCW, 10)
      .fill({ color: 0xffffff, alpha: 0.3 })
      .rect(0, 10, MCW, 30)
      .fill({ color: 0xffffff, alpha: 0.5 })
      .rect(0, 40, MCW, 10)
      .fill({ color: 0xffffff, alpha: 0.3 });
    view.addChild(banner);
    const text = new Text({
      text: `NIVEAU ${this.lvl + 1}`,
      style: { fontFamily: FONT_TITLE, fontSize: 48, fill: 0xffffff, stroke: { color: 0xa6a6dc, width: 3 } },
    });
    text.anchor.set(0.5);
    text.x = MCW * 0.5;
    text.y = 25;
    view.addChild(text);
    view.x = 0;
    view.y = -60;
    this.interLayer.addChild(view);
    this.mcTitle = { view, text, timer: 30 };
  }

  private updateIntro(): void {
    if (!this.mcTitle) return;
    this.mcTitle.view.y = Math.min(this.mcTitle.view.y + 10, 10);

    // Reverse-step the left side animation toward frame 0. SWF `mc.prevFrame()`
    // (Game.hx:211) advances exactly 1 frame per engine tick, independent of
    // `mt.Timer.tmod`. Round 13 incorrectly multiplied by `tmod`, which slowed
    // the intro 10× during TIME-pad slow-mo (no slow-mo can fire here, but the
    // shape was wrong); round 14 restores raw 1 frame/tick to match source.
    this.sideAcc[0] += 1;
    while (this.sideAcc[0] >= 1 && this.sideFrameIdx[0] > 0) {
      this.sideFrameIdx[0] -= 1;
      this.sideAcc[0] -= 1;
    }
    if (this.sideFrameIdx[0] === 0) this.sideAcc[0] = 0;
    setFrame(this.sides[0], this.assets.side[this.sideFrameIdx[0]]);

    if (this.sideFrameIdx[0] === 0 && this.mcTitle.view.y === 10) {
      this.initPlay();
      const cx = MCW * 0.5;
      const cy = this.mcTitle.view.y + 25;
      for (let i = 0; i < 64; i += 1) {
        const sp = makeSprite(this.assets.partLight);
        sp.anchor.set(0.5);
        this.interLayer.addChild(sp);
        const px = Math.random() * MCW;
        const py = this.mcTitle.view.y + Math.random() * 50;
        const dx = px - cx;
        const dy = py - cy;
        const a = Math.atan2(dy, dx);
        const dist = Math.sqrt(dx * dx + dy * dy);
        const sp2 = dist * 0.1;
        makePart(this, {
          kind: 'phys',
          view: sp,
          x: px,
          y: py,
          vx: Math.cos(a) * sp2,
          vy: Math.sin(a) * sp2,
          timer: 10 + Math.random() * 10,
          life: 20,
          frict: 0.9,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Play phase
  // ---------------------------------------------------------------------------
  private initPlay(): void {
    this.step = Step.Play;
    const b = this.newBall();
    const rnd = Math.random() * 2 - 1;
    b.gluePoint = rnd * 20;
    b.moveTo(this.pad.x, this.pad.y);
    b.vx = 0;
    b.vy = 1;
    b.update();
    b.colPad(rnd);
    this.levelTimer = 0;
    this.autoLaunchTimer = 0;
    this.flSafe = this.lvl === 0;
  }

  private updatePlay(): void {
    this.levelTimer += this.tmod;
    this.autoLaunchTimer += this.tmod;
    if (this.autoLaunchTimer > 200) {
      this.autoLaunchTimer = 0;
      for (const b of this.balls) b.gluePoint = null;
    }

    let mult = 1;
    if (this.lvl >= 5) mult = (this.lvl - 3) * 0.5;
    this.accTimer += mult * this.tmod;
    if (this.accTimer > 100 /* TEMPO */) {
      for (const b of this.balls) b.setSpeed(b.speed + 0.5);
      this.accTimer = 0;
    }

    if (this.flDoor) this.checkEnd();

    if (this.mcTitle) {
      this.mcTitle.timer -= this.tmod;
      if (this.mcTitle.timer < 0) {
        this.mcTitle.view.y -= 11 - this.mcTitle.view.y;
        if (this.mcTitle.view.y < -60) {
          this.mcTitle.view.removeFromParent();
          this.mcTitle = null;
        }
      }
    }

    this.updateSprites();
    for (const e of this.events.slice()) {
      if (e.alive) e.update();
    }
  }

  // ---------------------------------------------------------------------------
  // GameOver
  // ---------------------------------------------------------------------------
  initGameOver(): void {
    if (this.step === Step.GameOver) return;
    this.step = Step.GameOver;
    if (!this.signalSent) {
      this.signalSent = true; // KKApi.gameOver({}) — no-op in port
      this.host.endRun({ score: this.score });
    }
    this.gameOverText.text = 'GAME OVER';
  }
  private updateGameOver(): void {
    // Source Game.hx leaves updateGameOver empty; sprites freeze while the
    // outer update still runs plasma/title maintenance.
  }

  // ---------------------------------------------------------------------------
  // Block / level transition
  // ---------------------------------------------------------------------------
  removeBlock(): void {
    this.block -= 1;
    const c = this.block / Math.max(1, this.blockTotal);
    if (!this.flDoor && c < DOOR_COEF) this.openDoor();
  }
  private openDoor(): void {
    this.flDoor = true;
    // Reset the right-panel accumulator so updateRightDoor begins forward-stepping
    // from the current frame on the next tick. Round 13 replaces the previous
    // snap-to-last with a per-frame ticker driven by tmod.
    this.sideAcc[1] = 0;
  }
  private updateRightDoor(): void {
    if (!this.flDoor) return;
    const last = this.assets.side.length - 1;
    if (this.sideFrameIdx[1] >= last) return;
    // Source: `openDoor` calls `mc.play()` (Game.hx:296). Flash MovieClip
    // auto-play advances at SWF frame rate (40 FPS) and is NOT gated by
    // `mt.Timer.tmod`. Round 13 used `tmod` (slowing the door 10× during
    // TIME-pad slow-mo); round 14 restores 1 frame per tick to match source.
    this.sideAcc[1] += 1;
    while (this.sideAcc[1] >= 1 && this.sideFrameIdx[1] < last) {
      this.sideFrameIdx[1] += 1;
      this.sideAcc[1] -= 1;
    }
    if (this.sideFrameIdx[1] >= last) this.sideAcc[1] = 0;
    setFrame(this.sides[1], this.assets.side[this.sideFrameIdx[1]]);
  }
  private checkEnd(): void {
    if (this.pad.x >= MCW - (this.pad.ray + SIDE - 1)) {
      while (this.balls.length > 0) {
        const b = this.balls.pop();
        if (b) b.kill();
      }
      while (this.options.length > 0) {
        const o = this.options.pop();
        if (o) o.kill();
      }
      while (this.events.length > 0) {
        const e = this.events[0];
        e.kill();
      }
      this.pad.flGo = true;
    }
  }
  leaveLevel(): void {
    this.lvl += 1;
    // Reset side frames + accumulators + pad position. Left panel starts open
    // (last frame); the next intro reverse-steps it closed via updateIntro.
    this.sideFrameIdx = [this.assets.side.length - 1, 0];
    this.sideAcc = [0, 0];
    setFrame(this.sides[0], this.assets.side[this.sideFrameIdx[0]]);
    setFrame(this.sides[1], this.assets.side[0]);
    this.pad.x = this.pad.ray;
    this.pad.updatePos();
    this.initScroll(0);
  }

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------
  newOption(t: number | null, x?: number, y?: number): void {
    const xv = x ?? this.pad.x;
    const yv = y ?? this.pad.y - 60;
    const opt = new Option(this);
    opt.x = xv;
    opt.y = yv;
    opt.setType(t);
  }

  getOption(id: number): void {
    switch (id) {
      case 0: // A IMANT
        this.pad.setType(PAD_AIMANT);
        break;
      case 1: // B LINDAGE
        for (const bl of this.blocks) if (bl.type < 5) bl.setLife(bl.life + 2);
        break;
      case 2: // C OLLE
        this.pad.setType(PAD_GLUE);
        break;
      case 3: // D IMINUTION
        this.pad.setRay(Math.max(this.pad.ray - 15, PAD_SIDE + 1));
        this.pad.powerUp();
        break;
      case 4: // E XTENSION
        this.pad.setRay(Math.min(this.pad.ray + 15, 80));
        this.pad.powerUp();
        break;
      case 5: // F LAMME
        for (const b of this.balls) b.setType(BALL_FIRE);
        break;
      case 6: // G LACE
        for (const b of this.balls) b.setType(BALL_ICE);
        break;
      case 7: // HALO
        for (const b of this.balls) b.setType(BALL_HALO);
        break;
      case 8: // I NVERSION
        this.pad.moveFactor = (this.pad.moveFactor * -1) as 1 | -1;
        break;
      case 9: // J AVELOT
        new Javelot(this);
        break;
      case 10: // K AMIKAZE
        for (const b of this.balls) b.setType(BALL_KAMIKAZE);
        break;
      case 11: // L ASER
        this.pad.setType(PAD_LASER);
        break;
      case 12: {
        // M ULTI-BALL
        const list = this.balls.slice();
        for (const b of list) {
          if (this.balls.length >= MAX_BALL) break;
          if (b.type === 7 /* SHADE */) continue;
          const ball = b.clone();
          const a = Math.atan2(b.vy, b.vx);
          const ma = 0.15;
          ball.vx = Math.cos(a + ma) * ball.speed;
          ball.vy = Math.sin(a + ma) * ball.speed;
          b.vx = Math.cos(a - ma) * b.speed;
          b.vy = Math.sin(a - ma) * b.speed;
        }
        break;
      }
      case 13: // N ERVEUX
        this.pad.setType(PAD_SHAKE);
        break;
      case 14: // O UVRE
        if (!this.flDoor) this.openDoor();
        break;
      case 15: // P ROTECTION
        this.pad.setType(PAD_PROTECTION);
        break;
      case 16: // Q UASAR
        new Quasar(this);
        break;
      case 17: // R LENTISSEMENT
        for (const b of this.balls) b.setSpeed(Math.max(b.speed - 5, 3));
        break;
      case 18: // S AUVETAGE ACTIF
        this.levelTimer = 0;
        this.flSafe = true;
        break;
      case 19: // T EMPORALITE
        this.pad.setType(PAD_TIME);
        break;
      case 20: // U NIFICATION
        new Unification(this);
        break;
      case 21: // V AGUE
        new Wave(this);
        break;
      case 22: // W HISKY
        for (const b of this.balls) b.setType(BALL_DRUNK);
        break;
      case 23: // X ENOPHOBIE
        for (const b of this.balls) b.setType(BALL_STANDARD);
        break;
      case 24: // Y OYO
        for (const b of this.balls) b.setType(BALL_YOYO);
        break;
      case 25: // Z ELE
        for (const b of this.balls) b.setSpeed(b.speed + 5);
        break;
    }
    this.newTitle(OPTION_NAMES[id], getOptionColor(id));
  }

  // ---------------------------------------------------------------------------
  // Grid generation
  // ---------------------------------------------------------------------------
  private initGrid(): void {
    this.grid = [];
    for (let x = 0; x < XMAX; x += 1) {
      const col: Array<Block | null> = [];
      for (let y = 0; y < YMAX; y += 1) col.push(null);
      this.grid.push(col);
    }
  }

  private fillGrid(): void {
    // Clear residual blocks (we recreate Block instances below).
    for (const b of this.blocks.slice()) b.kill();
    this.blocks = [];

    this.genPalette();
    let to = 0;
    while (true) {
      this.genModel();
      let bl = 0;
      for (let x = 0; x < XMAX; x += 1) {
        for (let y = 0; y < YMAX; y += 1) {
          if (this.model[x] && this.model[x][y] !== null && this.model[x][y] !== undefined) bl += 1;
        }
      }
      if (to > 10 || bl > 20 + this.lvl * 25) break;
      to += 1;
    }

    this.block = 0;
    for (let y = 0; y < YMAX; y += 1) {
      for (let x = 0; x < XMAX; x += 1) {
        const t = this.model[x]?.[y];
        if (t !== null && t !== undefined) {
          new Block(this, x, y, t);
        }
      }
    }
    this.blockTotal = this.block;
  }

  // ---------------------------------------------------------------------------
  // Procedural palette + model. Original used BitmapData stamps with the
  // mcBrush + mcShape symbols. We render those sprites into a small
  // RenderTexture, then read back via renderer.extract for per-cell colors
  // (palette) and for the binary fill mask (model).
  // ---------------------------------------------------------------------------
  private genPalette(): void {
    // Pure-numeric approximation: random per-cell colour drawn from SKIN[0]
    // base + per-stamp brush offset. Avoids round-tripping through pixel
    // readback (Pixi 8 requires async extract for image data which doesn't
    // fit the per-frame grid generation flow). See FIDELITY.md.
    const skin = SKIN[0];
    this.bmpPaint = [];
    for (let x = 0; x < XMAX; x += 1) {
      const col: number[] = [];
      for (let y = 0; y < YMAX; y += 1) {
        col.push(skin.back);
      }
      this.bmpPaint.push(col);
    }
    // 16 brush stamps. Source draws 100x100 mcBrush at scale 0.1 onto the
    // 10x22 BitmapData with ColorTransform alpha offset 40, so each stamp is
    // roughly 10x10 cells and low-alpha. Keep the same footprint/strength;
    // broader/brighter blobs make the whole block field wash out to white.
    for (let i = 0; i < 16; i += 1) {
      const cx = Math.floor(Math.random() * (XMAX + 4)) - 2;
      const cy = Math.floor(Math.random() * (YMAX + 4)) - 2;
      const radius = 5;
      const r = skin.br + Math.floor(Math.random() * skin.rr);
      const g = skin.bg + Math.floor(Math.random() * skin.rg);
      const b = skin.bb + Math.floor(Math.random() * skin.rb);
      const alpha = 40 / 255;
      for (let xx = 0; xx < 10; xx += 1) {
        for (let yy = 0; yy < 10; yy += 1) {
          const px = cx + xx;
          const py = cy + yy;
          if (px < 0 || px >= XMAX || py < 0 || py >= YMAX) continue;
          const lx = xx - 4.5;
          const ly = yy - 4.5;
          const d = Math.sqrt(lx * lx + ly * ly);
          if (d > radius) continue;
          const t = (1 - d / radius) * alpha;
          const cur = this.bmpPaint[px][py];
          const cr = (cur >> 16) & 0xff;
          const cg = (cur >> 8) & 0xff;
          const cb = cur & 0xff;
          const nr = Math.min(255, Math.round(cr + r * t));
          const ng = Math.min(255, Math.round(cg + g * t));
          const nb = Math.min(255, Math.round(cb + b * t));
          this.bmpPaint[px][py] = (nr << 16) | (ng << 8) | nb;
        }
      }
    }
  }

  private genModel(): void {
    const flMirror = Math.floor(Math.random() * 2) === 0;
    const flMirrorPalette = Math.floor(Math.random() * 2) === 0 && flMirror;
    // Init model.
    this.model = [];
    for (let x = 0; x < XMAX; x += 1) {
      this.model.push(new Array(YMAX).fill(null) as Array<number | null>);
    }

    // MASSE: stamp random shape blobs into a binary-ish field.
    const ymax = Math.floor(Math.min(11 + this.lvl, YMAX - 5));
    const max = Math.floor(3 + Math.pow(this.lvl, 2));
    for (let i = 0; i < max; i += 1) {
      const cx = Math.floor(Math.random() * (XMAX + 4)) - 2;
      const cy = Math.floor(Math.random() * (YMAX + 4)) - 2;
      const sx = 2 + Math.random() * 3;
      const sy = 2 + Math.random() * 3;
      // Rotated ellipse fill.
      const rot = Math.random() * Math.PI * 2;
      for (let xx = -5; xx <= 5; xx += 1) {
        for (let yy = -5; yy <= 5; yy += 1) {
          const cosR = Math.cos(rot);
          const sinR = Math.sin(rot);
          const lx = xx * cosR + yy * sinR;
          const ly = -xx * sinR + yy * cosR;
          if ((lx * lx) / (sx * sx) + (ly * ly) / (sy * sy) > 1) continue;
          const px = cx + xx;
          const py = cy + yy;
          if (px < 0 || px >= XMAX || py < 0 || py >= ymax) continue;
          this.model[px][py] = 0;
        }
      }
    }

    // LINE: lvl horizontal lines bumping life.
    for (let i = 0; i < this.lvl; i += 1) {
      const lim = 4;
      const yy = lim + Math.floor(Math.random() * Math.max(1, ymax - lim));
      for (let x = 0; x < XMAX; x += 1) {
        const cur = this.model[x][yy];
        if (cur !== null && cur < 5) this.model[x][yy] = cur + 1;
      }
    }

    // DIG: random walks that null out cells.
    while (this.lvl >= 0 && Math.floor(Math.random() * 2) === 0) {
      const m = 3;
      let di = Math.floor(Math.random() * 4);
      let sx = m + Math.floor(Math.random() * Math.max(1, XMAX - 2 * m));
      let sy = m + Math.floor(Math.random() * Math.max(1, YMAX - 2 * m));
      let safety = 0;
      while (safety < 200) {
        safety += 1;
        if (sx < 0 || sx >= XMAX || sy < 0 || sy >= YMAX) break;
        const bl = this.model[sx][sy];
        if (bl !== null) {
          this.model[sx][sy] = null;
          const d = DIR[di];
          sx += d[0];
          sy += d[1];
          if (Math.floor(Math.random() * 4) === 0) {
            di = sMod(di + (Math.floor(Math.random() * 2) * 2 - 1), 4);
          }
        } else {
          break;
        }
      }
    }

    // BORDER: bump life of cells adjacent to empty cells.
    if (this.lvl > 0) {
      for (let x = 0; x < XMAX; x += 1) {
        for (let y = 0; y < ymax; y += 1) {
          const cur = this.model[x][y];
          if (cur !== null && cur < 5) {
            for (const d of DIR) {
              const nx = x + d[0];
              const ny = y + d[1];
              if (nx >= 0 && nx < XMAX && ny >= 0 && ny < ymax + 1) {
                const neighbor = ny < YMAX ? this.model[nx]?.[ny] : null;
                if (neighbor === null || neighbor === undefined) {
                  this.model[x][y] = (this.model[x][y] as number) + 1;
                  break;
                }
              }
            }
          }
        }
      }
    }

    // END MALUS: lvl>5 ⇒ multiple life bumps.
    if (this.lvl > 5) {
      for (let i = 0; i < this.lvl - 5; i += 1) {
        for (let x = 0; x < XMAX; x += 1) {
          for (let y = 0; y < ymax; y += 1) {
            const v = this.model[x][y];
            if (v !== null && v < 5) this.model[x][y] = v + 1;
          }
        }
      }
    }

    // BLOCK BALL (glass type 13).
    while (this.lvl >= 1 && Math.floor(Math.random() * 3) === 0) {
      const x = Math.floor(Math.random() * XMAX);
      const y = Math.floor(Math.random() * 5);
      this.model[x][y] = 13;
    }

    // BONUS clusters (rare).
    let n = 1;
    while (Math.floor(Math.random() * n) === 0 && n < 50) {
      this.genBonusBlock(ymax);
      n += 1;
    }

    // MIRROR.
    if (flMirror) {
      const mx = Math.floor(XMAX * 0.5);
      for (let x = 0; x < mx; x += 1) {
        const nx = XMAX - (x + 1);
        this.model[nx] = this.model[x].slice();
        if (flMirrorPalette) this.bmpPaint[nx] = this.bmpPaint[x].slice();
      }
    }
  }
  private genBonusBlock(ymax: number): void {
    const max = Math.floor(Math.min(2 + this.lvl, 4));
    const mx = 1 + Math.floor(Math.random() * max);
    const my = 1 + Math.floor(Math.random() * max);
    const sx = Math.floor(Math.random() * Math.max(1, XMAX - mx));
    const sy = Math.floor(Math.random() * Math.max(1, ymax - my));
    let po = 0;
    if (Math.floor(Math.random() * Math.max(1, Math.pow(mx + my + 1, 2))) === 0) po = 1;
    if (Math.floor(Math.random() * Math.max(1, Math.pow(mx + my + 1, 3))) === 0) po = 2;
    for (let x = 0; x < mx; x += 1) {
      for (let y = 0; y < my; y += 1) {
        if (sx + x >= XMAX || sy + y >= YMAX) continue;
        this.model[sx + x][sy + y] = 10 + po;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Title popup ("EXTENSION" etc.)
  // ---------------------------------------------------------------------------
  newTitle(str: string, col: number, blink = false): void {
    const view = new Container();
    const text = new Text({
      text: str,
      style: { fontFamily: FONT_TITLE, fontSize: 24, fill: 0xffffff, stroke: { color: col, width: 2 } },
    });
    text.anchor.set(0.5);
    text.x = MCW * 0.5;
    text.y = 14;
    view.addChild(text);
    view.x = 0;
    view.y = 0;
    // Source `Filt.blur(mc, mc.bl, 0)` — horizontal-only Gaussian blur driven
    // by `bl` (Game.hx:737-740). We attach a BlurFilter and update strengthX
    // each frame; strengthY stays 0 to mirror the source.
    const blur = new BlurFilter({ strengthX: 100, strengthY: 0, quality: 4 });
    view.filters = [blur];
    this.interLayer.addChild(view);
    this.titles.unshift({ view, text, bl: 100, blur, t: 30, blink, frameAcc: 0 });
  }
  private updateTitle(): void {
    let i = 0;
    while (i < this.titles.length) {
      const mc = this.titles[i];
      mc.t -= this.tmod;
      if (mc.blink) {
        mc.frameAcc += 1;
        mc.text.visible = Math.floor(mc.frameAcc % 5) < 3;
      }
      if (i === 0 && mc.t > 0) {
        mc.bl *= 0.5;
        if (mc.bl < 0.5) mc.bl = 0;
      } else {
        mc.bl += 20;
        if (mc.bl > 100) {
          mc.view.removeFromParent();
          this.titles.splice(i, 1);
          continue;
        }
      }
      // Source applies `Filt.blur(mc, mc.bl, 0)` only when `bl > 0`; otherwise
      // the filter array is reset to []. We toggle the filters list to match,
      // and feed `bl` straight into `strengthX` (1:1 with Flash blurX pixels).
      if (mc.bl > 0) {
        if (mc.view.filters !== mc.blur && (!Array.isArray(mc.view.filters) || mc.view.filters[0] !== mc.blur)) {
          mc.view.filters = [mc.blur];
        }
        mc.blur.strengthX = mc.bl;
        mc.blur.strengthY = 0;
      } else {
        mc.view.filters = [];
      }
      i += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Score popup
  // ---------------------------------------------------------------------------
  displayScore(x: number, y: number, sc: number, color?: number, size = 1): void {
    const view = new Container();
    const text = new Text({
      text: String(sc),
      style: { fontFamily: FONT_SCORE, fontSize: 14, fill: 0xffffff, stroke: { color: color ?? 0x222288, width: 2 } },
    });
    text.anchor.set(0.5);
    view.addChild(text);
    view.scale.set(size);
    this.partsLayer.addChild(view);
    makePart(this, {
      kind: 'score',
      view,
      x,
      y,
      vy: -0.5,
      timer: 30,
      life: 30,
      // Source: Game.displayScore sets fadeType = 0 (scale-shrink), fadeLimit = 5.
      // Round 1 fixed fadeLimit; this restores the scale-fade. The popup now
      // shrinks toward zero over the final 5 frames instead of fading alpha.
      fadeType: 0,
      fadeLimit: 5,
      scale: 100 * size,
    });
  }

  // ---------------------------------------------------------------------------
  // Plasma
  // ---------------------------------------------------------------------------
  private clearPlasmaTexture(target: RenderTexture): void {
    this.app.renderer.clear({ target, clear: true, clearColor: [0, 0, 0, 0] });
  }

  private updatePlasma(): void {
    // Source mutates the BitmapData itself: blur first, then subtract 2 from
    // alpha. Do it by rendering current RT -> cleared scratch RT through the
    // same filter chain, then swap. This preserves transparent pixels.
    if (this.plasmaBlur) {
      const bl = Math.max(2, this.tmod * 4 * this.pq);
      this.plasmaBlur.strengthX = bl;
      this.plasmaBlur.strengthY = bl;
    }
    this.plasmaDecaySprite.texture = this.plasmaRT;
    this.app.renderer.render({
      container: this.plasmaDecaySprite,
      target: this.plasmaScratchRT,
      clear: true,
      clearColor: [0, 0, 0, 0],
    });
    const previous = this.plasmaRT;
    this.plasmaRT = this.plasmaScratchRT;
    this.plasmaScratchRT = previous;
    this.plasmaSprite.texture = this.plasmaRT;
  }
  plasmaDraw(view: Container): void {
    // Pixi's render({ transform }) replaces the root object's local transform.
    // Flash BitmapData.draw does the same conceptually: Game.hx builds a
    // matrix from mc._rotation, mc._xscale/_yscale, and mc._x/_y before drawing
    // the clip's local contents. Preserve those root transform terms here,
    // otherwise scaled one-shot brushes (pad glow bars, laser roots, etc.) draw
    // into plasma at their native extracted dimensions.
    const sx = view.scale.x * this.pq;
    const sy = view.scale.y * this.pq;
    const c = Math.cos(view.rotation);
    const s = Math.sin(view.rotation);
    const m = new Matrix();
    m.set(c * sx, s * sx, -s * sy, c * sy, view.x * this.pq, view.y * this.pq);
    this.app.renderer.render({ container: view, target: this.plasmaRT, clear: false, transform: m });
  }

  // ---------------------------------------------------------------------------
  // GameContext helpers
  // ---------------------------------------------------------------------------
  isFree(px: number, py: number): boolean {
    if (px < 0 || px >= XMAX || py < 0) return false;
    if (py >= YMAX) return true; // below grid: balls fall freely
    return this.grid[px][py] === null;
  }
  hit(px: number, py: number, ball: Ball): void {
    if (px < 0 || px >= XMAX || py < 0 || py >= YMAX) return;
    const bl = this.grid[px][py];
    if (bl) bl.damage(ball, ball.type, ball.damage);
  }
  newBall(): Ball {
    return new Ball(this);
  }
  addScore(value: number): void {
    this.score += value;
    this.scoreText.text = String(this.score);
    this.host.updateScore(this.score);
  }
  newPart(opts: Partial<FxParticle> & Pick<FxParticle, 'kind' | 'view'>): FxParticle {
    return makePart(this, opts);
  }
  killPart(p: FxParticle): void {
    killPart(this, p);
  }
  bmpPaintGetPixel(x: number, y: number): number {
    if (x < 0 || x >= XMAX || y < 0 || y >= YMAX) return 0xffffff;
    return this.bmpPaint[x]?.[y] ?? 0xffffff;
  }
  getLowestBall(): Ball | null {
    let best: Ball | null = null;
    for (const b of this.balls) {
      if (best === null || (b.flUp && b.view.y > best.view.y)) best = b;
    }
    return best;
  }
  spriteCount(): number {
    // Source uses `Sprite.spriteList.length` (mt.bumdum.Sprite.hx:6) which is
    // a global registry of all `mt.bumdum.Sprite` instances. Subclasses are:
    // Pad (Sprite), Ball (Element→Sprite), Option (Phys→Sprite), Shot.Laser
    // (Element→Sprite), and every Phys-derived particle (Part/LineUp/Spark/
    // Attract/etc., all extend Sprite). Block does NOT extend Sprite (just
    // `class Block`, see Block.hx:6) so it is NOT in spriteList; Event is
    // also NOT a Sprite (see Event.hx:3 — `class Event` with no superclass).
    // Earlier port included events in the count and excluded the pad, which
    // is doubly wrong against source: events should be excluded (they're not
    // Sprites; their attached MovieClips don't enter spriteList either) and
    // the pad should be included (it IS a Sprite). The errors partially
    // cancelled but each call site of getPerfCoef / genSparks / etc. saw a
    // slightly different count from source. R24: drop events, add pad.
    return 1 /* pad */ + this.balls.length + this.options.length + this.shots.length + this.particles.length;
  }
  spawnLaser(x: number, y: number): void {
    const laser = new Laser(this);
    laser.moveTo(x, y);
    laser.setVit(18);
    laser.updatePos();
    this.shots.push(laser);
  }

  // ---------------------------------------------------------------------------
  // Input wiring (called from index.ts)
  // ---------------------------------------------------------------------------
  setLeft(down: boolean): void {
    this.pad.keys.left = down;
  }
  setRight(down: boolean): void {
    this.pad.keys.right = down;
  }
  setMouseDown(): void {
    this.autoLaunchTimer = 0;
    if (this.mcTitle) this.mcTitle.timer = 0;
    this.pad.action();
    this.flPress = true;
    this.flClick = true;
  }
  setMouseUp(): void {
    this.pad.release();
    this.flPress = false;
  }
  setMouseMove(x: number): void {
    this.pad.flMouse = true;
    this.pad.mouseX = x;
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------
  destroy(): void {
    while (this.balls.length > 0) {
      const b = this.balls.pop();
      if (b) b.kill();
    }
    while (this.options.length > 0) {
      const o = this.options.pop();
      if (o) o.kill();
    }
    while (this.events.length > 0) {
      const e = this.events.shift();
      if (e) e.kill();
    }
    while (this.shots.length > 0) {
      const s = this.shots.pop();
      if (s) s.kill();
    }
    while (this.particles.length > 0) {
      const p = this.particles.pop();
      if (p) {
        p.view.removeFromParent();
        if (p.onKill) p.onKill();
      }
    }
    while (this.blocks.length > 0) {
      const b = this.blocks.pop();
      if (b) b.kill();
    }
    this.titles.forEach((t) => t.view.removeFromParent());
    this.titles.length = 0;
    if (this.mcTitle) {
      this.mcTitle.view.removeFromParent();
      this.mcTitle = null;
    }
    this.pad.destroy();
    this.bgLayer.removeChildren();
    this.plasmaLayer.removeChildren();
    this.underPartsLayer.removeChildren();
    this.blockLayer.removeChildren();
    this.sideLayer.removeChildren();
    this.blockOverlayLayer.removeChildren();
    this.padLayer.removeChildren();
    this.optionLayer.removeChildren();
    this.ballLayer.removeChildren();
    this.partsLayer.removeChildren();
    this.interLayer.removeChildren();
    this.plasmaSprite.filters = [];
    this.plasmaDecaySprite.filters = [];
    if (this.plasmaBlur) {
      this.plasmaBlur.destroy();
      this.plasmaBlur = null;
    }
    if (this.plasmaAlphaDecay) {
      this.plasmaAlphaDecay.destroy();
      this.plasmaAlphaDecay = null;
    }
    this.plasmaDecaySprite.destroy();
    this.plasmaRT.destroy(true);
    this.plasmaScratchRT.destroy(true);
    this.root.removeFromParent();
  }
}

// Num.sMod — symmetric modulo for nonneg integers (used by genModel).
function sMod(a: number, m: number): number {
  return ((a % m) + m) % m;
}
