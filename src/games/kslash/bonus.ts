// Bonus pickups — port of Bonus.mt. Items dropped by enemies that grant
// score, refill stars, toggle hero options, or trigger super-mode.

import { Sprite } from 'pixi.js';
import { setFrame } from '../_shared/frames';
import {
  BONUS_FRAMES,
  BONUS_ID_FLYER_BURST,
  BONUS_ID_OPT_FLAMES,
  BONUS_ID_OPT_KATANA,
  BONUS_ID_OPT_SCROLL,
  BONUS_ID_SCORE_COMMON,
  BONUS_ID_SCORE_RARE,
  BONUS_ID_SCORE_ULTRA,
  BONUS_ID_STAR_LARGE,
  BONUS_ID_STAR_SMALL,
  BONUS_ID_SUPER,
  C1000,
  C200,
  C5000,
  C8000,
  TMOD,
} from './constants';
import type { GameContext } from './game-context';

export class Bonus {
  view: Sprite;
  game: GameContext;
  id = 1;
  time = 300; // frames; ~7.5s at 40 FPS
  alive = true;

  constructor(view: Sprite, game: GameContext) {
    this.view = view;
    this.game = game;
    game.bList.push(this);
  }

  setId(id: number): void {
    this.id = id;
    const idx = Math.max(0, Math.min(id - 1, BONUS_FRAMES - 1));
    setFrame(this.view, this.game.assets.bonus[idx]);
  }

  update(): void {
    this.time -= TMOD;
    if (this.time < 10) {
      this.view.alpha = Math.max(0, this.time / 10);
      if (this.time < 0) {
        this.kill();
      }
    }
  }

  // Picked up by hero.
  take(): void {
    let pid: number | null = null;
    switch (this.id) {
      case BONUS_ID_SCORE_COMMON:
        this.addScore(C200);
        pid = 0;
        break;
      case BONUS_ID_SCORE_RARE:
        this.addScore(C1000);
        pid = 0;
        break;
      case BONUS_ID_SCORE_ULTRA:
        // Source has a missing `break;` here so case 3 ALSO triggers case 4's
        // incStar(20) and pid=1. Brief explicitly says preserve this quirk.
        this.addScore(C5000);
        pid = 0;
        // eslint-disable-next-line no-fallthrough
      case BONUS_ID_STAR_SMALL:
        this.game.hero.incStar(20);
        pid = 1;
        break;
      case BONUS_ID_STAR_LARGE:
        this.game.hero.incStar(50);
        pid = 1;
        break;
      case BONUS_ID_OPT_KATANA:
      case BONUS_ID_OPT_FLAMES:
      case BONUS_ID_OPT_SCROLL:
        this.game.optList[this.id - 6] = true;
        this.game.updateIcons();
        pid = 1;
        break;
      case BONUS_ID_FLYER_BURST:
        for (let i = 0; i < 18; i += 1) {
          this.game.newMonster(3);
        }
        this.addScore(C8000);
        break;
      case BONUS_ID_SUPER:
        this.game.hero.initSupa();
        break;
    }

    this.spawnPickupFx(pid);

    const optIndex = this.id - 1;
    if (optIndex >= 0 && optIndex < this.game.stats.$opt.length) {
      this.game.stats.$opt[optIndex] += 1;
    }
    this.kill();
  }

  private spawnPickupFx(pid: number | null): void {
    const x = this.view.x;
    const y = this.view.y;
    switch (pid) {
      case 0: {
        for (let i = 0; i < 12; i += 1) {
          const p = this.game.newPart('partSpark');
          const a = Math.random() * 6.28;
          const d = Math.random() * (6 + 18 * (1 - i / 24));
          p.view.x = x + Math.cos(a) * d;
          p.view.y = y + Math.sin(a) * d;
          p.t = 10 + Math.random() * 10;
          p.wt = Math.max(0, Math.pow(i * 30, 0.5) - 8);
          p.scale = 30 + Math.random() * 100 - p.wt * 2;
          p.view.scale.set(p.scale / 100);
          p.ft = 0;
          p.view.visible = false;
          p.visible = false;
        }
        break;
      }
      case 1: {
        for (let i = 0; i < 3; i += 1) {
          const p = this.game.newPart('partCircle');
          p.view.x = x;
          p.view.y = y;
          p.view.rotation = Math.random() * Math.PI * 2;
          p.t = 18 - i * 3;
          p.vs = 6 + i * 8;
          p.vr = (8 + i * 12) * (Math.PI / 180);
        }
        break;
      }
      case 2: {
        const max = 8;
        for (let i = 0; i < max; i += 1) {
          for (let n = 0; n < 2; n += 1) {
            const p = this.game.newPart('partLight');
            p.view.x = x;
            p.view.y = y;
            const a = ((i + 0.5 * n) / max) * 6.28;
            const speed = 3 + n * 2;
            p.vx += Math.cos(a) * speed;
            p.vy += Math.sin(a) * speed;
            p.t = 26 + Math.random() * 4 - n * 10;
            p.frict = 0.9;
          }
        }
        break;
      }
    }
  }

  private addScore(n: number): void {
    this.game.addScore(n);
    const p = this.game.newPart('mcScore');
    p.view.x = this.view.x;
    p.view.y = this.view.y;
    p.vy = -1;
    p.t = 24;
    // Source: `downcast(p).field.text = string(KKApi.val(n))`. KKApi.val is
    // a pass-through on the score constants, so we write n directly into the
    // TextField "field" baked into the mcScore particle. See game.ts:newPart.
    if (p.field) {
      p.field.text = String(n);
    }
  }

  private kill(): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    this.view.removeFromParent();
    const i = this.game.bList.indexOf(this);
    if (i >= 0) {
      this.game.bList.splice(i, 1);
    }
  }
}
