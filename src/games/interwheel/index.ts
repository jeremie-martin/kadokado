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
const BLOB_COULE_FRAME_START = 19;
const BLOB_COULE_FRAME_COUNT = 25;
const BLOB_GRAB_FRAME_START = 44;
const BLOB_GRAB_FRAME_COUNT = 15;
const MINE_SPACE = 36;
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
};

type Wheel = {
  x: number;
  y: number;
  ray: number;
  speed: number;
  a: number;
  fr: number;
  mines: number[];
  destroyed: boolean;
  group: Container;
  spin: Container;
  shadow: Sprite;
  dust: Sprite;
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
  life: number;
  ttl: number;
  vr: number;
  frames?: Frame[];
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
  };
}

class InterwheelGame {
  readonly app: Application;
  readonly assets: InterwheelAssets;
  readonly world = new Container();
  readonly decorLayer = new Container();
  readonly shadowLayer = new Container();
  readonly wheelLayer = new Container();
  readonly pastilleLayer = new Container();
  readonly particleLayer = new Container();
  readonly blobLayer = new Container();
  readonly waterLayer = new Container();
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
      this.wheelLayer,
      this.pastilleLayer,
      this.particleLayer,
      this.blobLayer,
      this.waterLayer,
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
      view: blobView,
      deathTick: 0,
    };

    this.reset();
  }

  reset(): void {
    this.decorLayer.removeChildren();
    this.shadowLayer.removeChildren();
    this.wheelLayer.removeChildren();
    this.pastilleLayer.removeChildren();
    this.particleLayer.removeChildren();
    this.blobLayer.removeChildren();
    this.waterLayer.removeChildren();

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
          interWheel.x = m + Math.random() * (STAGE_WIDTH - 2 * m);
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
      destroyed: false,
      group: new Container(),
      spin: new Container(),
      shadow: new Sprite(),
      dust: new Sprite(),
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
    const base = makeSprite(this.assets.wheelBase[wheel.fr - 1]);
    wheel.spin.addChild(base);

    for (const mineAngle of wheel.mines) {
      const mine = makeSprite(this.assets.mine);
      mine.position.set(Math.cos(mineAngle) * 50, Math.sin(mineAngle) * 50);
      mine.scale.set(100 / (wheel.ray * 2));
      mine.rotation = mineAngle;
      wheel.spin.addChild(mine);
    }

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

  update(): void {
    this.tick += 1;

    if (this.ended) {
      this.updateParticles();
      this.render();
      return;
    }

    this.updateWheels();
    this.checkWheelCollision();
    this.updateBlob();
    this.updatePastilles();
    this.updateSparks();
    this.updateParticles();
    this.updateWaterAndScore();
    this.scrollMap(false);
    this.render();
  }

  updateWheels(): void {
    for (const wheel of this.wheels) {
      wheel.a += wheel.speed;
      if (wheel.destroyed) {
        wheel.speed *= 0.97;
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
        this.integrateBlobFlight();
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
      }
      this.integrateBlobFlight();
    }

    this.checkSideCollision();
  }

  integrateBlobFlight(): void {
    const blob = this.blob;
    blob.vy += BLOB_WEIGHT;
    blob.vx *= 0.98;
    blob.vy *= 0.98;

    if (blob.y - BLOB_RAY > this.waterY) {
      blob.vx *= 0.95;
      blob.vy *= blob.vy > 0 ? 0.9 : 0.95;
    }

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
      });
    }

    blob.vx = Math.cos(a) * BLOB_JUMP;
    blob.vy = Math.sin(a) * BLOB_JUMP;
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
      if (distance(blob, wheel) >= wheel.ray + BLOB_RAY) {
        continue;
      }

      const ba = angleTo(blob, wheel) + Math.PI;
      for (const mineAngle of wheel.mines) {
        const da = hMod(mineAngle + wheel.a - ba, Math.PI);
        if (Math.abs(da) * wheel.ray < MINE_SPACE) {
          const x = wheel.x + Math.cos(wheel.a + mineAngle) * wheel.ray;
          const y = wheel.y + Math.sin(wheel.a + mineAngle) * wheel.ray;
          wheel.destroyed = true;
          this.explodeBlob(x, y, ba);
          return;
        }
      }

      this.grabWheel(wheel);
      return;
    }
  }

  explodeBlob(x: number, y: number, ba: number): void {
    const blob = this.blob;
    blob.state = BlobState.Dead;
    blob.deathTick = 0;
    blob.stateTick = 0;
    blob.view.visible = false;

    this.spawnAnimation(this.assets.explosion, x, y, 0.5);
    for (let i = 0; i < 18; i += 1) {
      const dec = Math.random() * 2 - 1;
      const a = ba + dec * 0.8;
      const sp = (14 - Math.abs(dec) * 8) * (0.3 + Math.random() * 0.7);
      this.spawnParticle(this.assets.oil, blob.x, blob.y, Math.cos(a) * sp, Math.sin(a) * sp, {
        scale: 0.5 + (i / 18) * 1.5,
        ttl: 10 + Math.random() * 20,
        weight: 0.2 + (i / 18) * 0.2,
      });
    }
    for (let i = 0; i < 8; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.5 + Math.random() * 2;
      this.spawnParticle(this.assets.smoke[randomInt(this.assets.smoke.length)], x, y, Math.cos(a) * sp, Math.sin(a) * sp, {
        scale: 0.8 + Math.random() * 0.6,
        ttl: 12 + Math.random() * 20,
        weight: -(0.1 + Math.random() * 0.2),
        frict: 0.95,
      });
    }
    this.endGame();
  }

  updatePastilles(): void {
    const blob = this.blob;
    for (let i = 0; i < this.pastilles.length; i += 1) {
      const pastille = this.pastilles[i];
      if (distance(blob, pastille) < 70) {
        this.collectPastille(pastille);
        this.pastilles.splice(i, 1);
        i -= 1;
        continue;
      }

      const scale = 0.9 + Math.random() * 0.2 + Math.sin(this.tick * 0.25 + pastille.phase) * 0.02;
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

      if (Math.random() < 0.35) {
        this.spawnParticle(this.assets.star, spark.x, spark.y, spark.vx * 0.45, spark.vy * 0.45, {
          scale: 0.7 + Math.random() * 0.4,
          ttl: 10 + Math.random() * 10,
          weight: 0.1 + Math.random() * 0.1,
        });
      }

      if (distance(blob, spark) < BLOB_RAY + 8) {
        this.score += spark.score;
        this.spawnAnimation(this.assets.startExplo, spark.x, spark.y, 0.6);
        spark.view.removeFromParent();
        this.sparks.splice(i, 1);
        i -= 1;
      }
    }
  }

  updateWaterAndScore(): void {
    const blob = this.blob;
    this.waterBoost += WATER_SPEED_INC;
    this.waterY -= WATER_SPEED + this.waterBoost;

    if (blob.y - BLOB_RAY > this.waterY) {
      blob.wet += 0.015;
      if (Math.random() < blob.wet) {
        this.spawnParticle(this.assets.oil, blob.x, blob.y, blob.vx * 0.5, blob.vy * 0.5, {
          scale: 1 + blob.wet,
          ttl: 12 + Math.random() * 14,
          weight: 0.1,
        });
      }
    } else if (blob.wet > 0) {
      blob.wet = Math.max(0, blob.wet - 0.02);
    }

    if (blob.wet > 1) {
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

  scrollMap(force: boolean): void {
    const blob = this.blob;
    const focusY = blob.state === BlobState.Grab && blob.cw ? blob.cw.y - VIEW_WHEEL : blob.y;
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
    } = {},
  ): void {
    const view = makeSprite(frame);
    view.position.set(x, y);
    view.scale.set(options.scale ?? 1);
    this.particleLayer.addChild(view);
    this.particles.push({
      view,
      vx,
      vy,
      weight: options.weight ?? 0.2,
      frict: options.frict ?? 0.95,
      life: options.ttl ?? 20,
      ttl: options.ttl ?? 20,
      vr: options.vr ?? (Math.random() * 2 - 1) * 0.2,
    });
  }

  spawnAnimation(frames: Frame[], x: number, y: number, scale: number): void {
    const view = makeSprite(frames[0]);
    view.position.set(x, y);
    view.scale.set(scale);
    this.particleLayer.addChild(view);
    this.particles.push({
      view,
      vx: 0,
      vy: 0,
      weight: 0,
      frict: 1,
      life: frames.length,
      ttl: frames.length,
      vr: 0,
      frames,
    });
  }

  updateParticles(): void {
    for (let i = 0; i < this.particles.length; i += 1) {
      const particle = this.particles[i];
      particle.vy += particle.weight;
      particle.vx *= particle.frict;
      particle.vy *= particle.frict;
      particle.view.x += particle.vx;
      particle.view.y += particle.vy;
      particle.view.rotation += particle.vr;
      particle.life -= 1;
      particle.view.alpha = clamp(particle.life / particle.ttl, 0, 1);

      if (particle.frames) {
        const index = clamp(Math.floor((1 - particle.life / particle.ttl) * particle.frames.length), 0, particle.frames.length - 1);
        setFrame(particle.view, particle.frames[index]);
      }

      if (particle.life <= 0) {
        particle.view.removeFromParent();
        this.particles.splice(i, 1);
        i -= 1;
      }
    }
  }

  endGame(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.gameOverText.text = 'GAME OVER';
  }

  render(): void {
    this.world.y = this.mapY;

    for (const wheel of this.wheels) {
      const screenY = wheel.y + this.mapY;
      const visible = screenY > -140 && screenY < STAGE_HEIGHT + 140;
      wheel.group.visible = visible;
      wheel.shadow.visible = visible;
      wheel.group.position.set(wheel.x, wheel.y);
      wheel.spin.rotation = wheel.a;
      wheel.shadow.position.set(wheel.x, wheel.y + 6);
      wheel.shadow.rotation = wheel.a;
      setFrame(wheel.dust, this.assets.dust[(this.tick + wheel.dustOffset) % this.assets.dust.length]);
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
