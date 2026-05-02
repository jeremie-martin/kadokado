import { Application, Container, Graphics, Sprite, Text, Ticker } from 'pixi.js';
import type { GameInstance } from '../types';
import { type Frame, loadFrame, loadSeries, makeSprite } from '../_shared/frames';

const STAGE_WIDTH = 300;
const STAGE_HEIGHT = 320;
const FPS = 40;
const STEP_SECONDS = 1 / FPS;

const LVL_WIDTH = 9;
const LVL_HEIGHT = 11;
const BLK_WIDTH = 30;
const BLK_HEIGHT = 30;
const DELTA_X = 15;
const DELTA_Y = 0;
const BLK_SPEED = 3;
const BONUS_PROBAS = 100;
const BONUS_PROBAS_TBL = [50, 10, 1];
const BONUS_POINTS = [200, 500, 3000];

const enum Kind {
  Mask = 0,
  Block = 1,
  Blob = 2,
}

const enum HeroState {
  Falling = 0,
  Normal = 1,
  ClimbLeft = 2,
  ClimbRight = 3,
  EndClimbLeft = 4,
  EndClimbRight = 5,
  Death = 6,
}

type Cell = Kind | undefined;
type Pos = { x: number; y: number };

type GameAssets = {
  bg: Frame;
  blocks: Frame;
  hero: Frame[];
  block: Frame[];
  bonus: Frame[];
  announce: Frame[];
  fxVanish: Frame[];
  fxFeather: Frame[];
};

type FallingBlock = {
  x: number;
  y: number;
  dy: number;
  speed: number;
  time: number;
  blobFrame: number;
  view: Sprite;
  announce: Sprite | null;
};

type Bonus = {
  x: number;
  type: number;
  falling: boolean;
  yPx: number;
  view: Sprite;
};

type TimedFx = {
  view: Sprite;
  age: number;
  ttl: number;
};

type Hero = {
  view: Sprite;
  x: number;
  y: number;
  r: number;
  state: HeroState;
  sens: number;
  frame: number;
  flRun: boolean;
  deathTime: number;
  yScale: number;
};

function randomInt(max: number): number {
  if (max <= 1) {
    return 0;
  }
  return Math.floor(Math.random() * max);
}

function randomProbas(weights: number[]): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let draw = randomInt(total);
  for (let i = 0; i < weights.length; i += 1) {
    draw -= weights[i];
    if (draw < 0) {
      return i;
    }
  }
  return weights.length - 1;
}

