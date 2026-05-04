// Shoot / Kunai / Star — port of Shoot.mt, Kunai.mt, Star.mt.
//
// Shoot is the base ballistic projectile (cell-based position + velocity).
// Kunai is the enemy projectile that targets the hero.
// Star is the hero projectile that hits any monster in the same grid cell.

import { Container, Sprite } from 'pixi.js';
import { type Frame, makeSprite, setFrame } from '../_shared/frames';
import { SIZE, TMOD, XMAX, YMAX } from './constants';
import type { GameContext } from './game-context';

export abstract class Shoot {
  view: Sprite;
  game: GameContext;
  x = 0;
  y = 0;
  dx = 0;
  dy = 0;
  vx = 0;
  vy = 0;
  vr = 0;
  flCheck = false;
  alive = true;

  constructor(view: Sprite, game: GameContext) {
    this.view = view;
    this.game = game;
  }

  update(): void {
    this.flCheck = false;

    this.dx += this.vx * TMOD;
    this.dy += this.vy * TMOD;

    this.recal();

    if (!this.alive) {
      return;
    }

    this.view.x = (this.x + 0.5) * SIZE + this.dx;
    this.view.y = (this.y + 0.5) * SIZE + this.dy;
    this.view.rotation += this.vr * TMOD;

    if (this.x < 0 || this.x > XMAX || this.y < 0 || this.y > YMAX) {
      this.kill();
      return;
    }

    if (!this.flCheck) {
      this.checkCol();
    }
  }

  recal(): void {
    const m = SIZE * 0.5;
    let adx = Math.abs(this.dx);
    let ady = Math.abs(this.dy);

    while (adx > m || ady > m) {
      if (adx > m) {
        if (this.dx > 0) {
          this.dx -= 2 * m;
          this.x += 1;
        } else {
          this.dx += 2 * m;
          this.x -= 1;
        }
      } else {
        if (this.dy > 0) {
          this.dy -= 2 * m;
          this.y += 1;
        } else {
          this.dy += 2 * m;
          this.y -= 1;
        }
      }
      adx = Math.abs(this.dx);
      ady = Math.abs(this.dy);
      this.checkCol();
      if (!this.alive) {
        return;
      }
    }
  }

  checkCol(): void {
    this.flCheck = true;
  }

  kill(): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.view.removeFromParent();
  }
}

export class Kunai extends Shoot {
  constructor(view: Sprite, game: GameContext) {
    super(view, game);
    // Source pushes Kunai to sList twice: once in Shoot.new (the base
    // constructor) and once in Kunai.new. Game.update iterates sList and
    // calls update() on each entry, so each Kunai effectively ticks twice
    // per frame in the source — its kunais travel at 2x the assigned vx/vy.
    // The port's base Shoot does not push to sList (Star uses nsList), so we
    // push twice here in Kunai's constructor to preserve the doubled tick.
    // Without this, enemy kunais travel at half their intended speed and are
    // trivially dodgeable.
    game.sList.push(this);
    game.sList.push(this);
  }

  override checkCol(): void {
    super.checkCol();
    const hero = this.game.hero;
    if (!hero.flInvicible && hero.sTimer === null) {
      const ddx = this.view.x - hero.view.x;
      const ddy = this.view.y - hero.view.y;
      if (Math.sqrt(ddx * ddx + ddy * ddy) < 14) {
        hero.hit(this);
        this.kill();
      }
    }
  }

  override kill(): void {
    if (!this.alive) {
      return;
    }
    super.kill();
    // Remove both occurrences (matches source: super.kill removes one,
    // Kunai.kill removes the other).
    for (let pass = 0; pass < 2; pass += 1) {
      const i = this.game.sList.indexOf(this);
      if (i >= 0) this.game.sList.splice(i, 1);
    }
  }
}

export class Star extends Shoot {
  damage = 5;
  // Stars use the ninja-shot frame set; frame 1 normal, frame 2 with flames.
  frames: Frame[];

  constructor(view: Sprite, game: GameContext, frames: Frame[]) {
    super(view, game);
    this.frames = frames;
    game.nsList.push(this);
  }

  setFlames(flames: boolean): void {
    this.damage = flames ? 8 : 5;
    setFrame(this.view, this.frames[flames ? 1 : 0]);
  }

  override checkCol(): void {
    super.checkCol();
    if (this.x < 0 || this.x >= XMAX || this.y < 0 || this.y >= YMAX) {
      return;
    }
    const list = this.game.grid[this.x][this.y].list;
    if (list.length > 0) {
      const m = list[0];
      m.hit(this);
      this.kill();
    }
  }

  override kill(): void {
    if (!this.alive) {
      return;
    }
    super.kill();
    const i = this.game.nsList.indexOf(this);
    if (i >= 0) {
      this.game.nsList.splice(i, 1);
    }
  }
}

// Helper for Soldier.shoot() — spawns a Kunai onto the projectile layer.
export function spawnKunai(
  game: GameContext,
  layer: Container,
  kunaiFrame: Frame,
  px: number,
  py: number,
  ang: number,
  speed: number,
  cellX: number,
  cellY: number,
  cellDx: number,
  cellDy: number,
): void {
  const sp = makeSprite(kunaiFrame);
  sp.anchor.set(0.5);
  sp.x = px;
  sp.y = py;
  sp.rotation = ang;
  layer.addChild(sp);
  const k = new Kunai(sp, game);
  k.x = cellX;
  k.y = cellY;
  k.dx = cellDx;
  k.dy = cellDy;
  k.vx = Math.cos(ang) * speed;
  k.vy = Math.sin(ang) * speed;
}
