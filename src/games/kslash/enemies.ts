// Enemy hierarchy — port of Ent.mt, Monster.mt, Runner.mt, Soldier.mt,
// Tanker.mt, Flyer.mt.
//
// Hierarchy: Ent (base) -> Monster -> Runner -> Soldier
//                                            -> Tanker
//                          Monster -> Flyer
// Hero also extends Ent — see hero.ts.

import { ColorMatrixFilter, Container, Sprite } from 'pixi.js';
import { setFrame } from '../_shared/frames';
import {
  C0,
  C10,
  C100,
  C200,
  C30,
  C300,
  C50,
  HERO_FRAMES,
  OPT_FLAMES,
  SIZE,
  ST_CLIMB,
  ST_DEATH,
  ST_FLY,
  ST_NORMAL,
  ST_SHOOT,
  TANKER_FRAMES,
  TMOD,
  XMAX,
  YMAX,
} from './constants';
import type { GameContext } from './game-context';
import type { Star } from './projectiles';
import { Kunai } from './projectiles';

// -------------------------------------------------------------------------
// Ent base class — shared with Hero (in hero.ts via class extension).
// -------------------------------------------------------------------------

export type AnimName = string;

export abstract class Ent {
  view: Container;
  game: GameContext;

  // Cell + sub-pixel position.
  x = 0;
  y = 0;
  cx = 0;
  cy = 0;
  dx = 0;
  dy = 0;

  // Velocity / spin.
  vx = 0;
  vy = 0;
  vr: number | null = null;

  // Tunables.
  weight = 1;
  friction: number | null = 0.95;

  // State.
  step = ST_FLY;
  sens: 1 | -1 = 1;
  flGround = false;
  flCol = true;
  flFreezeAnim = false;

  // Animation hint — applied in update() (see playAnim).
  nextAnim: AnimName | null = null;

  constructor(view: Container, game: GameContext) {
    this.view = view;
    this.game = game;
  }

  protected setRootScaleX(s: number): void {
    this.view.scale.x = s * Math.abs(this.view.scale.x || 1);
  }

  setSens(n: 1 | -1): void {
    this.sens = n;
    // The original sets _xscale to ±100. We only flip the X sign.
    const cur = Math.abs(this.view.scale.x) || 1;
    this.view.scale.x = n * cur;
  }

  update(): void {
    if (!this.flGround) {
      this.vy += this.weight * TMOD;
    }
    if (this.friction !== null) {
      const frict = Math.pow(this.friction, TMOD);
      this.vx *= frict;
      this.vy *= frict;
    }
    this.dx += this.vx * TMOD;
    this.dy += this.vy * TMOD;

    if (this.vr !== null) {
      this.vr *= 0.95;
      // Source `vr` is degrees/frame (Flash `_rotation` is in degrees).
      // Pixi rotation is radians, so convert here. Without this conversion
      // the hero spins ~57x too fast during scroll-power-up `tronc` bounce
      // (vr=±24 deg/frame would otherwise be ±24 rad/frame ≈ ±1376 deg/frame).
      this.view.rotation += this.vr * TMOD * (Math.PI / 180);
    }

    this.recal();

    this.view.x = (this.x + 0.25 + this.cx * 0.5) * SIZE + this.dx;
    this.view.y = (this.y + 0.25 + this.cy * 0.5) * SIZE + this.dy;

    if (this.nextAnim !== null && !this.flFreezeAnim) {
      this.playAnim(this.nextAnim);
      this.nextAnim = null;
    }
  }

  // Subclasses override to map anim names to specific frame indices.
  protected playAnim(_name: AnimName): void {
    // default no-op
  }