function trunc(value: number): number {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

class PioupiouGame {
  readonly app: Application;
  readonly assets: GameAssets;
  readonly keys = new Set<string>();
  readonly world = new Container();
  readonly entityLayer = new Container();
  readonly fxLayer = new Container();
  readonly hudLayer = new Container();
  readonly landedMask = new Graphics();
  readonly meterText = new Text({
    text: '0M',
    style: {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 18,
      fontWeight: '700',
      fill: 0x3a2100,
      stroke: { color: 0xffffff, width: 3 },
    },
  });
  readonly scoreText = new Text({
    text: '0',
    style: {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 12,
      fontWeight: '700',
      fill: 0x3a2100,
      stroke: { color: 0xffffff, width: 2 },
    },
  });
  readonly gameOverText = new Text({
    text: '',
    style: {
      fontFamily: 'Arial, Helvetica, sans-serif',
      fontSize: 24,
      fontWeight: '700',
      fill: 0xffffff,
      stroke: { color: 0x6c2400, width: 4 },
    },
  });

  tbl: Cell[][] = [];
  bonuses: Bonus[] = [];
  fallings: FallingBlock[] = [];
  blobings: FallingBlock[] = [];
  fxs: TimedFx[] = [];
  hero: Hero;

  baseY = 0;
  targetY = 0;
  level = 0;
  blkSpeed = BLK_SPEED;
  spawn = 0;
  scrollY = 0;
  score = 0;
  tick = 0;
  data = { b: [0, 0, 0], l: 0 };
  ended = false;

  constructor(app: Application, assets: GameAssets) {
    this.app = app;
    this.assets = assets;
    this.app.stage.addChild(this.world, this.hudLayer);

    const stageBg = makeSprite(assets.bg);
    this.app.stage.addChildAt(stageBg, 0);

    const landedPattern = makeSprite(assets.blocks);
    landedPattern.x = DELTA_X;
    landedPattern.y = DELTA_Y;
    landedPattern.mask = this.landedMask;
    this.world.addChild(landedPattern, this.landedMask, this.entityLayer, this.fxLayer);

    this.meterText.anchor.set(1, 0);
    this.meterText.position.set(286, 298);
    this.scoreText.anchor.set(0, 0);
    this.scoreText.position.set(14, 302);
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(150, 150);
    this.hudLayer.addChild(this.scoreText, this.meterText, this.gameOverText);

    const heroView = makeSprite(assets.hero[0]);
    this.entityLayer.addChild(heroView);
    this.hero = {
      view: heroView,
      x: 150,
      y: 200,
      r: 0,
      state: HeroState.Normal,
      sens: 1,
      frame: 0,
      flRun: false,
      deathTime: 1,
      yScale: 100,
    };

    this.initLevel();
    this.updateMask();
    this.render();
  }

  initLevel(): void {
    this.baseY = LVL_HEIGHT - 2;
    this.targetY = this.baseY;
    this.tbl = Array.from({ length: LVL_WIDTH }, () => []);
    for (let x = 0; x < LVL_WIDTH; x += 1) {
      this.tbl[x][0] = Kind.Mask;
    }
  }

  cell(x: number, y: number): Cell {
    return this.tbl[x]?.[y];
  }

  setCell(x: number, y: number, kind: Cell): void {
    if (x < 0 || x >= LVL_WIDTH) {
      return;
    }
    this.tbl[x][y] = kind;
  }

  getPos(x: number, y: number): Pos {
    return {
      x: trunc((x - DELTA_X) / BLK_WIDTH),
      y: this.baseY - trunc((y - DELTA_Y) / BLK_HEIGHT),
    };
  }

  drawMask(x: number, y: number): void {
    const ey = BLK_HEIGHT * LVL_HEIGHT;
    this.landedMask
      .rect(DELTA_X + x * BLK_WIDTH, DELTA_Y + y * BLK_HEIGHT, BLK_WIDTH, ey - y * BLK_HEIGHT)
      .fill(0xffffff);
  }

  updateMask(): void {
    this.landedMask.clear();
    const sy = this.baseY - LVL_HEIGHT + 2;
    for (let x = 0; x < LVL_WIDTH; x += 1) {
      let y = sy;
      for (; y <= this.baseY; y += 1) {
        if (this.cell(x, y) !== Kind.Mask) {
          break;
        }
      }
      if (y > sy) {
        this.drawMask(x, this.baseY + 1 - y);
      }
    }
  }

  startFalling(): void {
    let x = 0;
    const y = this.baseY + 1;
    let ntrys = 20;
    do {
      x = randomInt(LVL_WIDTH);
      ntrys -= 1;
    } while (ntrys > 0 && (this.cell(x, y) !== undefined || this.cell(x, y - 1) !== undefined));

    if (ntrys === 0) {
      return;
    }

    let i = 0;
    while (this.cell(x, i + this.level) !== undefined) {
      i += 1;
    }
    if (randomInt(i * i) > 1) {
      this.startFalling();
      return;
    }

    this.setCell(x, y - 1, Kind.Block);
    const view = makeSprite(this.assets.block[0]);
    view.visible = false;
    this.entityLayer.addChild(view);

    const announce = makeSprite(this.assets.announce[0]);
    announce.x = DELTA_X + BLK_WIDTH * x;
    announce.y = 5;
    this.fxLayer.addChild(announce);

    this.fallings.push({
      x,
      y,
      dy: 0,
      speed: this.blkSpeed,
      time: 1,
      blobFrame: 1,
      view,
      announce,
    });
  }

  genBonus(): void {
    let x = 0;
    const y = this.baseY + 1;
    let ntrys = 20;
    do {
      x = randomInt(LVL_WIDTH);
      ntrys -= 1;
    } while (ntrys > 0 && (this.cell(x, y) !== undefined || this.cell(x, y - 1) !== undefined));

    if (ntrys === 0 || this.bonuses.some((bonus) => bonus.x === x)) {
      return;
    }

    const type = randomProbas(BONUS_PROBAS_TBL);
    const view = makeSprite(this.assets.bonus[type]);
    this.entityLayer.addChild(view);
    const bonus = { x, type, falling: true, yPx: 0, view };
    this.recallBonus(bonus, x, y);
    this.bonuses.push(bonus);
  }

  recallBonus(bonus: Bonus, x: number | null, y: number | null): void {
    if (x !== null) {
      bonus.view.x = x * BLK_WIDTH + DELTA_X;
      bonus.x = x;
    }
    if (y !== null) {
      bonus.yPx = (this.baseY - y) * BLK_HEIGHT + DELTA_Y;
      bonus.view.y = bonus.yPx;
    }
  }

  getFalling(x: number, y: number): FallingBlock | null {
    return this.fallings.find((block) => block.x === x && block.y === y) ?? null;
  }

  checkMove(): void {
    const y = this.baseY - (LVL_HEIGHT - 3);
    for (let x = 0; x < LVL_WIDTH; x += 1) {
      if (this.cell(x, y) !== Kind.Mask) {
        return;
      }
    }
    this.targetY = this.baseY + 1;
  }

  scrollUp(): void {
    this.baseY += 1;
    for (const block of this.fallings) {
      if (block.time > 0) {
        this.setCell(block.x, block.y - 1, undefined);
        block.y += 1;
        this.setCell(block.x, block.y - 1, Kind.Block);
      }
    }
    for (const bonus of this.bonuses) {
      bonus.yPx += BLK_HEIGHT;
      bonus.view.y = bonus.yPx;
    }
    this.hero.y += BLK_HEIGHT;
    if (this.hero.state !== HeroState.Death) {
      this.level += 1;
      this.data.l += 1;
      this.setMeter(this.level);
    }
  }

  destroyBlock(block: FallingBlock): void {
    this.setCell(block.x, block.y, Kind.Mask);
    this.blobings = this.blobings.filter((other) => other !== block);
    block.view.removeFromParent();
    this.updateMask();
    this.checkMove();
  }

  updateFalling(block: FallingBlock): boolean {
    if (block.time > 0) {
      block.time -= STEP_SECONDS;
      if (block.time <= 0) {
        block.view.visible = true;
        block.announce?.removeFromParent();
        block.announce = null;
      }
      return true;
    }

    block.dy += block.speed;
    if (block.dy > BLK_HEIGHT) {
      block.dy -= BLK_HEIGHT;
      block.y -= 1;
      this.setCell(block.x, block.y, undefined);
      if (this.cell(block.x, block.y - 1) !== undefined) {
        block.dy = 0;
        block.blobFrame = 1;
        this.setCell(block.x, block.y, Kind.Blob);
        this.blkSpeed += 0.1;
        this.blobings.push(block);
        return false;
      }
      this.setCell(block.x, block.y - 1, Kind.Block);
    }
    return true;
  }

  updateBonuses(): void {
    for (let i = 0; i < this.bonuses.length; i += 1) {
      const bonus = this.bonuses[i];
      const dx = bonus.view.x + 15 - this.hero.view.x;
      const dy = bonus.view.y + 15 - (this.hero.view.y - 15);
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (this.hero.state !== HeroState.Death && dist < 20) {
        this.addVanishFx(bonus.view.x + 16, bonus.view.y + 16, bonus.type);
        this.score += BONUS_POINTS[bonus.type] ?? 0;
        this.scoreText.text = String(this.score);
        this.data.b[bonus.type] += 1;
        bonus.view.removeFromParent();
        this.bonuses.splice(i, 1);
        i -= 1;
        continue;
      }

      if (bonus.falling) {
        bonus.yPx += 5;
        bonus.view.y = bonus.yPx;
      }

      const p = this.getPos(bonus.view.x, bonus.view.y);
      if (!bonus.falling && this.cell(p.x, p.y) !== undefined) {
        const block = this.getFalling(p.x, p.y + 1);
        if (block === null || block.dy > (BLK_HEIGHT * 95) / 100) {
          bonus.view.removeFromParent();
          this.bonuses.splice(i, 1);
          i -= 1;
        } else {
          bonus.view.scale.y = 1 - block.dy / BLK_HEIGHT;
          this.recallBonus(bonus, p.x, p.y);
          bonus.yPx += (1 - bonus.view.scale.y) * BLK_HEIGHT;
          bonus.view.y = bonus.yPx;
        }
      } else if (this.cell(p.x, p.y - 1) !== undefined && this.cell(p.x, p.y - 1) !== Kind.Block) {
        if (bonus.falling) {
          this.recallBonus(bonus, null, p.y);
          bonus.falling = false;
          bonus.view.scale.y = 1;
        }
      } else {
        bonus.falling = true;
      }
    }
  }

  addVanishFx(x: number, y: number, type: number): void {
    const view = makeSprite(this.assets.fxVanish[type]);
    view.x = x;
    view.y = y;
    this.fxLayer.addChild(view);
    this.fxs.push({ view, age: 0, ttl: 0.35 });
  }

  addDeathFx(x: number, y: number): void {
    const view = makeSprite(this.assets.fxFeather[0]);
    view.x = x;
    view.y = y;
    this.fxLayer.addChild(view);
    this.fxs.push({ view, age: 0, ttl: 1 });
  }

  setMeter(value: number): void {
    this.meterText.text = `${value}M`;
  }

  heroPos(): Pos {
    return this.getPos(this.hero.x, this.hero.y + BLK_HEIGHT - 1);
  }

  heroRecal(x: number | null, y: number | null): void {
    if (x !== null) {
      this.hero.x = x * BLK_WIDTH + DELTA_X;
    }
    if (y !== null) {
      this.hero.y = (this.baseY - y) * BLK_HEIGHT + DELTA_Y;
    }
  }

  climbFalling(p: Pos): void {
    if (this.cell(p.x, p.y) === undefined) {
      return;
    }
    let block = this.getFalling(p.x, p.y + 1);
    if (block === null) {
      block = this.getFalling(p.x, p.y);
    }
    if (block !== null) {
      const bx = block.x * BLK_WIDTH + DELTA_X + 15;
      const by = (this.baseY - block.y) * BLK_HEIGHT + block.dy + 15;
      if (Math.abs(bx - this.hero.view.x) > 18 || Math.abs(by - this.hero.view.y) > 28) {
        return;
      }
    }
    this.hero.r = 0;
    this.hero.state = HeroState.Falling;
  }

  death(): void {
    if (this.hero.state === HeroState.Death) {
      return;
    }
    this.hero.yScale = 100;
    this.hero.view.visible = false;
    this.hero.state = HeroState.Death;
    this.hero.deathTime = 1;
    this.addDeathFx(this.hero.view.x, this.hero.view.y);
  }

  updateHero(): void {
    const climbSpeed = 8;
    const fallSpeed = 20;
    let p = this.heroPos();

    let minX = p.x * BLK_WIDTH + DELTA_X + 10;
    let maxX = (p.x + 1) * BLK_WIDTH + DELTA_X - 10;

    if (p.x === 0) {
      minX += 9;
    } else if (p.x === LVL_WIDTH - 1) {
      maxX -= 9;
    }

    if (p.x > 0 && this.cell(p.x - 1, p.y) === undefined) {
      minX -= BLK_WIDTH;
    }
    if (p.x < LVL_WIDTH - 1 && this.cell(p.x + 1, p.y) === undefined) {
      maxX += BLK_WIDTH;
    }

    if (
      this.hero.state === HeroState.ClimbLeft ||
      this.hero.state === HeroState.ClimbRight ||
      this.hero.state === HeroState.EndClimbLeft ||
      this.hero.state === HeroState.EndClimbRight
    ) {
      this.climbFalling(p);
    }

    this.hero.flRun = false;
    switch (this.hero.state) {
      case HeroState.Normal:
        if (this.cell(p.x, p.y - 1) === undefined) {
          if (this.keys.has('ArrowLeft')) {
            this.hero.x -= 5;
          } else if (this.keys.has('ArrowRight')) {
            this.hero.x += 5;
          }
          this.hero.state = HeroState.Falling;
          break;
        }
        if (this.keys.has('ArrowLeft')) {
          this.hero.sens = -1;
          this.hero.flRun = true;
          this.hero.r = Math.max(-5, this.hero.r - 1);
          if (this.hero.x > minX) {
            this.hero.x -= 5;
            if (this.hero.x <= minX) {
              this.hero.x = minX;
            }
          } else if (p.x > 0 && this.hero.yScale >= 100) {
            this.hero.r += 20;
            if (this.hero.r >= 20) {
              this.hero.state = HeroState.ClimbLeft;
            }
          }
        } else if (this.keys.has('ArrowRight')) {
          this.hero.sens = 1;
          this.hero.flRun = true;
          this.hero.r = Math.min(this.hero.r + 1, 5);
          if (this.hero.x < maxX) {
            this.hero.x += 5;
            if (this.hero.x >= maxX) {
              this.hero.x = maxX;
            }
          } else if (p.x < LVL_WIDTH - 1 && this.hero.yScale >= 100) {
            this.hero.r -= 20;
            if (this.hero.r <= -20) {
              this.hero.state = HeroState.ClimbRight;
            }
          }
        } else {
          this.hero.r = 0;
        }
        break;

      case HeroState.Falling:
        for (let i = 0; i < 10; i += 1) {
          this.hero.y += fallSpeed / 10;
          p = this.heroPos();
          if (this.cell(p.x, p.y) !== undefined) {
            this.heroRecal(null, p.y + 1);
            this.hero.state = HeroState.Normal;
            break;
          }
        }
        break;

      case HeroState.ClimbLeft:
        this.hero.sens = -1;
        if (
          this.cell(p.x, p.y) === undefined &&
          this.cell(p.x, p.y + 1) === undefined &&
          this.keys.has('ArrowLeft')
        ) {
          this.hero.flRun = true;
          this.hero.r += 5;
          if (this.hero.r >= 80) {
            this.hero.r = 80;
          }
          this.hero.y -= climbSpeed;
        } else {
          this.hero.r = 0;
          this.hero.state = HeroState.Falling;
        }
        p = this.heroPos();
        if (this.cell(p.x - 1, p.y) === undefined) {
          this.heroRecal(null, p.y);
          this.hero.state = HeroState.EndClimbLeft;
        }
        break;

      case HeroState.EndClimbLeft:
        this.hero.r -= 10;
        if (this.hero.r <= 0) {
          this.hero.r = 0;
          this.hero.x -= 11;
          this.hero.state = HeroState.Normal;
        }
        break;

      case HeroState.ClimbRight:
        this.hero.sens = 1;
        if (
          this.cell(p.x, p.y) === undefined &&
          this.cell(p.x, p.y + 1) === undefined &&
          this.keys.has('ArrowRight')
        ) {
          this.hero.flRun = true;
          this.hero.r -= 5;
          if (this.hero.r <= -80) {
            this.hero.r = -80;
          }
          this.hero.y -= climbSpeed;
        } else {
          this.hero.r = 0;
          this.hero.state = HeroState.Falling;
        }
        if (this.cell(p.x + 1, p.y) === undefined) {
          this.heroRecal(null, p.y);
          this.hero.state = HeroState.EndClimbRight;
        }
        break;

      case HeroState.EndClimbRight:
        this.hero.r += 10;
        if (this.hero.r >= 0) {
          this.hero.r = 0;
          this.hero.x += 11;
          this.hero.state = HeroState.Normal;
        }
        break;

      case HeroState.Death:
        this.hero.deathTime -= STEP_SECONDS;
        if (this.hero.deathTime < 0 && !this.ended) {
          this.ended = true;
          this.gameOverText.text = 'GAME OVER';
        }
        break;
    }

    if (this.hero.flRun) {
      this.hero.frame = (this.hero.frame + 2) % 16;
    } else {
      this.hero.frame = 0;
    }

    p = this.heroPos();
    const kind = this.cell(p.x, p.y);
    if (kind !== undefined) {
      const block = this.getFalling(p.x, p.y + 1);
      if (block === null) {
        this.death();
      } else {
        this.hero.yScale = 100 - (block.dy * 100) / BLK_HEIGHT;
      }
    } else {
      this.hero.yScale += 10;
      if (this.hero.yScale >= 100) {
        this.hero.yScale = 100;
      }
    }

    const heroFrame = Math.max(1, Math.min(17, Math.round(this.hero.frame + 1)));
    this.hero.view.texture = this.assets.hero[heroFrame - 1].texture;
    this.hero.view.scale.x = this.hero.sens;
    this.hero.view.scale.y = this.hero.yScale / 100;
    switch (this.hero.state) {
      case HeroState.ClimbLeft:
      case HeroState.EndClimbLeft:
        this.hero.view.x = this.hero.x - 8;
        break;
      case HeroState.ClimbRight:
      case HeroState.EndClimbRight:
        this.hero.view.x = this.hero.x + 8;
        break;
      default:
        this.hero.view.x = this.hero.x;
        break;
    }
    this.hero.view.y = this.hero.y + BLK_HEIGHT;
    this.hero.view.rotation = (this.hero.r * Math.PI) / 180;
  }

  step(): void {
    this.tick += 1;
    this.spawn += 1 / (1 + this.fallings.length) / Math.max(2, 15 - Math.max((this.level - 10) / 2, 0));

    while (randomInt(10) < this.spawn * 10) {
      this.spawn -= 1;
      let n = randomProbas([10, 5, 2, 1]);
      while (n >= 0) {
        this.startFalling();
        n -= 1;
      }
    }

    if (randomInt(trunc((BONUS_PROBAS * this.bonuses.length) / 1)) === 0) {
      this.genBonus();
    }

    for (let i = 0; i < this.fallings.length; i += 1) {
      if (!this.updateFalling(this.fallings[i])) {
        this.fallings.splice(i, 1);
        i -= 1;
      }
    }

    for (let i = 0; i < this.blobings.length; i += 1) {
      const block = this.blobings[i];
      const frame = Math.max(1, Math.min(13, block.blobFrame));
      block.view.texture = this.assets.block[frame - 1].texture;
      block.blobFrame += 1;
      if (block.blobFrame > 13) {
        this.destroyBlock(block);
        i -= 1;
      }
    }

    this.updateBonuses();

    if (this.targetY !== this.baseY) {
      this.scrollY += 5;
      if (this.scrollY > BLK_HEIGHT) {
        this.scrollY = 0;
        this.scrollUp();
        this.updateMask();
        this.checkMove();
      }
    }

    this.updateHero();
    this.updateFx();
    this.render();
  }

  updateFx(): void {
    for (let i = 0; i < this.fxs.length; i += 1) {
      const fx = this.fxs[i];
      fx.age += STEP_SECONDS;
      const k = Math.max(0, 1 - fx.age / fx.ttl);
      fx.view.alpha = k;
      fx.view.scale.set(1 + (1 - k) * 0.8);
      if (fx.age >= fx.ttl) {
        fx.view.removeFromParent();
        this.fxs.splice(i, 1);
        i -= 1;
      }
    }
  }

  render(): void {
    this.world.y = this.scrollY;
    for (const block of [...this.fallings, ...this.blobings]) {
      block.view.x = block.x * BLK_WIDTH + DELTA_X;
      block.view.y = (this.baseY - block.y) * BLK_HEIGHT + DELTA_Y + block.dy;
      if (block.announce !== null) {
        const announceFrame = this.assets.announce[this.tick % this.assets.announce.length];
        block.announce.texture = announceFrame.texture;
      }
    }
  }
}

async function loadGameAssets(): Promise<GameAssets> {
  const base = '/assets/pioupiou';
  const [bg, blocks, hero, block, bonus, announce, fxVanish, fxFeather] = await Promise.all([
    loadFrame(`${base}/bg.png`, 0, 0),
    loadFrame(`${base}/block-map.png`, 1, 1),
    loadSeries(`${base}/hero`, 17, 12.6, 37.95),
    loadSeries(`${base}/block`, 13, 1.15, 1.75),
    loadSeries(`${base}/bonus`, 3, 0, 0),
    loadSeries(`${base}/announce`, 10, -1.95, -1.15),
    loadSeries(`${base}/fx-vanish`, 3, 16.5, 22.95),
    loadSeries(`${base}/fx-feather`, 3, 24.3, -16.05),
  ]);

  return {
    bg,
    blocks,
    hero,
    block,
    bonus,
    announce,
    fxVanish,
    fxFeather,
  };
}

export async function mount(container: HTMLElement): Promise<GameInstance> {
  const app = new Application();
  const [, assets] = await Promise.all([
    app.init({
      width: STAGE_WIDTH,
      height: STAGE_HEIGHT,
      background: '#ffffff',
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    }),
    loadGameAssets(),
  ]);
  container.appendChild(app.canvas);

  const game = new PioupiouGame(app, assets);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      game.keys.add(event.key);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      game.keys.delete(event.key);
    }
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  let acc = 0;
  const tickerCallback = (ticker: Ticker) => {
    acc += ticker.deltaMS / 1000;
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
      app.ticker.remove(tickerCallback);
      app.destroy(true, { children: true });
    },
  };
}
