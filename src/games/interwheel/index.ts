import { Application, Container, Sprite, Text } from 'pixi.js';
import type { GameInstance } from '../types';
import { type Frame, loadFrame, loadSeries, makeSprite, setFrame } from '../_shared/frames';

const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 300;
const FPS = 40;
const STEP_SECONDS = 1 / FPS;

const SIDE = 10;
const SPACE = 8;
const VIEW_WHEEL = 50;
const START_WHEEL_ID = 10;
const WMAX = 50;

const WHEEL_SPEED_MIN = 0.05;
const WHEEL_SPEED_MAX = 0.25;
const WHEEL_SPEED_RANDOM = 0.05;
const WHEEL_DIST_MIN = 60;
const WHEEL_DIST_MAX = 120;
const WHEEL_RAY_MIN = 8;
const WHEEL_RAY_MAX = 32;
const WHEEL_RAY_RANDOM = 50;
const DIF_RANDOMIZER = 0.1;

const WATER_SPEED = 1;
const WATER_SPEED_INC = 0.0003;
const SCORE_PASTILLE = [250, 1000, 5000];
const BLOB_RAY = 8;
const BLOB_WEIGHT = 0.5;
const BLOB_JUMP = 12;
const JUMP_SIDE_ANGLE = 0.77;
const BLOB_BLOP_START = 0.6;
const BLOB_BLOP_MIN = 0.07;
const BLOB_BLOP_FRICT = 0.94;
const BLOB_COULE_FRAME_START = 19;
const BLOB_COULE_FRAME_COUNT = 25;
const BLOB_GRAB_FRAME_START = 44;
const BLOB_GRAB_FRAME_COUNT = 15;
const BLOB_DEATH_FRAME_START = 100;
const BLOB_DEATH_FRAME_COUNT = 73;
const MINE_SPACE = 36;
const PARTICLE_FADE_LIMIT = 10;
const ENDGAME_DELAY = 30;
const DECOR_SECTION_HEIGHT = 2000;
const DECOR_SECTIONS = 5;

const ASSET_ROOT = '/assets/interwheel';

const enum BlobState {
  Fly = 1,
  Grab = 2,
  Wall = 3,
  Dead = 4,
}

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

type Wheel = {
  x: number;
  y: number;
  ray: number;
  speed: number;
  a: number;
  fr: number;
  mines: number[];
  mineSprites: Sprite[];
  destroyed: boolean;
  boomAngle: number | null;
  group: Container;
  spin: Container;
  shadow: Sprite;
  dust: Sprite;
  stains: Container;
  stainMask: Sprite;
  dustOffset: number;
};

type Pastille = {
  x: number;
  y: number;
  ray: number;
  type: number;
  phase: number;
  view: Container;
  core: Sprite;
};

type Blob = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: BlobState;
  wallSide: -1 | 0 | 1;
  stateTick: number;
  cw: Wheel | null;
  wa: number;
  angle: number;
  wet: number;
  wasInWater: boolean;
  blop: number;
  ox: number;
  oy: number;
  vvx: number;
  vvy: number;
  view: Sprite;
  deathTick: number;
};

type Spark = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: number;
  score: number;
  distLimit: number;
  coefLimit: number;
  coef: number;
  view: Container;
};

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