  recal(): void {
    const m = SIZE * 0.25;
    let adx = Math.abs(this.dx);
    let ady = Math.abs(this.dy);

    while (adx > m || ady > m) {
      if (adx > ady) {
        // Horizontal.
        if (this.dx > 0) {
          if (this.cx === 0) {
            if (this.x < XMAX - 1) {
              this.cx = 1;
              this.dx -= 2 * m;
              this.crossSquare();
            } else {
              this.bang();
              this.dx = m;
            }
          } else {
            this.leaveSquare();
            this.cx = 0;
            this.dx -= 2 * m;
            this.x += 1;
            this.enterSquare();
          }
        } else {
          if (this.cx === 1) {
            if (this.x > 0) {
              this.cx = 0;
              this.dx += 2 * m;
              this.crossSquare();
            } else {
              this.bang();
              this.dx = -m;
            }
          } else {
            this.leaveSquare();
            this.cx = 1;
            this.dx += 2 * m;
            this.x -= 1;
            this.enterSquare();
          }
        }
      } else {
        // Vertical.
        if (this.dy > 0) {
          if (this.cy === 0) {
            if (!this.checkGround()) {
              this.cy = 1;
              this.dy -= 2 * m;
            } else {
              this.land();
              this.dy = m;
            }
          } else {
            this.leaveSquare();
            this.cy = 0;
            this.dy -= 2 * m;
            this.y += 1;
            this.enterSquare();
          }
        } else {
          if (this.cy === 1) {
            this.cy = 0;
            this.dy += 2 * m;
          } else {
            this.leaveSquare();
            this.cy = 1;
            this.dy += 2 * m;
            this.y -= 1;
            this.enterSquare();
          }
        }
      }
      adx = Math.abs(this.dx);
      ady = Math.abs(this.dy);
    }
  }

  protected crossSquare(): void {
    if (this.flGround) {
      this.checkFall();
    }
  }

  protected checkFall(): void {
    if (!this.checkGround()) {
      this.fall();
    }
  }

  fall(): void {
    this.flGround = false;
  }

  land(): void {
    this.flGround = true;
    this.vy = 0;
  }

  protected bang(): void {
    this.vx = 0;
  }

  checkGround(): boolean {
    if (!this.flCol) {
      return false;
    }
    for (let i = 0; i < 2; i += 1) {
      const s = this.cx * 2 - 1;
      const tx = this.x + s * i;
      if (tx < 0 || tx >= XMAX || this.y + 1 >= YMAX) {
        continue;
      }
      if (!this.game.checkFree(tx, this.y + 1)) {
        return true;
      }
    }
    return false;
  }

  enterSquare(): void {
    // base no-op
  }
  leaveSquare(): void {
    // base no-op
  }

  getAng(o: { view: Container }): number {
    const dx = o.view.x - this.view.x;
    const dy = o.view.y - this.view.y;
    return Math.atan2(dy, dx);
  }
  getDist(o: { view: Container }): number {
    const dx = o.view.x - this.view.x;
    const dy = o.view.y - this.view.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
}

// -------------------------------------------------------------------------
// Monster (base for all enemy classes).
// -------------------------------------------------------------------------

export type DropEntry = { w: number; id: number };

export abstract class Monster extends Ent {
  hp = 10;
  score: number = C0;

  // Per-subclass tunables.
  stClimb = 21;
  stClimbWait = 26;
  stDrop: DropEntry[] = [
    { w: 100, id: 1 },
    { w: 20, id: 2 },
    { w: 1, id: 3 },
  ];
  stLevel = 1;
  stTossClimb: number | null = null;
  stTossSmart = 10;
  stTossShoot: number | null = null;

  waitTimer = 0;
  flash: number | null = null;
  // White-flash filter — lazily allocated when `flash` becomes non-null.
  // Pixi v8 `tint` is multiplicative (only darkens), so to replicate Flash's
  // `Cs.setPercentColor(view, prc, 0xFFFFFF)` (linear lerp toward white) we
  // attach a ColorMatrixFilter whose diagonal is (1-p) and channel offset is p,
  // i.e. out = in*(1-p) + 1*p — exact match to setPercentColor's formula.
  private flashFilter: ColorMatrixFilter | null = null;

  flClimbAnim = false;
  flSpike = false;

  // Source's death() does NOT remove the MovieClip from stage; the sprite
  // sits in place playing the "death" animation (memory leak in source).
  // We defer removal so the death animation can play, matching feel.
  // Default = mcMonster's 29-frame `death` label; Tanker/Flyer override.
  protected deathAnimFrames = 29;

  // Animation frame map (subclass-specific). For most enemies we map to the
  // monster sprite series; Tanker and Flyer use their own asset folder.
  protected animFrames: { name: AnimName; start: number; count: number }[] = [];
  protected currentFrame = 0;
  protected animElapsed = 0;
  protected currentAnim: AnimName | null = null;
  protected animLoop = true;

