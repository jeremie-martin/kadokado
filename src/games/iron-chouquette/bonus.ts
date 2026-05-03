import { Container } from 'pixi.js';
import { Phys } from './phys';
import {
  BONUS_STATS, randInt,
  STAGE_WIDTH, STAGE_HEIGHT,
} from './constants';
import type { IronChouquetteGame } from './game';
import { makeSprite, setFrame } from '../_shared/frames';

// Bonus.mt — pickup item dropped by Carrier or specific events. Bonus IDs 0..5 grant a weapon
// stack to the matching slot, ID 6 adds a slot, others are unused / reserved.

export class Bonus extends Phys {
  static SPEED = 3;

  id: number;

  constructor(game: IronChouquetteGame, x: number, y: number) {
    const root = new Container();
    super(game, root);
    this.game.bonusList.push(this);
    this.game.badsLayer.addChild(this.root);

    this.ray = 15;
    this.id = Bonus.pickRandomId();

    // Visual: gotoAndStop(string(id+1)) on mcBonus (28 frames available).
    const idx = Math.max(0, Math.min(this.id, this.game.assets.bonus.length - 1));
    const sp = makeSprite(this.game.assets.bonus[idx]);
    sp.anchor.set(0.5);
    this.root.addChild(sp);

    this.x = x;
    this.y = y;
    const a = 0.775 + randInt(2) * 1.57;
    this.vx = Math.cos(a) * Bonus.SPEED;
    this.vy = Math.sin(a) * Bonus.SPEED;
  }

  static pickRandomId(): number {
    let max = 0;
    for (const w of BONUS_STATS) max += w;
    if (max <= 0) return 0;
    let rnd = randInt(max);
    let cur = 0;
    for (let i = 0; i < BONUS_STATS.length; i += 1) {
      cur += BONUS_STATS[i];
      if (cur > rnd) return i;
    }
    return 0;
  }

  override update(): void {
    super.update();
    const h = this.game.hero;
    if (h && this.collide(h)) {
      this.take();
      return;
    }
    this.checkBounds();
    if (this.isOut(this.ray * 2)) this.kill();

    // Visual frame stays static; the original cycled rays for IDs 15..17 (special), unused here.
    if (this.id >= 0 && this.id < this.game.assets.bonus.length) {
      const idx = Math.max(0, Math.min(this.id, this.game.assets.bonus.length - 1));
      // Keep texture correct in case of any frame swap elsewhere.
      const sp = this.root.children[0];
      if (sp) {
        setFrame(sp as unknown as import('pixi.js').Sprite, this.game.assets.bonus[idx]);
      }
    }
  }

  take(): void {
    const h = this.game.hero;
    if (!h) return;
    switch (this.id) {
      case 0:
      case 1:
      case 2:
      case 3:
      case 4:
      case 5:
        h.addWeapon(this.id);
        break;
      case 6:
        h.addBox();
        break;
      default:
        // unused IDs in the source.
        break;
    }
    this.kill();
  }

  private checkBounds(): void {
    if (this.x < this.ray || this.x > STAGE_WIDTH - this.ray) {
      this.vx *= -1;
      this.x = Math.min(Math.max(this.x, this.ray), STAGE_WIDTH - this.ray);
    }
    if (this.y > STAGE_HEIGHT - this.ray) {
      this.vy *= -1;
      this.y = Math.min(Math.max(this.y, this.ray), STAGE_HEIGHT - this.ray);
    }
  }

  override kill(): void {
    if (this.killed) return;
    const idx = this.game.bonusList.indexOf(this);
    if (idx >= 0) this.game.bonusList.splice(idx, 1);
    super.kill();
  }
}
