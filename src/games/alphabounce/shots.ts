// Shot — port of Shot.hx + shot/Laser.hx.
//
// Shot extends Element (grid stepping with onBounce ⇒ hit). Laser extends
// Shot: travels upward (vy = -vit), expands its yscale on ascent and shrinks
// on descent, then kills.

import { Container, Sprite } from 'pixi.js';
import type { GameContext } from './game-context';
import { BH, BW, SIDE, getX, getY, haxeInt } from './constants';
import { makeSprite } from '../_shared/frames';

export class Shot {
  ctx: GameContext;
  view: Container;
  body: Sprite;

  // Element grid coords.
  px = 0;
  py = 0;
  ox = 0;
  oy = 0;
  vx = 0;
  vy = 0;
  frict = 1;
  damage = 1;
  alive = true;

  constructor(ctx: GameContext, body: Sprite) {
    this.ctx = ctx;
    this.view = new Container();
    this.body = body;
    this.view.addChild(this.body);
    ctx.partsLayer.addChild(this.view);
  }

  update(): void {
    // Element.update — sub-cell stepping with grid collision.
    let parc = 1;
    let vvx = this.vx * this.ctx.tmod;
    let vvy = this.vy * this.ctx.tmod;
    let safety = 0;
    while (parc > 0 && safety < 16) {
      safety += 1;
      let cx: number;
      let cy: number;
      if (vvx > 0) cx = (BW - this.ox) / vvx;
      else if (vvx < 0) cx = this.ox / vvx;
      else cx = 999999;
      if (vvy > 0) cy = (BH - this.oy) / vvy;
      else if (vvy < 0) cy = this.oy / vvy;
      else cy = 999999;

      let c: number;
      let sx: number | null = null;
      let sy: number | null = null;
      if (Math.abs(cx) < Math.abs(cy)) {
        c = Math.abs(cx);
        sx = cx === 0 ? -1 : Math.trunc(cx / c) || 1;
      } else {
        c = Math.abs(cy);
        sy = cy === 0 ? -1 : Math.trunc(cy / c) || 1;
      }

      let flCheck = true;
      if (c > parc) {
        c = parc;
        flCheck = false;
      }
      this.ox += vvx * c;
      this.oy += vvy * c;
      parc -= c;

      if (flCheck) {
        if (sx !== null) {
          if (this.ctx.isFree(this.px + sx, this.py)) {
            this.px += sx;
            this.ox -= sx * BW;
          } else {
            this.onBounce(this.px + sx, this.py);
            vvx *= -this.frict;
            this.vx *= -this.frict;
          }
        }
        if (sy !== null) {
          if (this.ctx.isFree(this.px, this.py + sy)) {
            this.py += sy;
            this.oy -= sy * BH;
          } else {
            this.onBounce(this.px, this.py + sy);
            vvy *= -this.frict;
            this.vy *= -this.frict;
          }
        }
      }
    }
    this.updatePos();
  }

  moveTo(nx: number, ny: number): void {
    this.px = haxeInt((nx - SIDE) / BW);
    this.py = haxeInt(ny / BH);
    this.ox = nx - getX(this.px);
    this.oy = ny - getY(this.py);
  }

  updatePos(): void {
    this.view.x = getX(this.px) + this.ox;
    this.view.y = getY(this.py) + this.oy;
  }

  onBounce(px: number, py: number): void {
    // The Shot::hit path damages a single block then kills self.
    const bl = this.ctx.grid[px]?.[py];
    if (bl) bl.damage(null, 0, this.damage);
    this.hit();
  }

  hit(): void {
    this.kill();
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    const i = this.ctx.shots.indexOf(this);
    if (i >= 0) this.ctx.shots.splice(i, 1);
    this.view.removeFromParent();
  }
}

export class Laser extends Shot {
  // Source `Laser.height = 44` is a yscale **percentage** cap, not a pixel
  // height. mcLaser.smc grows from `_yscale=0` to `_yscale=44` at +vit per
  // frame. Earlier port stored `cur` as a pixel value and divided by the
  // laser texture height (184 px), which produced a visible laser ~44 px tall
  // — about 1.85× shorter than source's intended 44% × ~184 px ≈ 81 px.
  // Restored to source semantics: `pct` is a percentage 0..44.
  static MAX_PCT = 44;
  vit = 18;
  pct = 0;
  flHit = false;
  // Inner sprite scaled vertically (mimics smc._yscale animation in source).
  inner: Sprite;

  constructor(ctx: GameContext) {
    const body = new Sprite();
    super(ctx, body);
    // Instead of using `body` directly, swap in an inner sprite with anchored
    // bottom so we can scale vertically downward only.
    body.removeFromParent();
    this.inner = makeSprite(ctx.assets.laser);
    this.inner.anchor.set(0.5, 1);
    this.inner.scale.y = 0;
    this.view.addChild(this.inner);
  }

  setVit(n: number): void {
    this.vit = n;
    this.vy = -n;
  }

  update(): void {
    super.update();
    const sens = this.flHit ? -1 : 1;
    this.pct = Math.max(0, Math.min(Laser.MAX_PCT, this.pct + this.vit * this.ctx.tmod * sens));
    this.inner.scale.y = this.pct / 100;
    if (this.flHit && this.pct === 0) this.kill();
    this.ctx.plasmaDraw(this.view);
  }

  hit(): void {
    this.flHit = true;
    this.vy = 0;
  }
}