  constructor(view: Container, game: GameContext) {
    super(view, game);
    game.mList.push(this);
    this.initStep(ST_FLY);
  }

  initStep(n: number): void {
    this.step = n;
    switch (n) {
      case ST_NORMAL:
        break;
      case ST_FLY:
        this.flGround = false;
        break;
      case ST_CLIMB:
        this.flClimbAnim = false;
        this.waitTimer = this.stClimbWait;
        this.vx = 0;
        break;
      case ST_SHOOT:
        // stShootWait is set by Soldier (default 36).
        this.waitTimer = (this as unknown as { stShootWait?: number }).stShootWait ?? 36;
        this.vx = 0;
        break;
    }
  }

  override update(): void {
    super.update();
    switch (this.step) {
      case ST_CLIMB:
        this.waitTimer -= TMOD;
        if (this.waitTimer < 15) {
          if (!this.flClimbAnim) {
            this.flClimbAnim = true;
            this.nextAnim = 'climbEnd';
          }
          if (this.waitTimer < 0) {
            this.climb();
          }
        }
        break;
      case ST_SHOOT:
        this.waitTimer -= TMOD;
        if (this.waitTimer < 0) {
          this.shoot();
          this.nextAnim = 'shoot';
        }
        break;
    }
    this.updateFlash();
    this.advanceAnim();
  }

  protected advanceAnim(): void {
    if (this.flFreezeAnim) {
      return;
    }
    const def = this.animFrames.find((a) => a.name === this.currentAnim);
    if (!def) {
      return;
    }
    this.animElapsed += TMOD;
    // Render a frame every step (~24 fps anim playback would feel natural;
    // we keep it 1:1 with logic step for simplicity, matches MovieClip).
    if (this.animElapsed >= 1) {
      this.animElapsed -= 1;
      this.currentFrame += 1;
      if (this.currentFrame >= def.count) {
        this.currentFrame = this.animLoop ? 0 : def.count - 1;
      }
      this.applyFrame(def.start + this.currentFrame);
    }
  }

  protected abstract applyFrame(absoluteFrame: number): void;

  protected override playAnim(name: AnimName): void {
    const def = this.animFrames.find((a) => a.name === name);
    if (!def) {
      return;
    }
    this.currentAnim = name;
    this.currentFrame = 0;
    // Source's Flash MovieClip holds the gotoAndPlay target frame for one
    // tick BEFORE advancing. The port's advanceAnim() runs in the same tick
    // as playAnim() (death runs once via the corpse tick, climbEnd/shoot via
    // nextAnim consumption in the next Ent.update), so without this offset
    // the first frame of every animation is overwritten before render — the
    // death pose, climbEnd peek, and shoot wind-up are never visible.
    // Initializing animElapsed to `-TMOD` makes the in-tick advanceAnim land
    // at 0 (< 1) so frame 0 holds for one tick, matching Flash's
    // gotoAndPlay → enterFrame cadence.
    this.animElapsed = -TMOD;
    this.animLoop = !(name === 'death' || name === 'climbEnd' || name === 'land' || name === 'shoot');
    this.applyFrame(def.start);
  }

  climb(): void {
    this.vy -= this.stClimb;
    this.initStep(ST_FLY);
  }

  shoot(): void {
    this.initStep(ST_NORMAL);
  }

  updateFlash(): void {
    // Source: `Cs.setPercentColor(root, prc, 0xFFFFFF)` — linear lerp of each
    // RGB channel toward 0xFF by prc/100. Implemented here with a ColorMatrixFilter
    // (Pixi v8 multiplicative tint cannot brighten toward white).
    if (this.flash !== null) {
      this.flash *= 0.7;
      if (this.flash < 1) {
        this.flash = null;
        this.clearFlashFilter();
      } else {
        this.applyFlashFilter(this.flash / 100);
      }
    }
    (this.view as Container).alpha = 1;
  }

  private applyFlashFilter(p: number): void {
    // Clamp p to [0, 1]; matrix: diagonal = 1-p (channel scale), 5th column = p
    // (normalized 0..1 offset added after the matrix multiply, per Pixi v8).
    const k = Math.max(0, Math.min(1, p));
    const d = 1 - k;
    if (this.flashFilter === null) {
      this.flashFilter = new ColorMatrixFilter();
      this.view.filters = [this.flashFilter];
    }
    this.flashFilter.matrix = [
      d, 0, 0, 0, k,
      0, d, 0, 0, k,
      0, 0, d, 0, k,
      0, 0, 0, 1, 0,
    ];
  }