function randomInt(max: number): number {
  if (max <= 1) {
    return 0;
  }
  return Math.floor(Math.random() * max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function hMod(value: number, mod: number): number {
  let v = value;
  while (v > mod) {
    v -= mod * 2;
  }
  while (v < -mod) {
    v += mod * 2;
  }
  return v;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function angleTo(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

async function loadAssets(): Promise<InterwheelAssets> {
  const [
    bg,
    background,
    water,
    mine,
    side,
    panel,
    oil,
    star,
    blob,
    wheelBase,
    wheelLight,
    mask,
    dust,
    pastille,
    pastilleCore,
    tile,
    motif,
    frise,
    explosion,
    startExplo,
    smoke,
    mineParts,
    tache,
    wallTache,
    goutte,
    bubble,
    eyes,
    starTache,
  ] = await Promise.all([
    loadFrame(`${ASSET_ROOT}/bg.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/background.png`, 0, 599.95),
    loadFrame(`${ASSET_ROOT}/water.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/mine.png`, 8.65, 11.85),
    loadFrame(`${ASSET_ROOT}/side.png`, 1, 0.45),
    loadFrame(`${ASSET_ROOT}/panel.png`, -1.45, -1.4),
    loadFrame(`${ASSET_ROOT}/oil.png`, 2.5, 2.5),
    loadFrame(`${ASSET_ROOT}/star.png`, 7, 7),
    loadSeries(`${ASSET_ROOT}/blob`, 173, 35.95, 34.9),
    loadSeries(`${ASSET_ROOT}/wheel-base`, 5, 50.5, 50.5),
    loadSeries(`${ASSET_ROOT}/wheel-light`, 3, 37.5, 7.4),
    loadSeries(`${ASSET_ROOT}/mask`, 17, 50.5, 50.5),
    loadSeries(`${ASSET_ROOT}/dust`, 18, 31, 23.5),
    loadSeries(`${ASSET_ROOT}/pastille`, 2, 20, 20),
    loadSeries(`${ASSET_ROOT}/pastille-core`, 3, 5, 5),
    loadSeries(`${ASSET_ROOT}/tile`, 40, 0.1, 0.35),
    loadSeries(`${ASSET_ROOT}/motif`, 51, 78.5, 71),
    loadSeries(`${ASSET_ROOT}/frise`, 12, 140, 57.5),
    loadSeries(`${ASSET_ROOT}/explosion`, 14, 75.55, 86.6),
    loadSeries(`${ASSET_ROOT}/start-explo`, 15, 75.55, 86.6),
    loadSeries(`${ASSET_ROOT}/smoke`, 25, 18, 18),
    loadSeries(`${ASSET_ROOT}/mine-parts`, 2, 6, 6),
    loadSeries(`${ASSET_ROOT}/tache`, 19, 6.5, 6),
    loadSeries(`${ASSET_ROOT}/wall-tache`, 4, 18, 13.5),
    loadFrame(`${ASSET_ROOT}/goutte/1.png`, 4, 4),
    loadSeries(`${ASSET_ROOT}/bubble`, 2, 7, 6),
    loadFrame(`${ASSET_ROOT}/eyes/1.png`, 2.5, 4.5),
    loadFrame(`${ASSET_ROOT}/star-tache/1.png`, 69, 54),
  ]);

  return {
    bg,
    background,
    water,
    mine,
    side,
    panel,
    oil,
    star,
    blob,
    wheelBase,
    wheelLight,
    mask,
    dust,
    pastille,
    pastilleCore,
    tile,
    motif,
    frise,
    explosion,
    startExplo,
    smoke,
    mineParts,
    tache,
    wallTache,
    goutte,
    bubble,
    eyes,
    starTache,
  };
}

class InterwheelGame {
  readonly app: Application;
  readonly assets: InterwheelAssets;
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
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 15,
      fontWeight: '700',
      fill: 0x132329,
      stroke: { color: 0xf5fff8, width: 3 },
    },
  });

  readonly scoreText = new Text({
    text: '0',
    style: {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 12,
      fontWeight: '700',
      fill: 0xf7f7f7,
      stroke: { color: 0x173640, width: 3 },
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

  wheels: Wheel[] = [];
  pastilles: Pastille[] = [];
  sparks: Spark[] = [];
  particles: Particle[] = [];
  blob: Blob;

  mapY = 0;
  svy = 0;
  roof = 0;
  waterY = -300;
  waterBoost = 0;
  heightOrigin = 0;
  maxHeight = 0;
  score = 0;
  tick = 0;
  ending = false;
  endTimer = 0;
  endFocusY = 0;
  ended = false;
  spaceHeld = false;
  spacePressed = false;
  pointerPressed = false;

  constructor(app: Application, assets: InterwheelAssets) {
    this.app = app;
    this.assets = assets;

    const bg = makeSprite(assets.bg);
    this.app.stage.addChild(bg, this.world, this.hudLayer);
    this.world.addChild(
      this.decorLayer,
      this.shadowLayer,
      this.oilLayer,
      this.blobLayer,
      this.wheelLayer,
      this.pastilleLayer,
      this.starLayer,
      this.particleLayer,
      this.waterLayer,
      this.waterParticleLayer,
    );

    const panel = makeSprite(assets.panel);
    panel.position.set(238, 265);
    this.hudLayer.addChild(panel);

    this.meterText.anchor.set(0.5);
    this.meterText.position.set(263, 280);
    this.scoreText.position.set(10, 8);
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(150, 145);
    this.hudLayer.addChild(this.scoreText, this.meterText, this.gameOverText);

    const blobView = makeSprite(assets.blob[0]);
    this.blobLayer.addChild(blobView);
    this.blob = {
      x: STAGE_WIDTH * 0.5,
      y: 0,
      vx: 0,
      vy: 0,
      state: BlobState.Grab,
      wallSide: 0,
      stateTick: 0,
      cw: null,
      wa: 0,
      angle: 0,
      wet: 0,
      wasInWater: false,
      blop: 0,
      ox: STAGE_WIDTH * 0.5,
      oy: 0,
      vvx: 0,
      vvy: 0,
      view: blobView,
      deathTick: 0,
    };

    this.reset();
  }

  reset(): void {
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

    this.wheels = [];
    this.pastilles = [];
    this.sparks = [];
    this.particles = [];
    this.mapY = 0;
    this.svy = 0;
    this.waterY = -300;
    this.waterBoost = 0;
    this.maxHeight = 0;
    this.score = 0;
    this.tick = 0;
    this.ending = false;
    this.endTimer = 0;
    this.endFocusY = 0;
    this.ended = false;
    this.spacePressed = false;
    this.pointerPressed = false;
    this.gameOverText.text = '';
    this.scoreText.text = '0';
    this.meterText.text = '0m';

    this.buildDecor();
    this.initWheels();
    this.initPastilles();

    this.blob.view = makeSprite(this.assets.blob[0]);
    this.blobLayer.addChild(this.blob.view);
    this.blob.x = STAGE_WIDTH * 0.5;
    this.blob.y = 0;
    this.blob.vx = 0;
    this.blob.vy = 0;
    this.blob.wet = 0;
    this.blob.wasInWater = false;
    this.blob.blop = 0;
    this.blob.ox = this.blob.x;
    this.blob.oy = this.blob.y;
    this.blob.vvx = 0;
    this.blob.vvy = 0;
    this.blob.deathTick = 0;
    this.blob.stateTick = 0;
    this.grabWheel(this.wheels[START_WHEEL_ID]);
    this.heightOrigin = -this.blob.y;

    const water = makeSprite(this.assets.water);
    water.position.set(0, this.waterY);
    this.waterLayer.addChild(water);

    this.scrollMap(true);
    this.render();
  }

  buildDecor(): void {
    for (let section = 0; section < DECOR_SECTIONS; section += 1) {
      const sectionTop = -(section + 1) * DECOR_SECTION_HEIGHT;

      for (let y = 0; y < DECOR_SECTION_HEIGHT; y += 40) {
        for (let x = 0; x < STAGE_WIDTH; x += 40) {
          const frameIndex = Math.min(section * 10 + randomInt(10), this.assets.tile.length - 1);
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

  initWheels(): void {
    const list: Wheel[] = [];
    let oldWheel = this.createWheelData();
    oldWheel.ray = (STAGE_WIDTH - 2 * (SIDE + SPACE)) * 0.5;
    oldWheel.x = STAGE_WIDTH * 0.5;
    oldWheel.y = 0;
    oldWheel.speed = 0.1;
    list.push(oldWheel);

    for (let i = 0; i < WMAX; i += 1) {
      const c = clamp(i / WMAX + (Math.random() * 2 - 1) * DIF_RANDOMIZER, 0, 1);
      const c2 = clamp(i / WMAX + (Math.random() * 2 - 1) * DIF_RANDOMIZER, 0, 1);
      const c3 = clamp(i / WMAX + (Math.random() * 2 - 1) * DIF_RANDOMIZER, 0, 1);
      const wheel = this.createWheelData();

      wheel.ray = WHEEL_RAY_MIN + (1 - c2) * (WHEEL_RAY_MAX - WHEEL_RAY_MIN) + Math.random() * WHEEL_RAY_RANDOM;
      wheel.speed = WHEEL_SPEED_MIN + c3 * (WHEEL_SPEED_MAX - WHEEL_SPEED_MIN) + Math.random() * WHEEL_SPEED_RANDOM;

      const dist = WHEEL_DIST_MIN + c * (WHEEL_DIST_MAX - WHEEL_DIST_MIN) + oldWheel.ray + wheel.ray;
      const lim = SIDE + SPACE + wheel.ray;
      let tries = 0;
      while (tries < 200) {
        const a = -1.57 + (Math.random() * 2 - 1) * 1.4;
        wheel.x = oldWheel.x + Math.cos(a) * dist;
        wheel.y = oldWheel.y + Math.sin(a) * dist;
        let valid = wheel.x > lim && wheel.x < STAGE_WIDTH - lim;
        const prevPrev = list[list.length - 2];
        if (valid && prevPrev && distance(wheel, prevPrev) < wheel.ray + prevPrev.ray) {
          valid = false;
        }
        if (valid) {
          break;
        }
        tries += 1;
      }

      while (Math.random() + 0.4 < c) {
        this.addMine(wheel);
      }

      if (Math.random() > c) {
        const interWheel = this.createWheelData();
        interWheel.y = (wheel.y + oldWheel.y) * 0.5;
        let tr = 0;
        while (tr <= 30) {
          interWheel.ray = WHEEL_RAY_MIN + 10 + Math.random() * (WHEEL_RAY_MAX - WHEEL_RAY_MIN);
          interWheel.speed = WHEEL_SPEED_MIN + Math.random() * (WHEEL_SPEED_MAX - WHEEL_SPEED_MIN);
          const m = SIDE + SPACE + interWheel.ray;
          interWheel.x = STAGE_WIDTH - m;
          const valid =
            distance(interWheel, wheel) >= interWheel.ray + wheel.ray + SPACE &&
            distance(interWheel, oldWheel) >= interWheel.ray + oldWheel.ray + SPACE;
          if (valid) {
            list.push(interWheel);
            break;
          }
          tr += 1;
        }
      }

      oldWheel = wheel;
      list.push(wheel);
    }

    this.roof = oldWheel.y - oldWheel.ray;
    this.wheels = list;
    for (const wheel of this.wheels) {
      this.attachWheel(wheel);
    }
  }

  createWheelData(): Wheel {
    return {
      x: 0,
      y: 0,
      ray: 20,
      speed: 0.1,
      a: 0,
      fr: randomInt(5) + 1,
      mines: [],
      mineSprites: [],
      destroyed: false,
      boomAngle: null,
      group: new Container(),
      spin: new Container(),
      shadow: new Sprite(),
      dust: new Sprite(),
      stains: new Container(),
      stainMask: new Sprite(),
      dustOffset: randomInt(18),
    };
  }

  addMine(wheel: Wheel): void {
    const perim = Math.PI * 2 * wheel.ray;
    if (wheel.mines.length > 0 && perim / wheel.mines.length < MINE_SPACE * 2) {
      return;
    }

    let tries = 0;
    while (tries <= 20) {
      const a = Math.random() * Math.PI * 2;
      const valid = wheel.mines.every((mine) => Math.abs(hMod(mine - a, Math.PI)) * wheel.ray >= MINE_SPACE);
      if (valid) {
        wheel.mines.push(a);
        return;
      }
      tries += 1;
    }
  }

  attachWheel(wheel: Wheel): void {
    wheel.group = new Container();
    wheel.group.position.set(wheel.x, wheel.y);

    wheel.shadow = makeSprite(this.assets.mask[wheel.fr - 1] ?? this.assets.mask[this.assets.mask.length - 1]);
    wheel.shadow.tint = 0x000000;
    wheel.shadow.alpha = 0.2;
    wheel.shadow.y = 6;
    wheel.shadow.scale.set((wheel.ray * 2) / 100);
    this.shadowLayer.addChild(wheel.shadow);

    wheel.dust = makeSprite(this.assets.dust[0]);
    wheel.dust.scale.set((wheel.ray * 2) / 100);

    wheel.spin = new Container();
    wheel.spin.scale.set((wheel.ray * 2) / 100);
    wheel.mineSprites = [];

    for (const mineAngle of wheel.mines) {
      const mine = makeSprite(this.assets.mine);
      mine.position.set(Math.cos(mineAngle) * 50, Math.sin(mineAngle) * 50);
      mine.scale.set(100 / (wheel.ray * 2));
      mine.rotation = mineAngle;
      wheel.spin.addChild(mine);
      wheel.mineSprites.push(mine);
    }

    const base = makeSprite(this.assets.wheelBase[wheel.fr - 1]);
    wheel.spin.addChild(base);

    wheel.stains = new Container();
    wheel.stainMask = makeSprite(this.assets.mask[wheel.fr - 1] ?? this.assets.mask[this.assets.mask.length - 1]);
    wheel.stains.mask = wheel.stainMask;
    wheel.stainMask.renderable = false;
    wheel.spin.addChild(wheel.stains, wheel.stainMask);

    const lightFrame = this.assets.wheelLight[Math.min(wheel.fr - 1, this.assets.wheelLight.length - 1)];
    const light = makeSprite(lightFrame);
    light.alpha = 0.62;
    light.scale.set(wheel.fr === 2 ? (wheel.ray * 2) / 100 : 1);
    wheel.group.addChild(wheel.dust, wheel.spin, light);
    this.wheelLayer.addChild(wheel.group);
  }

  makePastilleView(type: number): { view: Container; core: Sprite } {
    const view = new Container();
    const body = makeSprite(this.assets.pastille[0]);
    const core = makeSprite(this.assets.pastilleCore[type] ?? this.assets.pastilleCore[0]);
    view.addChild(body, core);
    return { view, core };
  }

  initPastilles(): void {
    for (let y = -100; y > this.roof; y -= 20) {
      if (Math.random() >= y / this.roof) {
        continue;
      }

      let type = 0;
      if (randomInt(30) === 0) {
        type = 1;
      }
      if (randomInt(200) === 0) {
        type = 2;
      }

      const ray = 20;
      const m = SIDE + ray;
      const pastilleView = this.makePastilleView(type);
      const pastille = {
        x: m + Math.random() * (STAGE_WIDTH - 2 * m),
        y,
        ray,
        type,
        phase: Math.random() * Math.PI * 2,
        view: pastilleView.view,
        core: pastilleView.core,
      };

      const overlapsWheel = this.wheels.some((wheel) => distance(pastille, wheel) < wheel.ray + ray);
      if (overlapsWheel) {
        continue;
      }

      pastille.view.position.set(pastille.x, pastille.y);
      this.pastilleLayer.addChild(pastille.view);
      this.pastilles.push(pastille);
    }
  }

  checkPress(): boolean {
    if (this.spacePressed) {
      this.spacePressed = false;
      return true;
    }
    if (this.pointerPressed) {
      this.pointerPressed = false;
      return true;
    }
    return false;
  }

  isElementActive(element: { y: number; ray: number }): boolean {
    const viewTop = -this.mapY;
    const viewBottom = viewTop + STAGE_HEIGHT;
    return element.y - element.ray < viewBottom && element.y + element.ray > viewTop;
  }

  update(): void {
    this.tick += 1;

    if (this.ended) {
      this.updateParticles();
      this.render();
      return;
    }

    if (this.ending) {
      this.updateWheels();
      this.updateBlobDeath();
      this.separateSparks();
      this.updateSparks();
      this.updateParticles();
      this.updateBlobWaterEffects();
      this.scrollMap(false);
      this.endTimer -= 1;
      if (this.endTimer < 0) {
        this.ending = false;
        this.ended = true;
      }
      this.render();
      return;
    }

    this.updateWheels();
    this.checkWheelCollision();
    this.updateBlob();
    this.updatePastilles();
    this.separateSparks();
    this.updateSparks();
    this.updateParticles();
    this.updateWaterAndScore();
    this.scrollMap(false);
    this.render();
  }

  updateWheels(): void {
    for (const wheel of this.wheels) {
      if (!this.isElementActive(wheel)) {
        continue;
      }
      wheel.a += wheel.speed;
      if (wheel.destroyed) {
        wheel.speed *= 0.97;
        if (wheel.boomAngle !== null && Math.random() < Math.abs(wheel.speed) * 5) {
          const a = wheel.a + wheel.boomAngle;
          const dist = wheel.ray - (5 + Math.random() * 5);
          this.spawnParticle(
            this.assets.oil,
            wheel.x + Math.cos(a) * dist,
            wheel.y + Math.sin(a) * dist,
            0,
            0,
            {
              scale: 0.8 + Math.random() * 0.8,
              ttl: 10 + Math.random() * 20,
              weight: 0.1 + Math.random() * 0.1,
              fadeMode: 'scale',
            },
          );
        }
      }
    }
  }

  updateBlob(): void {
    const blob = this.blob;

    if (blob.state === BlobState.Grab && blob.cw) {
      blob.stateTick += 1;
      const a = blob.cw.a - blob.wa;
      blob.x = blob.cw.x + Math.cos(a) * blob.cw.ray;
      blob.y = blob.cw.y + Math.sin(a) * blob.cw.ray;
      blob.angle = a;
      blob.vx = 0;
      blob.vy = 0;
      if (this.checkPress()) {
        this.jump(a);
        const oldX = blob.x;
        const oldY = blob.y;
        this.integrateBlobFlight(false);
        blob.vvx = oldX - blob.x;
        blob.vvy = oldY - blob.y;
        blob.ox = blob.x;
        blob.oy = blob.y;
        this.checkSideCollision();
      }
      return;
    }

    if (blob.state === BlobState.Wall) {
      blob.stateTick += 1;
      blob.wallSide = blob.wallSide || (blob.x < STAGE_WIDTH * 0.5 ? -1 : 1);
      blob.x = blob.wallSide < 0 ? SIDE : STAGE_WIDTH - SIDE;
      blob.vx = 0;
      blob.vy += 0.6;
      blob.vy *= 0.92;
      if (this.checkPress()) {
        const sens = -blob.wallSide;
        this.jump(-Math.PI * 0.5 + JUMP_SIDE_ANGLE * sens);
      }
    }

    if (blob.state === BlobState.Fly || blob.state === BlobState.Wall) {
      if (blob.state === BlobState.Fly) {
        blob.stateTick += 1;
        this.spawnFlyTrail();
      }
      const oldX = blob.x;
      const oldY = blob.y;
      this.integrateBlobFlight();
      if (blob.state === BlobState.Fly) {
        blob.vvx = oldX - blob.x;
        blob.vvy = oldY - blob.y;
        blob.ox = blob.x;
        blob.oy = blob.y;
      }
    }

    this.checkSideCollision();
  }

  spawnFlyTrail(): void {
    const blob = this.blob;
    blob.blop = Math.max(BLOB_BLOP_MIN, blob.blop * BLOB_BLOP_FRICT);
    if (Math.random() >= blob.blop) {
      return;
    }

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

  integrateBlobFlight(applyWaterDrag = true): void {
    const blob = this.blob;
    if (applyWaterDrag && blob.state === BlobState.Fly && blob.wasInWater) {
      blob.vx *= 0.95;
      blob.vy *= 0.95;
    }
    blob.vy += BLOB_WEIGHT;
    blob.vx *= 0.98;
    blob.vy *= 0.98;

    blob.x += blob.vx;
    blob.y += blob.vy;
  }

  checkSideCollision(): void {
    const blob = this.blob;
    if (blob.state === BlobState.Fly && (blob.x < SIDE || blob.x > STAGE_WIDTH - SIDE)) {
      this.enterWall(blob.x < SIDE ? -1 : 1);
    }
  }

  enterWall(side: -1 | 1): void {
    const blob = this.blob;
    blob.state = BlobState.Wall;
    blob.wallSide = side;
    blob.stateTick = 0;
    blob.x = side < 0 ? SIDE : STAGE_WIDTH - SIDE;
    blob.vx = 0;
  }

  jump(a: number): void {
    const blob = this.blob;
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

    blob.vx = Math.cos(a) * BLOB_JUMP;
    blob.vy = Math.sin(a) * BLOB_JUMP;
    blob.blop = BLOB_BLOP_START;
    blob.ox = blob.x;
    blob.oy = blob.y;
    blob.vvx = 0;
    blob.vvy = 0;
    blob.state = BlobState.Fly;
    blob.wallSide = 0;
    blob.stateTick = 0;
    blob.cw = null;
  }

  grabWheel(wheel: Wheel): void {
    const blob = this.blob;
    const ba = angleTo(blob, wheel) + Math.PI;
    blob.cw = wheel;
    blob.wa = hMod(wheel.a - ba, Math.PI);
    blob.state = BlobState.Grab;
    blob.wallSide = 0;
    blob.stateTick = 0;
    blob.vx = 0;
    blob.vy = 0;
    const a = wheel.a - blob.wa;
    blob.x = wheel.x + Math.cos(a) * wheel.ray;
    blob.y = wheel.y + Math.sin(a) * wheel.ray;
    blob.angle = a;
  }

  checkWheelCollision(): void {
    const blob = this.blob;
    if (blob.state !== BlobState.Fly) {
      return;
    }

    for (const wheel of this.wheels) {
      if (!this.isElementActive(wheel)) {
        continue;
      }
      if (distance(blob, wheel) >= wheel.ray + BLOB_RAY) {
        continue;
      }

      const ba = angleTo(blob, wheel) + Math.PI;
      for (let i = 0; i < wheel.mines.length; i += 1) {
        const mineAngle = wheel.mines[i];
        const da = hMod(mineAngle + wheel.a - ba, Math.PI);
        if (Math.abs(da) * wheel.ray < MINE_SPACE) {
          const x = wheel.x + Math.cos(wheel.a + mineAngle) * wheel.ray;
          const y = wheel.y + Math.sin(wheel.a + mineAngle) * wheel.ray;
          wheel.destroyed = true;
          wheel.boomAngle = mineAngle;
          wheel.mineSprites[i]?.removeFromParent();
          this.explodeMine(wheel, mineAngle, x, y, ba);
          this.explodeBlob(ba);
          return;
        }
      }

      this.grabWheel(wheel);
      return;
    }
  }

  explodeMine(wheel: Wheel, mineAngle: number, x: number, y: number, ba: number): void {
    this.spawnAnimation(this.assets.explosion, x, y, 0.5);

    for (let i = 0; i < 5; i += 1) {
      const a = ba + (Math.random() * 2 - 1) * 1.57;
      const ray = 4;
      const sp = 1 + Math.random() * 4;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      this.spawnParticle(this.assets.mineParts[randomInt(this.assets.mineParts.length)], x + ca * ray, y + sa * ray, ca * sp, sa * sp, {
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
      this.spawnParticle(this.assets.smoke[randomInt(this.assets.smoke.length)], x, y, Math.cos(a) * sp, Math.sin(a) * sp, {
        scale: 0.8 + Math.random() * 0.6,
        ttl: 10 + Math.random() * 20,
        weight: -(0.1 + Math.random() * 0.3),
        frict: 0.95,
        vr: (Math.random() * 2 - 1) * 12 * (Math.PI / 180),
        rotation: Math.random() * Math.PI * 2,
      });
    }

    for (let i = 0; i < 4; i += 1) {
      const a = ba + (Math.random() * 2 - 1) * 1.57;
      const sp = Math.random() * 36;
      const stain = makeSprite(this.assets.wallTache[randomInt(this.assets.wallTache.length)]);
      stain.position.set(x + Math.cos(a) * sp, y + Math.sin(a) * sp);
      stain.rotation = Math.random() * Math.PI * 2;
      stain.scale.set(0.5 + Math.random() * 0.5);
      this.decorLayer.addChild(stain);
    }

    this.spawnParticle(this.assets.starTache, x, y, 0, 0, {
      scale: 0.4,
      weight: 0,
      frict: 1,
      life: null,
      fadeMode: 'none',
      vs: 0.3,
      sFrict: 0.65,
      rotation: Math.random() * Math.PI * 2,
      layer: this.decorLayer,
    });

    const bx = Math.cos(mineAngle) * 50;
    const by = Math.sin(mineAngle) * 50;
    const scm = 100 / (wheel.ray * 2);
    for (let i = 0; i < 4; i += 1) {
      const stain = makeSprite(this.assets.wallTache[randomInt(this.assets.wallTache.length)]);
      const a = mineAngle + Math.PI + (Math.random() * 2 - 1) * 1.57;
      const sp = Math.random() * 10 * scm;
      stain.position.set(bx + Math.cos(a) * sp, by + Math.sin(a) * sp);
      stain.scale.set((0.5 + Math.random() * 0.6) * scm);
      stain.rotation = Math.random() * Math.PI * 2;
      wheel.stains.addChild(stain);
    }

    const eyes = makeSprite(this.assets.eyes);
    eyes.position.set(x, y);
    eyes.rotation = ba;
    this.decorLayer.addChild(eyes);
  }

  explodeBlob(ba: number): void {
    const blob = this.blob;
    blob.state = BlobState.Dead;
    blob.deathTick = 0;
    blob.stateTick = 0;
    blob.view.visible = false;

    for (let i = 0; i < 32; i += 1) {
      const dec = Math.random() * 2 - 1;
      const a = ba + dec * 0.8;
      const sp = (14 - Math.abs(dec) * 8) * (0.3 + Math.random() * 0.7);
      this.spawnParticle(this.assets.oil, blob.x, blob.y, Math.cos(a) * sp, Math.sin(a) * sp, {
        scale: 0.5 + (i / 32) * 1.5,
        ttl: 10 + Math.random() * 20,
        weight: 0.2 + (i / 32) * 0.2,
        fadeMode: 'scale',
        layer: this.oilLayer,
      });
    }
    this.endGame();
  }

  startBlobDrowningDeath(): void {
    const blob = this.blob;
    if (blob.state === BlobState.Dead && blob.view.visible) {
      return;
    }

    blob.state = BlobState.Dead;
    blob.deathTick = 0;
    blob.stateTick = 0;
    blob.wallSide = 0;
    blob.view.removeFromParent();
    this.particleLayer.addChild(blob.view);
    blob.view.visible = true;
    blob.view.rotation = 0;
    blob.view.scale.set(1);
    setFrame(blob.view, this.assets.blob[BLOB_DEATH_FRAME_START]);
  }

  updateBlobDeath(): void {
    const blob = this.blob;
    if (blob.state !== BlobState.Dead || !blob.view.visible) {
      return;
    }

    blob.wet -= 0.02;
    blob.vy += BLOB_WEIGHT;
    blob.vx *= 0.8;
    blob.vy *= 0.8;
    blob.x += blob.vx;
    blob.y += blob.vy;
    blob.deathTick += 1;
  }

  updatePastilles(): void {
    const blob = this.blob;
    for (let i = 0; i < this.pastilles.length; i += 1) {
      const pastille = this.pastilles[i];
      if (!this.isElementActive(pastille)) {
        continue;
      }
      if (distance(blob, pastille) < 70) {
        this.collectPastille(pastille);
        this.pastilles.splice(i, 1);
        i -= 1;
        continue;
      }

      const scale = 0.9 + Math.random() * 0.2;
      pastille.core.scale.set(scale);
    }
  }

  collectPastille(pastille: Pastille): void {
    pastille.view.removeFromParent();
    const { view } = this.makePastilleView(pastille.type);
    view.position.set(pastille.x, pastille.y);
    this.particleLayer.addChild(view);
    this.sparks.push({
      x: pastille.x,
      y: pastille.y,
      vx: 0,
      vy: 0,
      type: pastille.type,
      score: SCORE_PASTILLE[pastille.type],
      distLimit: 5,
      coefLimit: 0.1,
      coef: 0.01,
      view,
    });
  }

  updateSparks(): void {
    const blob = this.blob;
    for (let i = 0; i < this.sparks.length; i += 1) {
      const spark = this.sparks[i];
      spark.distLimit += 0.05;
      spark.coefLimit += 0.001;
      spark.coef = Math.min(spark.coef + 0.005, spark.coefLimit);
      spark.vx *= 0.9;
      spark.vy *= 0.9;
      spark.vx += clamp((blob.x - spark.x) * spark.coef, -spark.distLimit, spark.distLimit);
      spark.vy += clamp((blob.y - spark.y) * spark.coef, -spark.distLimit, spark.distLimit);
      spark.x += spark.vx;
      spark.y += spark.vy;
      spark.view.position.set(spark.x, spark.y);

      if (Math.random() < 0.4) {
        this.spawnParticle(this.assets.star, spark.x, spark.y, spark.vx * (0.5 + (Math.random() * 2 - 1) * 0.1), spark.vy * (0.5 + (Math.random() * 2 - 1) * 0.1), {
          scale: 0.7 + Math.random() * 0.4,
          ttl: 10 + Math.random() * 10,
          weight: 0.1 + Math.random() * 0.1,
          fadeMode: 'scale',
          layer: this.starLayer,
        });
      }

      if (distance(blob, spark) < BLOB_RAY + 8) {
        this.score += spark.score;
        this.spawnAnimation(this.assets.startExplo, spark.x, spark.y, 0.6, this.starLayer);
        spark.view.removeFromParent();
        this.sparks.splice(i, 1);
        i -= 1;
      }
    }
  }

  separateSparks(): void {
    for (let i = 0; i < this.sparks.length; i += 1) {
      const p0 = this.sparks[i];
      for (let n = i + 1; n < this.sparks.length; n += 1) {
        const p1 = this.sparks[n];
        const dif = 16 - distance(p0, p1);
        if (dif <= 0) {
          continue;
        }
        const a = angleTo(p0, p1);
        const cx = Math.cos(a) * dif * 0.5;
        const cy = Math.sin(a) * dif * 0.5;
        p0.x -= cx;
        p0.y -= cy;
        p1.x += cx;
        p1.y += cy;
      }
    }
  }

  updateWaterAndScore(): void {
    const blob = this.blob;
    this.waterBoost += WATER_SPEED_INC;
    this.waterY -= WATER_SPEED + this.waterBoost;

    this.updateBlobWaterEffects();

    if (blob.wet > 1) {
      this.startBlobDrowningDeath();
      this.endGame();
    }

    const runHeight = Math.max(0, -blob.y - this.heightOrigin);
    const heightGain = runHeight - this.maxHeight;
    if (heightGain > 0) {
      this.score += Math.floor(heightGain);
    }
    this.maxHeight = Math.max(runHeight, this.maxHeight);
    this.meterText.text = `${Math.floor(this.maxHeight * 0.2)}m`;
    this.scoreText.text = String(Math.floor(this.score));
  }

  updateBlobWaterEffects(): void {
    const blob = this.blob;
    if (blob.state === BlobState.Dead && !blob.view.visible) {
      return;
    }
    const inWater = blob.y - BLOB_RAY > this.waterY;
    if (inWater) {
      if (blob.state !== BlobState.Dead) {
        blob.wet += 0.015;
      }
      if (blob.vy > 0) {
        blob.vy *= 0.9;
      }
      if (Math.random() < blob.wet) {
        this.spawnParticle(this.assets.tache[0], blob.x, blob.y, blob.vx * 0.5 + (Math.random() * 2 - 1), blob.vy * 0.5 + (Math.random() * 2 - 1) * 0.5, {
          scale: 1 + blob.wet * 1.5 + Math.random(),
          life: null,
          weight: 0,
          fadeMode: 'none',
          layer: this.oilLayer,
          frames: this.assets.tache,
        });
      }
      if (Math.random() < blob.wet) {
        this.spawnBubble(blob.x + Math.random() * BLOB_RAY, blob.y + Math.random() * BLOB_RAY, blob.vy * 0.8);
      }
    } else if (blob.wet > 0) {
      if (blob.state !== BlobState.Dead) {
        blob.wet = Math.max(0, blob.wet - 0.02);
      }

      if (Math.random() * 0.5 < blob.wet) {
        const coef = 0.2 + Math.random() * 0.4;
        this.spawnParticle(this.assets.goutte, blob.x + (Math.random() * 2 - 1) * 6, blob.y + (Math.random() * 2 - 1) * 6, (blob.vvx + blob.vx) * coef, (blob.vvy + blob.vy) * coef, {
          scale: 0.6 + blob.wet * 0.8 + Math.random() * 0.5,
          ttl: 10 + Math.random() * 10,
          weight: 0,
          fadeMode: 'scale',
          layer: this.oilLayer,
        });
      }
    }
    blob.wasInWater = inWater;
  }

  scrollMap(force: boolean): void {
    const blob = this.blob;
    const focusY = this.ending ? this.endFocusY : blob.state === BlobState.Grab && blob.cw ? blob.cw.y - VIEW_WHEEL : blob.y;
    const targetY = STAGE_HEIGHT * 0.5 - focusY;

    if (force) {
      this.mapY = targetY;
      this.svy = 0;
      return;
    }

    this.svy += (targetY - this.mapY) * 0.1;
    this.svy *= 0.6;
    this.mapY += this.svy;
  }

  spawnParticle(
    frame: Frame,
    x: number,
    y: number,
    vx: number,
    vy: number,
    options: {
      scale?: number;
      ttl?: number;
      weight?: number;
      frict?: number;
      vr?: number;
      vs?: number;
      sFrict?: number;
      fadeMode?: 'alpha' | 'scale' | 'none';
      rotation?: number;
      life?: number | null;
      layer?: Container;
      frames?: Frame[];
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
      view,
      vx,
      vy,
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

  spawnAnimation(frames: Frame[], x: number, y: number, scale: number, layer: Container = this.particleLayer): void {
    const view = makeSprite(frames[0]);
    view.position.set(x, y);
    view.scale.set(scale);
    layer.addChild(view);
    this.particles.push({
      view,
      vx: 0,
      vy: 0,
      weight: 0,
      frict: 1,
      life: frames.length,
      ttl: frames.length,
      scale,
      fadeMode: 'none',
      vr: 0,
      vs: 0,
      sFrict: 1,
      frames,
    });
  }

  spawnBubble(x: number, y: number, vy: number): void {
    const view = makeSprite(this.assets.bubble[0]);
    const scale = 0.3 + Math.random() * 0.5;
    view.position.set(x, y);
    view.scale.set(scale);
    view.blendMode = 'screen';
    this.waterParticleLayer.addChild(view);
    this.particles.push({
      view,
      vx: 0,
      vy,
      weight: -(0.15 + Math.random() * 0.5),
      frict: 0.98,
      life: null,
      ttl: 0,
      scale,
      fadeMode: 'none',
      vr: 0,
      vs: 0,
      sFrict: 1,
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
          particle.view.y = this.waterY;
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
          if (particle.view.y < this.waterY) {
            particle.view.y = this.waterY;
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

  endGame(): void {
    if (this.ending || this.ended) {
      return;
    }
    this.ending = true;
    this.endTimer = ENDGAME_DELAY;
    this.endFocusY = this.blob.y;
    this.gameOverText.text = '';
  }

  render(): void {
    this.world.y = this.mapY;

    for (const wheel of this.wheels) {
      const visible = this.isElementActive(wheel);
      wheel.group.visible = visible;
      wheel.shadow.visible = visible;
      wheel.group.position.set(wheel.x, wheel.y);
      wheel.spin.rotation = wheel.a;
      wheel.shadow.position.set(wheel.x, wheel.y + 6);
      wheel.shadow.rotation = wheel.a;
      setFrame(wheel.dust, this.assets.dust[(this.tick + wheel.dustOffset) % this.assets.dust.length]);
    }

    for (const pastille of this.pastilles) {
      pastille.view.visible = this.isElementActive(pastille);
    }

    const water = this.waterLayer.children[0] as Sprite | undefined;
    if (water) {
      water.y = this.waterY;
    }

    const blob = this.blob;
    if (blob.state !== BlobState.Dead) {
      blob.view.visible = true;
      blob.view.position.set(blob.x, blob.y);
      blob.view.rotation = blob.state === BlobState.Grab ? blob.angle : 0;

      if (blob.state === BlobState.Fly) {
        const a = Math.atan2(blob.vy, blob.vx);
        const frameIndex = clamp(Math.floor(60 + ((a + Math.PI) / (Math.PI * 2)) * 40) - 1, 0, this.assets.blob.length - 1);
        setFrame(blob.view, this.assets.blob[frameIndex]);
        blob.view.scale.x = 1;
      } else if (blob.state === BlobState.Wall) {
        const frameIndex = BLOB_COULE_FRAME_START + Math.min(blob.stateTick, BLOB_COULE_FRAME_COUNT - 1);
        setFrame(blob.view, this.assets.blob[clamp(frameIndex, 0, this.assets.blob.length - 1)]);
        blob.view.scale.x = blob.wallSide < 0 ? 1 : -1;
      } else {
        const frameIndex = BLOB_GRAB_FRAME_START + Math.min(blob.stateTick, BLOB_GRAB_FRAME_COUNT - 1);
        setFrame(blob.view, this.assets.blob[frameIndex]);
        blob.view.scale.x = 1;
      }
    } else if (blob.view.visible) {
      const frameIndex = BLOB_DEATH_FRAME_START + Math.min(blob.deathTick, BLOB_DEATH_FRAME_COUNT - 1);
      blob.view.position.set(blob.x, blob.y);
      blob.view.rotation = 0;
      blob.view.scale.x = 1;
      setFrame(blob.view, this.assets.blob[frameIndex]);
    }
  }
}

export async function mount(container: HTMLElement): Promise<GameInstance> {
  const app = new Application();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    }),
    loadAssets(),
  ]);
  container.appendChild(app.canvas);

  const game = new InterwheelGame(app, assets);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== 'Space') {
      return;
    }
    event.preventDefault();
    if (game.ended) {
      game.reset();
      return;
    }
    if (game.ending) {
      return;
    }
    if (!game.spaceHeld) {
      game.spacePressed = true;
    }
    game.spaceHeld = true;
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Space') {
      game.spaceHeld = false;
    }
  };
  const onPointerDown = () => {
    if (game.ended) {
      game.reset();
      return;
    }
    if (game.ending) {
      return;
    }
    game.pointerPressed = true;
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  app.canvas.addEventListener('pointerdown', onPointerDown);

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
      app.canvas.removeEventListener('pointerdown', onPointerDown);
      app.ticker.remove(tickerCallback);
      app.destroy(true, { children: true });
    },
  };
}
