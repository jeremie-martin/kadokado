import { Container } from 'pixi.js';
import { STAGE_WIDTH, STAGE_HEIGHT } from './constants';
import type { IronChouquetteGame } from './game';

// Sprite.mt — base for everything that sits in `sList` and is updated each frame.
// `root` mirrors the .mt MovieClip wrapper. We keep its position/scale/rotation
// in sync inside `update()` so subclasses can read x/y as logical coordinates.

export class Sprite {
  game: IronChouquetteGame;
  root: Container;

  x = 0;
  y = 0;
  scale = 100;

  // Optional payloads attached to "root" in the original via downcasts; we expose them as fields.
  alpha = 100;
  rotationDeg = 0;

  // Lifecycle.
  killed = false;

  constructor(game: IronChouquetteGame, root: Container) {
    this.game = game;
    this.root = root;
    this.game.sList.push(this);
    this.x = 0;
    this.y = 0;
    this.root.x = -100;
    this.root.y = -100;
  }

  setScale(n: number): void {
    this.scale = n;
    this.root.scale.set(n / 100);
  }

  update(): void {
    this.root.x = this.x;
    this.root.y = this.y;
  }

  updatePos(): void {
    this.root.x = this.x;
    this.root.y = this.y;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    if (this.root && this.root.parent) {
      this.root.parent.removeChild(this.root);
    }
    if (this.root) {
      this.root.destroy({ children: true });
    }
    const idx = this.game.sList.indexOf(this);
    if (idx >= 0) this.game.sList.splice(idx, 1);
  }

  getDist(o: { x: number; y: number }): number {
    const dx = o.x - this.x;
    const dy = o.y - this.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getAng(o: { x: number; y: number }): number {
    const dx = o.x - this.x;
    const dy = o.y - this.y;
    return Math.atan2(dy, dx);
  }

  isOut(m: number): boolean {
    return this.x < -m || this.x > STAGE_WIDTH + m || this.y < -m || this.y > STAGE_HEIGHT + m;
  }
}