  private clearFlashFilter(): void {
    if (this.flashFilter !== null) {
      this.view.filters = [];
      this.flashFilter.destroy();
      this.flashFilter = null;
    }
  }

  // Public cleanup for game destroy() — releases filter regardless of state.
  releaseFilters(): void {
    this.clearFlashFilter();
  }

  cut(n: number): void {
    this.game.addScore(C50);
    this.harm(n);
    this.throwBack(1.57 - 1.57 * this.game.hero.sens, 10);
  }

  hit(shot: Star): void {
    this.game.addScore(C10);
    this.harm(shot.damage);
    this.throwBack(Math.atan2(shot.vy, shot.vx), 2);
  }

  harm(n: number): void {
    this.hp -= n;
    if (this.hp <= 0) {
      this.death();
    } else {
      this.flash = 100;
    }
  }

  death(): void {
    // Clear any in-flight white-flash filter — the death animation sprite plays
    // unfiltered (matches source: `Cs.setPercentColor(root, 0, 0xFFFFFF)` is
    // never called on death, the flash just stops decaying when hp<0).
    this.clearFlashFilter();
    this.game.addScore(this.score);
    this.game.spawnBonus(this.view.x, this.view.y, this.getDrop());
    this.game.monsterLevel -= this.stLevel;
    this.leaveSquare();
    const i = this.game.mList.indexOf(this);
    if (i >= 0) {
      this.game.mList.splice(i, 1);
    }
    // Source leaves the sprite on screen so the death animation plays out
    // (a memory leak in the original). Defer removal via the Game's corpse
    // list, and pass a tick that keeps advancing the death anim — once
    // removed from mList, update() no longer runs, so without the tick the
    // sprite would freeze on the first death frame.
    this.game.scheduleCorpseRemoval(this.view, this.deathAnimFrames, () => this.advanceAnim());
  }

  getDrop(): number {
    let sum = 0;
    for (const e of this.stDrop) sum += e.w;
    let rnd = Math.random() * sum;
    for (const e of this.stDrop) {
      rnd -= e.w;
      if (rnd < 0) return e.id;
    }
    return 0;
  }

  throwBack(a: number, p: number): void {
    const vitx = Math.cos(a) * p;
    let vity = Math.sin(a) * p - 3;
    if (this.flGround) {
      vity = Math.min(0, vity);
      if (vity < 0) this.initStep(ST_FLY);
    }
    this.vx += vitx;
    this.vy += vity;
  }

  tryJumpFront(): void {
    let dist = 0;
    while (dist < 6) {
      dist += 1;
      const tx = this.x + this.sens * (dist + 1);
      if (tx < 0 || tx >= XMAX || this.y + 1 >= YMAX) {
        break;
      }
      if (!this.game.checkFree(tx, this.y + 1)) break;
    }
    if (dist < 6) {
      this.jumpFront(dist);
    }
  }

  jumpFront(dist: number): void {
    this.initStep(ST_FLY);
    this.vy = -10;
    this.vx = Math.pow(dist * 24, 0.5) * this.sens;
  }

  override land(): void {
    super.land();
    this.initStep(ST_NORMAL);
  }

  protected override crossSquare(): void {
    super.crossSquare();
    const flSmart = this.isSmart();
    if (this.step === ST_NORMAL && this.stTossClimb !== null && Math.random() * this.stTossClimb < 1) {
      let flDoIt = true;
      if (this.game.hero.y > this.y - 3 && flSmart) flDoIt = false;
      if (flDoIt) {
        for (let i = 2; i < 5; i += 1) {
          if (this.y - i < 0) break;
          if (!this.game.checkFree(this.x, this.y - i)) {
            this.initStep(ST_CLIMB);
            break;
          }
        }
      }
    }
  }

  override fall(): void {
    this.initStep(ST_FLY);
  }

  protected override bang(): void {
    super.bang();
    this.setSens((-this.sens) as 1 | -1);
  }

