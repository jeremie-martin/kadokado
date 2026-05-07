import { Application, Assets, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { noopGameHost } from '../types';
import type { GameHost, GameInstance, GameMountContext } from '../types';
import { type Frame, makeSprite, setFrame } from '../_shared/frames';
import {
  STAGE_WIDTH, STAGE_HEIGHT, FPS, STEP_SECONDS,
  SIDE, START_WHEEL_ID,
  SCORE_PASTILLE,
  BLOB_RAY,
  BLOB_STATE_FLY, BLOB_STATE_GRAB, BLOB_STATE_WALL, BLOB_STATE_DEAD,
  InterwheelSim,
  type Wheel as SimWheel, type Pastille as SimPastille, type Spark as SimSpark,
} from './sim';

// Re-export sim's blob-state constants so the playground / bench /
// AI planner can import them from this game module.
export { BLOB_STATE_FLY, BLOB_STATE_GRAB, BLOB_STATE_WALL, BLOB_STATE_DEAD } from './sim';
// Sim type and class are re-exported so AI/bench code can drive the
// simulator directly without reaching through `InterwheelGame`.
export { InterwheelSim, type RNG, type SimSnapshot } from './sim';

// === Display-only constants ===
const BLOB_COULE_FRAME_START = 19;
const BLOB_COULE_FRAME_COUNT = 25;
const BLOB_GRAB_FRAME_START = 44;
const BLOB_GRAB_FRAME_COUNT = 15;
const BLOB_DEATH_FRAME_START = 102;
const BLOB_DEATH_FRAME_COUNT = 71;
const PARTICLE_FADE_LIMIT = 10;
const DECOR_SECTION_HEIGHT = 2000;
const DECOR_MIN_SECTIONS = 5;
const DECOR_EXTRA_SECTIONS = 2;
const DECOR_BASE_COLOR = 0x436b70;
const PANEL_X = 238;
const PANEL_Y = 265;
const PANEL_TEXT_X = 263;
const PANEL_TEXT_Y = 280;

const DEFAULT_ASSET_ROOT = '/assets/interwheel';
const DEFAULT_ASSET_SCALE = 1;
const ASSET_PRESETS = {
  x1: { root: '/assets/interwheel', scale: 1 },
  x2: { root: '/assets/interwheel-2x/median-all', scale: 2 },
  x4: { root: '/assets/interwheel-4x/median-all', scale: 4 },
  'x4-aa': { root: '/assets/interwheel-4x-alpha-aa/median-all', scale: 4 },
} as const;

type AssetPreset = keyof typeof ASSET_PRESETS;

type InterwheelRuntimeAssets = {
  assetRoot: string;
  assetScale: number;
};

type InterwheelAssets = {
  bg: Frame;
  background: Frame;
  water: Frame;
  mine: Frame;
  side: Frame;
  panel: Frame;
  oil: Frame;
  star: Frame;
  blob: Frame[];
  wheelBase: Frame[];
  wheelLight: Frame[];
  mask: Frame[];
  dust: Frame[];
  pastille: Frame[];
  pastilleCore: Frame[];
  tile: Frame[];
  motif: Frame[];
  frise: Frame[];
  explosion: Frame[];
  startExplo: Frame[];
  smoke: Frame[];
  mineParts: Frame[];
  tache: Frame[];
  wallTache: Frame[];
  goutte: Frame;
  bubble: Frame[];
  eyes: Frame;
  starTache: Frame;
};

function normalizedAssetRoot(root: string | null): string {
  if (!root) return DEFAULT_ASSET_ROOT;
  const normalized = root.trim().replace(/\/+$/, '');
  if (!normalized.startsWith('/assets/interwheel')) return DEFAULT_ASSET_ROOT;
  return normalized || DEFAULT_ASSET_ROOT;
}

function normalizedAssetScale(scale: string | null): number {
  const parsed = Number(scale);
  if ([1, 2, 4].includes(parsed)) return parsed;
  return DEFAULT_ASSET_SCALE;
}

function runtimeAssetsFromLocation(location: Location = window.location): InterwheelRuntimeAssets {
  const params = new URLSearchParams(location.search);
  const preset = params.get('assetPreset');
  if (preset && preset in ASSET_PRESETS) {
    const selected = ASSET_PRESETS[preset as AssetPreset];
    return { assetRoot: selected.root, assetScale: selected.scale };
  }
  return {
    assetRoot: normalizedAssetRoot(params.get('assetRoot')),
    assetScale: normalizedAssetScale(params.get('assetScale')),
  };
}

async function loadRuntimeFrame(
  assetRoot: string,
  assetScale: number,
  path: string,
  pivotX: number,
  pivotY: number,
): Promise<Frame> {
  const src = `${assetRoot}/${path}`;
  const texture = path.endsWith('.png') && assetScale !== DEFAULT_ASSET_SCALE
    ? await Assets.load<Texture>({ src, data: { resolution: assetScale } })
    : await Assets.load<Texture>(src);
  return { texture, pivotX, pivotY };
}

async function loadRuntimeSeries(
  assetRoot: string,
  assetScale: number,
  folder: string,
  count: number,
  pivotX: number,
  pivotY: number,
): Promise<Frame[]> {
  return Promise.all(
    Array.from(
      { length: count },
      (_, i) => loadRuntimeFrame(assetRoot, assetScale, `${folder}/${i + 1}.png`, pivotX, pivotY),
    ),
  );
}

// View bundles that parallel each logical sim entity. The sim never sees
// these — they live entirely in the renderer.
type WheelView = {
  group: Container;
  spin: Container;
  shadow: Sprite;
  dust: Sprite;
  stains: Container;
  stainMask: Sprite;
  mineSprites: Sprite[];
};

type PastilleView = { view: Container; core: Sprite };

// Visual particle (no gameplay role — pure tween).
type Particle = {
  view: Sprite;
  vx: number;
  vy: number;
  weight: number;
  frict: number;
  life: number | null;
  ttl: number;
  scale: number;
  fadeMode: 'alpha' | 'scale' | 'none';
  vr: number;
  vs: number;
  sFrict: number;
  frames?: Frame[];
  frameCursor?: number;
  bubbleFrames?: Frame[];
  dec?: number;
  dsp?: number;
  ec?: number;
  outTimer?: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function randomInt(max: number): number {
  if (max <= 1) return 0;
  return Math.floor(Math.random() * max);
}

/**
 * Reconciles a Map<Entity, View> to match a current entities array. Adds
 * views for entities new to the array, removes views whose entity is no
 * longer present (compared by reference). Called every tick so that the
 * AI planner's `sim.clone()`/`sim.restore()` cycles — which recreate
 * pastille and spark objects — never leak ghost sprites onto the canvas.
 */
function syncMap<E, V>(
  entities: readonly E[],
  views: Map<E, V>,
  attach: (e: E) => void,
  detach: (v: V) => void,
): void {
  const live = new Set(entities);
  for (const [e, v] of views) {
    if (!live.has(e)) {
      detach(v);
      views.delete(e);
    }
  }
  for (const e of entities) {
    if (!views.has(e)) attach(e);
  }
}

async function loadAssets(
  assetRoot = DEFAULT_ASSET_ROOT,
  assetScale = DEFAULT_ASSET_SCALE,
): Promise<InterwheelAssets> {
  const [
    bg, background, water, mine, side, panel, oil, star,
    blob, wheelBase, wheelLight, mask, dust,
    pastille, pastilleCore,
    tile, motif, frise, explosion, startExplo, smoke, mineParts, tache, wallTache,
    goutte, bubble, eyes, starTache,
  ] = await Promise.all([
    loadRuntimeFrame(assetRoot, assetScale, 'bg.png', 0, 0),
    loadRuntimeFrame(assetRoot, assetScale, 'background.png', 0, 599.95),
    loadRuntimeFrame(assetRoot, assetScale, 'water.png', 0, 0),
    loadRuntimeFrame(assetRoot, assetScale, 'mine.png', 8.65, 11.85),
    loadRuntimeFrame(assetRoot, assetScale, 'side.png', 1, 0.45),
    loadRuntimeFrame(assetRoot, assetScale, 'panel-template.svg', -1.45, -1.4),
    loadRuntimeFrame(assetRoot, assetScale, 'oil.png', 2.5, 2.5),
    loadRuntimeFrame(assetRoot, assetScale, 'star.png', 7, 7),
    loadRuntimeSeries(assetRoot, assetScale, 'blob', 173, 35.95, 34.9),
    loadRuntimeSeries(assetRoot, assetScale, 'wheel-base', 5, 50.5, 50.5),
    loadRuntimeSeries(assetRoot, assetScale, 'wheel-light', 3, 37.5, 7.4),
    loadRuntimeSeries(assetRoot, assetScale, 'mask', 17, 50.5, 50.5),
    loadRuntimeSeries(assetRoot, assetScale, 'dust', 18, 31, 23.5),
    loadRuntimeSeries(assetRoot, assetScale, 'pastille', 2, 20, 20),
    loadRuntimeSeries(assetRoot, assetScale, 'pastille-core', 3, 5, 5),
    loadRuntimeSeries(assetRoot, assetScale, 'tile', 40, 0.1, 0.35),
    loadRuntimeSeries(assetRoot, assetScale, 'motif', 51, 78.5, 71),
    loadRuntimeSeries(assetRoot, assetScale, 'frise', 12, 140, 57.5),
    loadRuntimeSeries(assetRoot, assetScale, 'explosion', 14, 75.55, 86.6),
    loadRuntimeSeries(assetRoot, assetScale, 'start-explo', 15, 53.95, 53.95),
    loadRuntimeSeries(assetRoot, assetScale, 'smoke', 25, 18, 18),
    loadRuntimeSeries(assetRoot, assetScale, 'mine-parts', 2, 6, 6),
    loadRuntimeSeries(assetRoot, assetScale, 'tache', 19, 6.5, 6),
    loadRuntimeSeries(assetRoot, assetScale, 'wall-tache', 4, 18, 13.5),
    loadRuntimeFrame(assetRoot, assetScale, 'goutte/1.png', 4, 4),
    loadRuntimeSeries(assetRoot, assetScale, 'bubble', 2, 7, 6),
    loadRuntimeFrame(assetRoot, assetScale, 'eyes/1.png', 2.5, 4.5),
    loadRuntimeFrame(assetRoot, assetScale, 'star-tache/1.png', 69, 54),
  ]);
  return {
    bg, background, water, mine, side, panel, oil, star,
    blob, wheelBase, wheelLight, mask, dust,
    pastille, pastilleCore, tile, motif, frise, explosion, startExplo, smoke, mineParts, tache, wallTache,
    goutte, bubble, eyes, starTache,
  };
}

export class InterwheelGame {
  readonly app: Application;
  readonly assets: InterwheelAssets;
  readonly host: GameHost;
  readonly assetRoot: string;
  readonly assetScale: number;

  // Pixi layer hierarchy.
  readonly world = new Container();
  readonly decorLayer = new Container();
  readonly shadowLayer = new Container();
  readonly oilLayer = new Container();
  readonly blobLayer = new Container();
  readonly wheelLayer = new Container();
  readonly pastilleLayer = new Container();
  readonly starLayer = new Container();
  readonly particleLayer = new Container();
  readonly waterLayer = new Container();
  readonly waterParticleLayer = new Container();
  readonly hudLayer = new Container();

  readonly meterText = new Text({
    text: '0m',
    style: {
      fontFamily: 'Arial Rounded MT Bold, Trebuchet MS, Arial, Helvetica, sans-serif',
      fontSize: 13,
      fontWeight: '900',
      fill: 0xe1bd6a,
    },
  });
  readonly gameOverText = new Text({
    text: '',
    style: {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 24,
      fontWeight: '700',
      fill: 0xffffff,
      stroke: { color: 0x1c2c34, width: 4 },
    },
  });

  // The sole source of gameplay truth.
  readonly sim = new InterwheelSim();

  // Visuals paralleling sim entities.
  private wheelViews: WheelView[] = [];
  private pastilleViews = new Map<SimPastille, PastilleView>();
  private sparkViews = new Map<SimSpark, Container>();
  private blobView: Sprite;
  private particles: Particle[] = [];

  // Per-tick prev-state cache so render() can detect transitions even
  // though sim's events are also fired by sim.step().
  private prevDestroyed: boolean[] = [];

  // Keyboard input aggregation — only used by `mount()`'s keyboard handler;
  // exposed because the kadokado launcher checks `spaceHeld` there too.
  spaceHeld = false;

  constructor(
    app: Application,
    assets: InterwheelAssets,
    host: GameHost,
    runtimeAssets: InterwheelRuntimeAssets = {
      assetRoot: DEFAULT_ASSET_ROOT,
      assetScale: DEFAULT_ASSET_SCALE,
    },
  ) {
    this.app = app;
    this.assets = assets;
    this.host = host;
    this.assetRoot = runtimeAssets.assetRoot;
    this.assetScale = runtimeAssets.assetScale;

    const bg = makeSprite(assets.bg);
    this.app.stage.addChild(bg, this.world, this.hudLayer);
    this.world.addChild(
      this.decorLayer, this.shadowLayer, this.oilLayer,
      this.blobLayer, this.wheelLayer, this.pastilleLayer, this.starLayer,
      this.particleLayer, this.waterLayer, this.waterParticleLayer,
    );

    const panel = makeSprite(assets.panel);
    panel.position.set(PANEL_X, PANEL_Y);
    this.hudLayer.addChild(panel);

    this.meterText.anchor.set(0.5);
    this.meterText.position.set(PANEL_TEXT_X, PANEL_TEXT_Y);
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(150, 145);
    this.hudLayer.addChild(this.meterText, this.gameOverText);

    this.blobView = makeSprite(assets.blob[0]);
    this.blobLayer.addChild(this.blobView);

    this.reset();
  }

  // ------- Setters proxied to sim, so legacy keyboard handlers work ---------

  get spacePressed(): boolean {
    return this.sim.spacePressed;
  }
  set spacePressed(v: boolean) {
    this.sim.spacePressed = v;
  }
  get pointerPressed(): boolean {
    return this.sim.pointerPressed;
  }
  set pointerPressed(v: boolean) {
    this.sim.pointerPressed = v;
  }

  // ------- Read-only proxies into sim state used by callers (incl. AI) ------

  get tick(): number { return this.sim.tick; }
  get score(): number { return this.sim.score; }
  get maxHeight(): number { return this.sim.maxHeight; }
  get ended(): boolean { return this.sim.ended; }
  get ending(): boolean { return this.sim.ending; }
  get blob() { return this.sim.blob; }
  get wheels(): readonly SimWheel[] { return this.sim.wheels; }
  get pastilles(): readonly SimPastille[] { return this.sim.pastilles; }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  reset(): void {
    // Wipe every layer and view container.
    this.decorLayer.removeChildren();
    this.shadowLayer.removeChildren();
    this.oilLayer.removeChildren();
    this.wheelLayer.removeChildren();
    this.pastilleLayer.removeChildren();
    this.starLayer.removeChildren();
    this.particleLayer.removeChildren();
    this.blobLayer.removeChildren();
    this.waterLayer.removeChildren();
    this.waterParticleLayer.removeChildren();
    this.particles = [];
    this.wheelViews = [];
    this.pastilleViews.clear();
    this.sparkViews.clear();

    this.gameOverText.text = '';
    this.meterText.text = '0m';
    this.host.updateScore(0);
    this.host.updateMetric({ key: 'height', label: 'Height', value: 0, unit: 'm' });

    this.sim.reset(Math.random);
    this.prevDestroyed = this.sim.wheels.map((w) => w.destroyed);

    this.buildDecor();
    for (const wheel of this.sim.wheels) {
      this.attachWheelView(wheel);
    }
    for (const pastille of this.sim.pastilles) {
      this.attachPastilleView(pastille);
    }

    this.blobView = makeSprite(this.assets.blob[0]);
    this.blobLayer.addChild(this.blobView);

    const water = makeSprite(this.assets.water);
    water.position.set(0, this.sim.waterY);
    this.waterLayer.addChild(water);

    this.render();
  }

  private buildDecor(): void {
    const sectionCount = Math.max(
      DECOR_MIN_SECTIONS,
      Math.ceil(-this.sim.roof / DECOR_SECTION_HEIGHT) + DECOR_EXTRA_SECTIONS,
    );
    for (let section = 0; section < sectionCount; section += 1) {
      const sectionTop = -(section + 1) * DECOR_SECTION_HEIGHT;
      const base = new Graphics();
      base.rect(0, sectionTop, STAGE_WIDTH, DECOR_SECTION_HEIGHT).fill(DECOR_BASE_COLOR);
      this.decorLayer.addChild(base);

      for (let y = 0; y < DECOR_SECTION_HEIGHT; y += 40) {
        for (let x = 0; x < STAGE_WIDTH; x += 40) {
          const frameIndex = (section * 10 + randomInt(10)) % this.assets.tile.length;
          const tile = makeSprite(this.assets.tile[frameIndex]);
          tile.position.set(x, sectionTop + y);
          this.decorLayer.addChild(tile);
        }
      }

      let by = 100;
      while (by < DECOR_SECTION_HEIGHT) {
        if (Math.random() < 0.2) {
          const useFrise = Math.random() < 0.2;
          const frames = useFrise ? this.assets.frise : this.assets.motif;
          const art = makeSprite(frames[randomInt(frames.length)]);
          const bx = useFrise ? STAGE_WIDTH * 0.5 : randomInt(STAGE_WIDTH);
          by += art.height * 0.5;
          art.position.set(bx, sectionTop + by);
          this.decorLayer.addChild(art);
          by += art.height * 0.5;
        }
        by += randomInt(100);
      }

      for (let y = 0; y < DECOR_SECTION_HEIGHT; y += 40) {
        const left = makeSprite(this.assets.side);
        left.position.set(0, sectionTop + y);
        const right = makeSprite(this.assets.side);
        right.position.set(STAGE_WIDTH - SIDE, sectionTop + y);
        this.decorLayer.addChild(left, right);
      }
    }
  }

  private attachWheelView(wheel: SimWheel): void {
    const group = new Container();
    group.position.set(wheel.x, wheel.y);

    const shadow = makeSprite(this.assets.mask[wheel.fr - 1] ?? this.assets.mask[this.assets.mask.length - 1]);
    shadow.tint = 0x000000;
    shadow.alpha = 0.2;
    shadow.y = 6;
    shadow.scale.set((wheel.ray * 2) / 100);
    this.shadowLayer.addChild(shadow);

    const dust = makeSprite(this.assets.dust[0]);
    dust.scale.set((wheel.ray * 2) / 100);

    const spin = new Container();
    spin.scale.set((wheel.ray * 2) / 100);
    const mineSprites: Sprite[] = [];
    for (const mineAngle of wheel.mines) {
      const mineSprite = makeSprite(this.assets.mine);
      mineSprite.position.set(Math.cos(mineAngle) * 50, Math.sin(mineAngle) * 50);
      mineSprite.scale.set(100 / (wheel.ray * 2));
      mineSprite.rotation = mineAngle;
      spin.addChild(mineSprite);
      mineSprites.push(mineSprite);
    }

    const base = makeSprite(this.assets.wheelBase[wheel.fr - 1]);
    spin.addChild(base);

    const stains = new Container();
    const stainMask = makeSprite(this.assets.mask[wheel.fr - 1] ?? this.assets.mask[this.assets.mask.length - 1]);
    stains.mask = stainMask;
    stainMask.renderable = false;
    spin.addChild(stains, stainMask);

    const lightFrame = this.assets.wheelLight[Math.min(wheel.fr - 1, this.assets.wheelLight.length - 1)];
    const light = makeSprite(lightFrame);
    light.scale.set(wheel.fr === 2 ? (wheel.ray * 2) / 100 : 1);
    group.addChild(dust, spin, light);
    this.wheelLayer.addChild(group);

    this.wheelViews.push({ group, spin, shadow, dust, stains, stainMask, mineSprites });
  }

  private makePastilleView(type: number): PastilleView {
    const view = new Container();
    const body = makeSprite(this.assets.pastille[0]);
    const core = makeSprite(this.assets.pastilleCore[type] ?? this.assets.pastilleCore[0]);
    view.addChild(body, core);
    return { view, core };
  }

  private attachPastilleView(pastille: SimPastille): void {
    const pv = this.makePastilleView(pastille.type);
    pv.view.position.set(pastille.x, pastille.y);
    this.pastilleLayer.addChild(pv.view);
    this.pastilleViews.set(pastille, pv);
  }

  private attachSparkView(spark: SimSpark, x: number, y: number): void {
    const view = new Container();
    const body = makeSprite(this.assets.pastille[0]);
    const core = makeSprite(this.assets.pastilleCore[spark.type] ?? this.assets.pastilleCore[0]);
    view.addChild(body, core);
    view.position.set(x, y);
    this.particleLayer.addChild(view);
    this.sparkViews.set(spark, view);
  }

  // ============================================================================
  // Tick driver
  // ============================================================================

  update(): void {
    this.sim.step(false, Math.random);
    this.processSimEvents();
    this.spawnAmbientCosmetics();
    this.updateParticles();
    this.render();
    this.updateHud();
    if (this.sim.events.runFinished) {
      const heightMeters = Math.floor(this.sim.maxHeight * 0.2);
      this.host.endRun({
        score: this.sim.score,
        secondary: { key: 'height', label: 'Height', value: heightMeters, unit: 'm' },
      });
    }
    // Snapshot the per-wheel destroyed flag so the renderer can detect
    // brand-new explosions even on the next tick (the sim event clears).
    for (let i = 0; i < this.sim.wheels.length; i += 1) {
      this.prevDestroyed[i] = this.sim.wheels[i].destroyed;
    }
  }

  // ------------- Sim → renderer event consumers -----------------------------

  private processSimEvents(): void {
    const ev = this.sim.events;

    if (ev.blobJumpAngle !== null) {
      this.spawnJumpParticles(ev.blobJumpAngle);
    }

    for (const me of ev.mineExplosions) {
      const view = this.wheelViews[me.wheelIdx];
      view?.mineSprites[me.mineIdx]?.removeFromParent();
      this.spawnMineExplosion(me);
    }

    if (ev.blobExploded) {
      this.blobView.visible = false;
      this.spawnBlobExplosion(ev.blobExploded.ba, ev.blobExploded.x, ev.blobExploded.y);
    }

    if (ev.blobDrowned) {
      this.startBlobDrowningVisual();
    }

    if (ev.endingStarted) {
      this.gameOverText.text = '';
    }

    // Spark-collected animations (event-driven; the view itself is removed
    // by the diff-sync below).
    for (const cs of ev.collectedSparks) {
      this.spawnSparkCollectedAnimation(cs);
    }

    // Diff-sync pastille and spark views. This is robust to the AI's plan
    // cycle, which calls `sim.restore()` and replaces pastille / spark
    // object references — so a ref-keyed map otherwise leaks stale views.
    // Walking both directions every tick keeps the rendered set exactly
    // aligned with the simulator's logical arrays.
    syncMap(this.sim.pastilles, this.pastilleViews,
      (pastille) => this.attachPastilleView(pastille),
      (pv) => pv.view.removeFromParent());
    syncMap(this.sim.sparks, this.sparkViews,
      (spark) => this.attachSparkView(spark, spark.x, spark.y),
      (view) => view.removeFromParent());
  }

  // ------------- Cosmetic spawners (random, view-only) ----------------------

  private spawnAmbientCosmetics(): void {
    const blob = this.sim.blob;

    // Fly trail.
    if (blob.state === BLOB_STATE_FLY && Math.random() < blob.blop) {
      const fr = 0.4 + Math.random() * 0.4;
      this.spawnParticle(
        this.assets.oil,
        blob.x + (Math.random() * 2 - 1) * 3,
        blob.y + (Math.random() * 2 - 1) * 3,
        blob.vx * fr,
        blob.vy * fr,
        {
          scale: 0.5 + Math.random() * 0.5 + blob.blop * 0.5,
          ttl: 10 + Math.random() * 10,
          weight: 0.2 + Math.random() * 0.2,
          fadeMode: 'scale',
          layer: this.oilLayer,
        },
      );
    }

    // Destroyed-wheel oil dust.
    for (const wheel of this.sim.wheels) {
      if (!wheel.destroyed || wheel.boomAngle === null) continue;
      if (Math.random() >= Math.abs(wheel.speed) * 5) continue;
      const a = wheel.a + wheel.boomAngle;
      const dist = wheel.ray - (5 + Math.random() * 5);
      this.spawnParticle(
        this.assets.oil,
        wheel.x + Math.cos(a) * dist,
        wheel.y + Math.sin(a) * dist,
        0, 0,
        {
          scale: 0.8 + Math.random() * 0.8,
          ttl: 10 + Math.random() * 20,
          weight: 0.1 + Math.random() * 0.1,
          fadeMode: 'scale',
        },
      );
    }

    // Pastille pulse.
    for (const [pastille, view] of this.pastilleViews) {
      if (!pastille.active) continue;
      view.core.scale.set(0.9 + Math.random() * 0.2);
    }

    // Spark sparkles.
    for (const spark of this.sim.sparks) {
      if (Math.random() < 0.4) {
        this.spawnParticle(
          this.assets.star, spark.x, spark.y,
          spark.vx * (0.5 + (Math.random() * 2 - 1) * 0.1),
          spark.vy * (0.5 + (Math.random() * 2 - 1) * 0.1),
          {
            ttl: 10 + Math.random() * 10,
            weight: 0.1 + Math.random() * 0.1,
            fadeMode: 'scale',
            layer: this.starLayer,
          },
        );
      }
    }

    // Water effects (bubbles + splash drops) — based on observed wet state.
    if (blob.state !== BLOB_STATE_DEAD) {
      const inWater = blob.y - BLOB_RAY > this.sim.waterY;
      if (inWater) {
        if (Math.random() < blob.wet) {
          this.spawnParticle(
            this.assets.tache[0], blob.x, blob.y,
            blob.vx * 0.5 + (Math.random() * 2 - 1),
            blob.vy * 0.5 + (Math.random() * 2 - 1) * 0.5,
            {
              scale: 1 + blob.wet * 1.5 + Math.random(),
              life: null, weight: 0, fadeMode: 'none',
              layer: this.oilLayer, frames: this.assets.tache,
            },
          );
        }
        if (Math.random() < blob.wet) {
          this.spawnBubble(blob.x + Math.random() * BLOB_RAY, blob.y + Math.random() * BLOB_RAY, blob.vy * 0.8);
        }
      } else if (blob.wet > 0) {
        if (Math.random() * 0.5 < blob.wet) {
          const coef = 0.2 + Math.random() * 0.4;
          this.spawnParticle(
            this.assets.goutte,
            blob.x + (Math.random() * 2 - 1) * 6,
            blob.y + (Math.random() * 2 - 1) * 6,
            (blob.vvx + blob.vx) * coef, (blob.vvy + blob.vy) * coef,
            {
              scale: 0.6 + blob.wet * 0.8 + Math.random() * 0.5,
              ttl: 10 + Math.random() * 10,
              weight: 0,
              fadeMode: 'scale',
              layer: this.oilLayer,
            },
          );
        }
      }
    }
  }

  private spawnJumpParticles(a: number): void {
    const blob = this.sim.blob;
    for (let i = 0; i < 4; i += 1) {
      const dec = Math.random() * 2 - 1;
      const na = a + dec * 0.8;
      const sp = 8 - Math.abs(dec) * 6;
      this.spawnParticle(this.assets.oil, blob.x, blob.y, Math.cos(na) * sp, Math.sin(na) * sp, {
        scale: 0.5 + (i / 4) * 1.0,
        ttl: 10 + Math.random() * 30,
        weight: 0.2 + (i / 4) * 0.2,
        fadeMode: 'scale',
        layer: this.oilLayer,
      });
    }
  }

  private spawnMineExplosion(me: { wheelIdx: number; mineIdx: number; mineAngle: number; x: number; y: number; ba: number }): void {
    const wheel = this.sim.wheels[me.wheelIdx];
    const view = this.wheelViews[me.wheelIdx];

    this.spawnAnimation(this.assets.explosion, me.x, me.y, 0.5);

    for (let i = 0; i < 5; i += 1) {
      const a = me.ba + (Math.random() * 2 - 1) * 1.57;
      const ray = 4;
      const sp = 1 + Math.random() * 4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.spawnParticle(this.assets.mineParts[randomInt(this.assets.mineParts.length)], me.x + ca * ray, me.y + sa * ray, ca * sp, sa * sp, {
        scale: 0.8 + Math.random() * 0.4,
        ttl: 10 + Math.random() * 30,
        weight: 0.1 + Math.random() * 0.2,
        fadeMode: 'scale',
        vr: (Math.random() * 2 - 1) * 20 * (Math.PI / 180),
        rotation: Math.random() * Math.PI * 2,
      });
    }
    for (let i = 0; i < 6; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.5 + Math.random() * 2;
      this.spawnParticle(this.assets.smoke[randomInt(this.assets.smoke.length)], me.x, me.y, Math.cos(a) * sp, Math.sin(a) * sp, {
        scale: 0.8 + Math.random() * 0.6,
        ttl: 10 + Math.random() * 20,
        weight: -(0.1 + Math.random() * 0.3),
        frict: 0.95,
        vr: (Math.random() * 2 - 1) * 12 * (Math.PI / 180),
        rotation: Math.random() * Math.PI * 2,
      });
    }
    for (let i = 0; i < 4; i += 1) {
      const a = me.ba + (Math.random() * 2 - 1) * 1.57;
      const sp = Math.random() * 36;
      this.spawnParticle(
        this.assets.wallTache[randomInt(this.assets.wallTache.length)],
        me.x + Math.cos(a) * sp, me.y + Math.sin(a) * sp,
        0, 0,
        {
          scale: 0.5 + Math.random() * 0.5,
          rotation: Math.random() * Math.PI * 2,
          weight: Math.random() * 0.01,
          frict: 1, life: null, fadeMode: 'none',
          layer: this.decorLayer,
        },
      );
    }
    this.spawnParticle(this.assets.starTache, me.x, me.y, 0, 0, {
      scale: 0.4, weight: 0, frict: 1, life: null, fadeMode: 'none',
      vs: 0.3, sFrict: 0.65, rotation: Math.random() * Math.PI * 2,
      layer: this.decorLayer,
    });

    if (view) {
      const bx = Math.cos(me.mineAngle) * 50;
      const by = Math.sin(me.mineAngle) * 50;
      const scm = 100 / (wheel.ray * 2);
      for (let i = 0; i < 4; i += 1) {
        const stain = makeSprite(this.assets.wallTache[randomInt(this.assets.wallTache.length)]);
        const a = me.mineAngle + Math.PI + (Math.random() * 2 - 1) * 1.57;
        const sp = Math.random() * 10 * scm;
        stain.position.set(bx + Math.cos(a) * sp, by + Math.sin(a) * sp);
        stain.scale.set((0.5 + Math.random() * 0.6) * scm);
        stain.rotation = Math.random() * Math.PI * 2;
        view.stains.addChild(stain);
      }
    }

    const eyes = makeSprite(this.assets.eyes);
    eyes.position.set(me.x, me.y);
    eyes.rotation = me.ba;
    this.decorLayer.addChild(eyes);
  }

  private spawnBlobExplosion(ba: number, x: number, y: number): void {
    for (let i = 0; i < 32; i += 1) {
      const dec = Math.random() * 2 - 1;
      const a = ba + dec * 0.8;
      const sp = (14 - Math.abs(dec) * 8) * (0.3 + Math.random() * 0.7);
      this.spawnParticle(this.assets.oil, x, y, Math.cos(a) * sp, Math.sin(a) * sp, {
        scale: 0.5 + (i / 32) * 1.5,
        ttl: 10 + Math.random() * 20,
        weight: 0.2 + (i / 32) * 0.2,
        fadeMode: 'scale',
        layer: this.oilLayer,
      });
    }
  }

  private startBlobDrowningVisual(): void {
    this.blobView.removeFromParent();
    this.particleLayer.addChild(this.blobView);
    this.blobView.visible = true;
    this.blobView.rotation = 0;
    this.blobView.scale.set(1);
    setFrame(this.blobView, this.assets.blob[BLOB_DEATH_FRAME_START]);
  }

  private spawnSparkCollectedAnimation(cs: { x: number; y: number; type: number; score: number }): void {
    void cs.score;
    void cs.type;
    this.spawnAnimation(this.assets.startExplo, cs.x, cs.y, 0.6, this.starLayer);
    this.host.updateScore(this.sim.score);
  }

  // ------------- Particle pool -----------------------------------------------

  private spawnParticle(
    frame: Frame,
    x: number, y: number, vx: number, vy: number,
    options: {
      scale?: number; ttl?: number; weight?: number; frict?: number;
      vr?: number; vs?: number; sFrict?: number;
      fadeMode?: 'alpha' | 'scale' | 'none';
      rotation?: number; life?: number | null;
      layer?: Container; frames?: Frame[];
    } = {},
  ): void {
    const view = makeSprite(frame);
    view.position.set(x, y);
    const scale = options.scale ?? 1;
    view.scale.set(scale);
    view.rotation = options.rotation ?? 0;
    (options.layer ?? this.particleLayer).addChild(view);
    const life = options.life === undefined ? (options.ttl ?? 20) : options.life;
    this.particles.push({
      view, vx, vy,
      weight: options.weight ?? 0.2,
      frict: options.frict ?? 0.95,
      life,
      ttl: options.ttl ?? (typeof life === 'number' ? life : 0),
      scale,
      fadeMode: options.fadeMode ?? 'alpha',
      vr: options.vr ?? 0,
      vs: options.vs ?? 0,
      sFrict: options.sFrict ?? 1,
      frames: options.frames,
      frameCursor: options.frames ? 0 : undefined,
    });
  }

  private spawnAnimation(frames: Frame[], x: number, y: number, scale: number, layer: Container = this.particleLayer): void {
    const view = makeSprite(frames[0]);
    view.position.set(x, y);
    view.scale.set(scale);
    layer.addChild(view);
    this.particles.push({
      view, vx: 0, vy: 0,
      weight: 0, frict: 1,
      life: frames.length, ttl: frames.length,
      scale, fadeMode: 'none',
      vr: 0, vs: 0, sFrict: 1, frames,
    });
  }

  private spawnBubble(x: number, y: number, vy: number): void {
    const view = makeSprite(this.assets.bubble[0]);
    const scale = 0.3 + Math.random() * 0.5;
    view.position.set(x, y);
    view.scale.set(scale);
    view.blendMode = 'screen';
    this.waterParticleLayer.addChild(view);
    this.particles.push({
      view, vx: 0, vy,
      weight: -(0.15 + Math.random() * 0.5),
      frict: 0.98, life: null, ttl: 0, scale,
      fadeMode: 'none', vr: 0, vs: 0, sFrict: 1,
      bubbleFrames: this.assets.bubble,
      dec: Math.random() * 628,
      dsp: 10 + Math.random() * 20,
      ec: 0.5 + Math.random() * 4,
    });
  }

  updateParticles(): void {
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      if (particle.bubbleFrames) {
        if (particle.outTimer !== undefined) {
          particle.outTimer -= 1;
          particle.view.y = this.sim.waterY;
          particle.scale += 0.01;
          particle.view.scale.set(particle.scale);
          if (particle.outTimer < 0) {
            particle.view.removeFromParent();
            this.particles.splice(i, 1);
            i -= 1;
            continue;
          }
        } else {
          particle.dec = ((particle.dec ?? 0) + (particle.dsp ?? 0)) % 628;
          particle.vx = Math.cos((particle.dec ?? 0) / 100) * (particle.ec ?? 0);
          if (particle.view.y < this.sim.waterY) {
            particle.view.y = this.sim.waterY;
            particle.vx = 0;
            particle.vy = 0;
            setFrame(particle.view, particle.bubbleFrames[1] ?? particle.bubbleFrames[0]);
            particle.outTimer = 10 + Math.random() * 20;
          }
        }
      }
      particle.vy += particle.weight;
      particle.vx *= particle.frict;
      particle.vy *= particle.frict;
      particle.view.x += particle.vx;
      particle.view.y += particle.vy;
      particle.view.rotation += particle.vr;
      if (particle.vs !== 0) {
        particle.vs *= particle.sFrict;
        particle.scale += particle.vs;
        particle.view.scale.set(particle.scale);
      }
      if (particle.frames) {
        let index: number;
        if (particle.life === null) {
          particle.frameCursor = Math.min((particle.frameCursor ?? 0) + 1, particle.frames.length - 1);
          index = Math.floor(particle.frameCursor);
        } else {
          const elapsed = particle.ttl - particle.life;
          index = clamp(Math.floor(elapsed), 0, particle.frames.length - 1);
        }
        setFrame(particle.view, particle.frames[index]);
      }
      if (particle.life !== null) {
        particle.life -= 1;
        if (particle.life < PARTICLE_FADE_LIMIT) {
          const c = clamp(particle.life / PARTICLE_FADE_LIMIT, 0, 1);
          if (particle.fadeMode === 'scale') {
            particle.view.scale.set(particle.scale * c);
          } else if (particle.fadeMode === 'alpha') {
            particle.view.alpha = c;
          }
        }
      }
      if (particle.life !== null && particle.life <= 0) {
        particle.view.removeFromParent();
        this.particles.splice(i, 1);
        i -= 1;
      }
    }
  }

  // ============================================================================
  // Render: sync sprite positions/frames from sim state.
  // ============================================================================

  render(): void {
    this.world.y = this.sim.mapY;

    for (let i = 0; i < this.sim.wheels.length; i += 1) {
      const wheel = this.sim.wheels[i];
      const view = this.wheelViews[i];
      if (!view) continue;
      const visible = wheel.active || this.sim.isElementActive(wheel);
      view.group.visible = visible;
      view.shadow.visible = visible;
      view.group.position.set(wheel.x, wheel.y);
      view.spin.rotation = wheel.a;
      view.shadow.position.set(wheel.x, wheel.y + 6);
      view.shadow.rotation = wheel.a;
      setFrame(view.dust, this.assets.dust[wheel.dustTick % this.assets.dust.length]);
    }

    for (const [pastille, view] of this.pastilleViews) {
      view.view.visible = pastille.active || this.sim.isElementActive(pastille);
    }

    for (const [spark, view] of this.sparkViews) {
      view.position.set(spark.x, spark.y);
    }

    const water = this.waterLayer.children[0] as Sprite | undefined;
    if (water) water.y = this.sim.waterY;

    const blob = this.sim.blob;
    if (blob.state !== BLOB_STATE_DEAD) {
      this.blobView.visible = true;
      this.blobView.position.set(blob.x, blob.y);
      this.blobView.rotation = blob.state === BLOB_STATE_GRAB ? blob.angle : 0;
      if (blob.state === BLOB_STATE_FLY) {
        const a = Math.atan2(blob.vy, blob.vx);
        const frameIndex = clamp(Math.floor(60 + ((a + Math.PI) / (Math.PI * 2)) * 40) - 1, 0, this.assets.blob.length - 1);
        setFrame(this.blobView, this.assets.blob[frameIndex]);
        this.blobView.scale.x = 1;
      } else if (blob.state === BLOB_STATE_WALL) {
        const frameIndex = BLOB_COULE_FRAME_START + Math.min(blob.stateTick, BLOB_COULE_FRAME_COUNT - 1);
        setFrame(this.blobView, this.assets.blob[clamp(frameIndex, 0, this.assets.blob.length - 1)]);
        this.blobView.scale.x = 1;
      } else {
        const frameIndex = BLOB_GRAB_FRAME_START + Math.min(blob.stateTick, BLOB_GRAB_FRAME_COUNT - 1);
        setFrame(this.blobView, this.assets.blob[frameIndex]);
        this.blobView.scale.x = 1;
      }
    } else if (this.blobView.visible) {
      const frameIndex = BLOB_DEATH_FRAME_START + Math.min(blob.deathTick, BLOB_DEATH_FRAME_COUNT - 1);
      this.blobView.position.set(blob.x, blob.y);
      this.blobView.rotation = 0;
      this.blobView.scale.x = 1;
      setFrame(this.blobView, this.assets.blob[frameIndex]);
    }
  }

  private updateHud(): void {
    const heightMeters = Math.floor(this.sim.maxHeight * 0.2);
    const text = `${heightMeters}m`;
    if (this.meterText.text !== text) {
      this.meterText.text = text;
    }
    // Score / metric host calls — only on change, since host may push them
    // to React state on every call.
    if (this.sim.events.collectedSparks.length === 0) {
      // fast path: only update score on height tick.
      // (A small amount of redundant calls is harmless; keeping it
      // unconditional matches the previous behaviour exactly.)
    }
    this.host.updateScore(this.sim.score);
    this.host.updateMetric({ key: 'height', label: 'Height', value: heightMeters, unit: 'm' });
  }
}

export async function mount(container: HTMLElement, context?: GameMountContext): Promise<GameInstance> {
  const app = new Application();
  const runtimeAssets = runtimeAssetsFromLocation();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    }),
    loadAssets(runtimeAssets.assetRoot, runtimeAssets.assetScale),
  ]);
  container.appendChild(app.canvas);

  const game = new InterwheelGame(app, assets, context?.host ?? noopGameHost, runtimeAssets);
  context?.onReady?.(game);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Space') return;
    event.preventDefault();
    if (game.ended || game.ending) return;
    if (!game.spaceHeld) game.spacePressed = true;
    game.spaceHeld = true;
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Space') game.spaceHeld = false;
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (game.ended || game.ending) return;
    game.pointerPressed = true;
  };
  const onContextMenu = (event: MouseEvent) => event.preventDefault();
  const onBlur = () => { game.spaceHeld = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  app.canvas.addEventListener('pointerdown', onPointerDown);
  app.canvas.addEventListener('contextmenu', onContextMenu);

  let acc = 0;
  const tickerCallback = () => {
    acc += Math.min(app.ticker.deltaMS / 1000, 0.08);
    while (acc >= STEP_SECONDS) {
      game.update();
      acc -= STEP_SECONDS;
    }
  };
  app.ticker.add(tickerCallback);

  return {
    destroy() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      app.canvas.removeEventListener('pointerdown', onPointerDown);
      app.canvas.removeEventListener('contextmenu', onContextMenu);
      app.ticker.remove(tickerCallback);
      app.destroy(true, { children: true, texture: false });
    },
  };
}