  override enterSquare(): void {
    if (this.x >= 0 && this.x < XMAX && this.y >= 0 && this.y < YMAX) {
      this.game.grid[this.x][this.y].list.push(this);
    }
  }
  override leaveSquare(): void {
    if (this.x >= 0 && this.x < XMAX && this.y >= 0 && this.y < YMAX) {
      const list = this.game.grid[this.x][this.y].list;
      const i = list.indexOf(this);
      if (i >= 0) list.splice(i, 1);
    }
  }

  chooseWay(): void {
    let s: 1 | -1 = (Math.random() < 0.5 ? -1 : 1) as 1 | -1;
    if (this.isSmart()) s = (this.game.hero.x < this.x ? -1 : 1) as 1 | -1;
    this.setSens(s);
  }

  isSmart(): boolean {
    return Math.random() * this.stTossSmart < 1;
  }
}

// -------------------------------------------------------------------------
// Runner (extends Monster) — base for ground enemies.
// -------------------------------------------------------------------------

export class Runner extends Monster {
  flFlyUp = false;
  flStraight = false;
  flWalk = true;
  speed = 2;

  constructor(view: Container, game: GameContext) {
    super(view, game);
    this.setSens((Math.random() < 0.5 ? -1 : 1) as 1 | -1);
    this.flWalk = true;
    this.stClimbWait = 26;
    // animFrames: monsters use the 161-frame mcMonster sheet. We carve
    // simple ranges across the sheet — labels in the SWF are not source
    // accessible, so this is an approximation.
    this.animFrames = buildMonsterAnims();
    this.initStep(ST_FLY);
    this.playAnim('fall');
  }

  override initStep(n: number): void {
    super.initStep(n);
    switch (n) {
      case ST_NORMAL:
        this.nextAnim = this.flWalk ? 'walk_loop' : 'walk';
        this.flWalk = true;
        break;
      case ST_FLY:
        this.flGround = false;
        break;
      case ST_CLIMB:
        this.nextAnim = 'climb';
        break;
      case ST_SHOOT:
        this.nextAnim = 'shootWait';
        break;
    }
  }

  override update(): void {
    super.update();
    switch (this.step) {
      case ST_NORMAL: {
        const dvx = this.sens * this.speed - this.vx;
        const lim = 0.5;
        this.vx += Math.min(Math.max(-lim, dvx * 0.2), lim) * TMOD;
        break;
      }
      case ST_FLY: {
        if (this.flFlyUp && this.vy > 0) {
          this.flFlyUp = false;
          if (this.flStraight) {
            this.nextAnim = 'fly_straight_down';
            this.flStraight = false;
          } else {
            this.nextAnim = 'fly_down';
          }
        }
        break;
      }
    }
  }

  override jumpFront(dist: number): void {
    super.jumpFront(dist);
    this.flStraight = true;
    this.flFlyUp = true;
    this.nextAnim = 'fly_straight_up';
  }

  override throwBack(a: number, p: number): void {
    if (this.flGround && this.hp > 0) {
      this.nextAnim = 'walk_loop';
    }
    super.throwBack(a, p);
  }

  override climb(): void {
    super.climb();
    this.nextAnim = 'fly_up';
    this.flFlyUp = true;
    this.flWalk = false;
  }

  override land(): void {
    super.land();
    this.chooseWay();
  }

  override death(): void {
    this.playAnim('death');
    super.death();
  }

  protected applyFrame(absoluteFrame: number): void {
    const sheet = this.game.assets.monster;
    const idx = Math.max(0, Math.min(absoluteFrame, sheet.length - 1));
    const child = this.view.children[0];
    if (child instanceof Sprite) {
      setFrame(child, sheet[idx]);
    }
  }
}

// -------------------------------------------------------------------------
// Soldier (extends Runner).
// -------------------------------------------------------------------------

export class Soldier extends Runner {
  stMaxShot = 1;
  stShootWait = 36;

  constructor(view: Container, game: GameContext) {
    super(view, game);
    this.stShootWait = 36;
    this.stDrop.push({ w: 1, id: 10 });
  }

  setLevel(n: number): void {
    this.stLevel = n;
    switch (n) {
      case 1:
        this.hp = 10;
        this.score = C30;
        this.stClimbWait = 32;
        this.stTossClimb = 12;
        this.stTossSmart = 4;
        this.stTossShoot = null;
        this.speed = 2;
        this.flSpike = false;
        this.stDrop.push({ w: 70, id: 4 });
        break;
      case 2:
        this.hp = 40;
        this.score = C100;
        this.stTossClimb = 12;
        this.stTossSmart = 3;
        this.stTossShoot = 10;
        this.stMaxShot = 3;
        this.speed = 3;
        this.flSpike = false;
        this.stDrop.push({ w: 50, id: 4 });
        this.stDrop.push({ w: 30, id: 5 });
        this.stDrop.push({ w: 20, id: 8 });
        this.stDrop.push({ w: 1, id: 9 });
        break;
      case 3:
        this.hp = 60;
        this.score = C200;
        this.stTossClimb = 6;
        this.stTossSmart = 1;
        this.stTossShoot = 4;
        this.stMaxShot = 1;
        this.stShootWait = 12;
        this.speed = 5;
        this.flSpike = true;
        this.stDrop.push({ w: 40, id: 5 });
        this.stDrop.push({ w: 20, id: 6 });
        this.stDrop.push({ w: 20, id: 7 });
        this.stDrop.push({ w: 1, id: 9 });
        break;
    }
  }

  override update(): void {
    super.update();
    if (this.step === ST_SHOOT) {
      const dx = this.game.hero.x - this.x;
      if (dx * this.sens < 0) {
        this.setSens((-this.sens) as 1 | -1);
      }
    }
  }

  protected override crossSquare(): void {
    super.crossSquare();

    if (this.step === ST_NORMAL) {
      const aheadX = this.x + this.sens;
      if (aheadX >= 0 && aheadX < XMAX && this.y + 1 < YMAX && this.game.checkFree(aheadX, this.y + 1)) {
        if (this.isSmart()) {
          if (this.game.hero.y > this.y + 3) {
            // descend toward hero — no immediate action
          } else {
            // Source: `if( int(dif/Math.abs(dif))==sens ) tryJumpFront() else
            // setSens(-sens)`. When dif==0, source's `0/0 = NaN`, `int(NaN)=0`,
            // and `0 == sens` is always false (sens is ±1) — so source falls
            // through to setSens(-sens). `Math.sign(0)===0` reproduces that
            // exactly: `0 === sens` is false, so the else-branch fires.
            const dif = this.game.hero.x - this.x;
            if (Math.sign(dif) === this.sens) {
              this.tryJumpFront();
            } else {
              this.setSens((-this.sens) as 1 | -1);
            }
          }
        } else {
          const rnd = Math.floor(Math.random() * 7);
          if (rnd === 0) {
            // do nothing
          } else if (rnd === 1 || rnd === 2) {
            this.tryJumpFront();
          } else {
            this.setSens((-this.sens) as 1 | -1);
          }
        }
      } else {
        if (this.stTossShoot !== null && Math.floor(Math.random() * this.stTossShoot) === 0) {
          const d = this.getDist(this.game.hero);
          if (d < 180) {
            this.initStep(ST_SHOOT);
          }
        }
      }
    }
  }

  override shoot(): void {
    const a = this.getAng(this.game.hero);
    const speed = 3;
    const max = this.stMaxShot;
    for (let i = 0; i < max; i += 1) {
      const da = max === 1 ? 0 : (i / (max - 1) - 0.5) * 0.4;
      const sp = new Sprite(this.game.assets.kunai.texture);
      sp.anchor.set(0.5);
      sp.x = this.view.x;
      sp.y = this.view.y;
      sp.rotation = a + da;
      this.game.shootLayer.addChild(sp);
      const k = new Kunai(sp, this.game);
      k.x = this.x;
      k.y = this.y;
      k.dx = this.dx;
      k.dy = this.dy;
      k.vx = Math.cos(a + da) * speed;
      k.vy = Math.sin(a + da) * speed;
    }
    super.shoot();
  }
}

// -------------------------------------------------------------------------
// Tanker (extends Runner).
// -------------------------------------------------------------------------

export class Tanker extends Runner {
  constructor(view: Container, game: GameContext) {
    super(view, game);
    this.stLevel = 3;
    this.hp = 50;
    this.score = C100;
    this.stClimbWait = 12;
    this.stTossClimb = 6;
    this.stTossSmart = 2;
    this.stClimb = 36;
    this.speed = 4;
    this.stDrop.push({ w: 40, id: 1 });
    this.stDrop.push({ w: 10, id: 2 });
    this.stDrop.push({ w: 30, id: 5 });
    this.animFrames = buildTankerAnims();
    this.deathAnimFrames = 20; // mcTanker `death` label = frames 70..89.
  }

  override hit(shot: Star): void {
    if (this.step === ST_NORMAL && shot.vx * this.sens < 0) {
      // Reflect star.
      const p = this.game.newPart('mcNinjaShot');
      p.view.x = shot.view.x;
      p.view.y = shot.view.y;
      const flames = this.game.optList[OPT_FLAMES];
      const ninjaIdx = flames ? 1 : 0;
      const sheet = this.game.assets.ninjaShot;
      if (p.view instanceof Sprite) {
        setFrame(p.view, sheet[ninjaIdx]);
      }
      p.vx = -shot.vx * 0.75;
      p.vy = shot.vy - 3;
      p.t = 20 + Math.random() * 10;
      p.weight = 0.4;
      shot.kill();
      return;
    }
    super.hit(shot);
  }

  override cut(n: number): void {
    if ((this.game.hero.x - this.x) * this.sens < 0) {
      super.cut(n);
    } else {
      this.throwBack(1.57 - 1.57 * this.game.hero.sens, 12);
    }
  }

  override throwBack(a: number, p: number): void {
    if (this.flGround && this.hp > 0) {
      this.nextAnim = 'walk_loop';
    }
    super.throwBack(a, p);
  }

  protected override crossSquare(): void {
    // Note: skip Runner.crossSquare's edge-jump logic because Tanker has
    // its own simpler edge behavior. But preserve climb logic from Monster.
    super.crossSquare();

    const aheadX = this.x + this.sens;
    if (aheadX >= 0 && aheadX < XMAX && this.y + 1 < YMAX && this.game.checkFree(aheadX, this.y + 1)) {
      if (this.isSmart()) {
        // Source: `int(dif/Math.abs(dif))!=sens` — when dif==0, NaN→int→0,
        // `0 != sens` is true, so source reverses. `Math.sign(0)===0` matches:
        // `0 !== sens` is true so the reversal fires.
        const dif = this.game.hero.x - this.x;
        if (this.game.hero.y <= this.y + 3 && Math.sign(dif) !== this.sens) {
          this.setSens((-this.sens) as 1 | -1);
        }
      } else {
        if (Math.random() < 0.7) this.setSens((-this.sens) as 1 | -1);
      }
    }
  }

  protected override applyFrame(absoluteFrame: number): void {
    const sheet = this.game.assets.tanker;
    const idx = Math.max(0, Math.min(absoluteFrame, sheet.length - 1));
    const child = this.view.children[0];
    if (child instanceof Sprite) {
      setFrame(child, sheet[idx]);
    }
  }
}

// -------------------------------------------------------------------------
// Flyer (extends Monster).
// -------------------------------------------------------------------------

export class Flyer extends Monster {
  speed = 0;
  trg: { x: number; y: number } = { x: 0, y: 0 };
  flyerWaitTimer = 0;
  flyerWaitTimerMax = 100;

  constructor(view: Container, game: GameContext) {
    super(view, game);
    this.stLevel = 2;
    this.score = C30;
    this.setSens((Math.random() < 0.5 ? -1 : 1) as 1 | -1);
    this.flCol = false;
    this.stDrop.push({ w: 150, id: 4 });
    this.stDrop.push({ w: 50, id: 8 });
    this.weight = 0;
    this.hp = 30;
    this.animFrames = buildFlyerAnims();
    this.deathAnimFrames = 20; // mcFlyer `death` label = frames 31..50.
    this.initStep(ST_NORMAL);
    // mcFlyer's frame 1 is labeled `fly` — Flash plays it from boot. The
    // port has no implicit start-frame anim, so kick it explicitly.
    this.playAnim('fly');
  }

  override update(): void {
    super.update();
    if (this.step === ST_NORMAL) {
      this.flyerWaitTimer -= TMOD;
      if (this.flyerWaitTimer < 0) {
        this.chooseTrg();
        this.flyerWaitTimer = this.flyerWaitTimerMax + Math.random() * 20;
        this.flyerWaitTimerMax = Math.max(0, this.flyerWaitTimerMax - 8);
      }
      this.fly();
      const dx = this.game.hero.view.x - this.view.x;
      if (dx * this.sens < 0) this.setSens((-this.sens) as 1 | -1);
    }
  }

  fly(): void {
    const dx = this.trg.x - this.view.x;
    const dy = this.trg.y - this.view.y;
    const a = Math.atan2(dy, dx);
    const dist = Math.sqrt(dx * dx + dy * dy);
    const c = 0.1;
    const lim = 0.4;
    this.vx += Math.min(Math.max(-lim, Math.cos(a) * dist * c), lim);
    this.vy += Math.min(Math.max(-lim, Math.sin(a) * dist * c), lim);
  }

  chooseTrg(): void {
    const dx = this.game.hero.view.x - this.view.x;
    const dy = this.game.hero.view.y - this.view.y;
    const a = Math.atan2(dy, dx);
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), 160);
    this.trg = {
      x: this.view.x + Math.cos(a) * dist,
      y: this.view.y + Math.sin(a) * dist,
    };
  }

  override hit(shot: Star): void {
    this.nextAnim = 'hit';
    super.hit(shot);
  }

  override death(): void {
    this.playAnim('death');
    super.death();
  }

  protected applyFrame(absoluteFrame: number): void {
    const sheet = this.game.assets.flyer;
    const idx = Math.max(0, Math.min(absoluteFrame, sheet.length - 1));
    const child = this.view.children[0];
    if (child instanceof Sprite) {
      setFrame(child, sheet[idx]);
    }
  }
}

// -------------------------------------------------------------------------
// Animation atlas helpers
// -------------------------------------------------------------------------
//
// Frame ranges below are pulled from SWF timeline labels via FFDec on
// `gfx.swf` (R19). Each `start` is `(SWF frame label) - 1` because the
// extracted atlases are 1-indexed PNG files (1.png..N.png) loaded into a
// 0-indexed array. Counts run up to the next label. Labels not present in
// the source MovieClip are omitted; the port's `playAnim` falls through
// (silent no-op) on unknown names, which matches Flash's behaviour
// when `gotoAndPlay` references a nonexistent label.

function buildMonsterAnims(): { name: string; start: number; count: number }[] {
  // mcMonster (DefineSprite 385): 161 frames, 11 labels.
  return [
    { name: 'walk', start: 0, count: 4 },
    { name: 'walk_loop', start: 4, count: 15 },
    { name: 'climb', start: 19, count: 17 },
    { name: 'climbEnd', start: 36, count: 16 },
    { name: 'fly_up', start: 52, count: 13 },
    { name: 'fly_down', start: 65, count: 9 },
    { name: 'fly_straight_up', start: 74, count: 12 },
    { name: 'fly_straight_down', start: 86, count: 12 },
    { name: 'death', start: 98, count: 29 },
    { name: 'shootWait', start: 127, count: 14 },
    { name: 'shoot', start: 141, count: 20 },
  ];
}

function buildTankerAnims(): { name: string; start: number; count: number }[] {
  // mcTanker (DefineSprite 269): 89 frames, 6 labels. No climbEnd /
  // fly_straight_* / shoot / shootWait / hit / fall / land in source.
  return [
    { name: 'walk', start: 0, count: 4 },
    { name: 'walk_loop', start: 4, count: 19 },
    { name: 'climb', start: 23, count: 14 },
    { name: 'fly_up', start: 37, count: 21 },
    { name: 'fly_down', start: 58, count: 11 },
    { name: 'death', start: 69, count: 20 },
  ];
}

function buildFlyerAnims(): { name: string; start: number; count: number }[] {
  // mcFlyer (DefineSprite 290): 50 frames, 3 labels. The clip has a single
  // steady-state `fly` loop plus `hit` (overridden in Flyer.hit) and
  // `death`. Inherited Monster nextAnim writes ('walk_loop', 'fly_up' etc.)
  // resolve to no-op via the playAnim find() — matches source where Flyer
  // doesn't react to those calls (Flash gotoAndPlay on missing labels).
  return [
    { name: 'fly', start: 0, count: 16 },
    { name: 'hit', start: 16, count: 14 },
    { name: 'death', start: 30, count: 20 },
  ];
}

// Frame-count export so other files don't need to import the constants twice.
export const ANIM_HERO_FRAMES = HERO_FRAMES;
export const ANIM_TANKER_FRAMES = TANKER_FRAMES;
