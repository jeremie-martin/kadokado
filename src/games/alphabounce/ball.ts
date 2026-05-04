// Ball — port of Ball.hx (extends Element).
//
// Element provides grid-stepping physics (sub-cell ox/oy + per-frame parc loop
// matching Element.update from the source). Ball overrides update to handle
// type-specific behaviours (Fire/Ice/Drunk/Kamikaze/Yoyo/Halo/Shade), pad
// collision (colPad / colProtect), and life-loss bookkeeping.

import { Container, Sprite } from 'pixi.js';
import type { Frame } from '../_shared/frames';
import { makeSprite, setFrame } from '../_shared/frames';
import type { Block } from './block';
import {
  BALL_DRUNK,
  BALL_FIRE,
  BALL_HALO,
  BALL_ICE,
  BALL_KAMIKAZE,
  BALL_SHADE,
  BALL_STANDARD,
  BALL_YOYO,
  BH,
  BW,
  MCH,
  PAD_GLUE,
  SIDE,
  XMAX,
  YMAX,
  getX,
  getY,
  haxeInt,
} from './constants';
import type { GameContext } from './game-context';
import { makePart } from './fx';

const ANGLE_MAX = 1.2;

export class Ball {
  ctx: GameContext;
  view: Container; // wraps the body Sprite (for rotation pivot)
  body: Sprite; // current ball-type frame
  ballFrames: Frame[];

  // Element grid coords.
  px = 0;
  py = 0;
  ox = 0;
  oy = 0;
  vx = 0;
  vy = 0;
  frict = 1;

  // Ball state.
  flUp = true;
  flBounce = false;
  type = BALL_STANDARD;
  speed = 6;
  damage = 1;
  ray = 4;
  gluePoint: number | null = null;
  va = 0;
  ca = 0;
  sleep: number | null = null;
  // Source stores a direct Block reference; index-based storage would silently
  // re-target on every block death (splice shifts indices). Match source.
  trg: Block | null = null;

  // Sprite-list reference for kill().
  alive = true;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.ballFrames = ctx.assets.ball;

    this.view = new Container();
    this.body = makeSprite(this.ballFrames[0]);
    this.view.addChild(this.body);
    ctx.ballLayer.addChild(this.view);

    ctx.balls.push(this);

    this.ox = 0;
    this.oy = 0;
    this.px = Math.floor(XMAX * 0.5);
    this.py = Math.floor(YMAX - 3);
    this.vx = Math.random() * 2 - 1;
    this.vy = -(4 + Math.random() * 2);
    this.flUp = true;
    this.setType(BALL_STANDARD);
    this.updatePos();
  }

  // Element update — sub-cell stepping with grid collision callback.
  // Ports Element.update + Ball.update (which wraps super.update).
  update(): void {
    this.flBounce = false;

    // Glue-stick to pad: lock to pad position; tag fire-ball rotation.
    if (this.gluePoint !== null) {
      const py = this.ctx.pad.y - this.ray;
      const px = this.ctx.pad.x + this.gluePoint;
      this.moveTo(px, py);
      this.updatePos();
      if (this.type === BALL_FIRE) {
        this.body.rotation = Math.PI * 0.5;
      }
      return;
    }

    if (this.sleep !== null) {
      this.sleep -= this.ctx.tmod;
      if (this.sleep < 0) this.sleep = null;
      return;
    }

    // ---- Element.update (grid stepping) ----
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

    // ---- pad collision ----
    if (this.flUp && this.vy > 0 && this.view.y > this.ctx.pad.y - this.ray) {
      const cx = (this.view.x - this.ctx.pad.x) / this.ctx.pad.ray;
      if (Math.abs(cx) < 1) {
        if (this.type === BALL_SHADE) {
          this.destroy();
          return;
        }
        this.colPad(cx);
      } else if (this.ctx.pad.flProtect) {
        this.colProtect();
      } else {
        this.flUp = false;
      }
    }

    // ---- death check (life loss) ----
    if (!this.flUp && this.view.y > MCH + 10) {
      if (
        this.ctx.balls.length === 1 &&
        this.ctx.levelTimer < 600 &&
        this.ctx.flSafe &&
        this.type !== BALL_SHADE
      ) {
        this.moveTo(this.view.x, MCH + 10);
        this.vy *= -1;
        this.flUp = true;
        this.ctx.newTitle('SAUVETAGE !', 0xff0000, true);
        if (this.ctx.lvl === 0) this.setSpeed(3);
      } else {
        this.destroy();
        return;
      }
    }

    // ---- per-type effects ----
    switch (this.type) {
      case BALL_FIRE: {
        const a = Math.atan2(this.vy, this.vx);
        this.body.rotation = a;
        this.genSparks(0, 20);
        break;
      }
      case BALL_ICE: {
        this.genSparks(1, 10);
        this.genIceShards();
        this.ctx.plasmaDraw(this.view);
        break;
      }
      case BALL_DRUNK: {
        let a = Math.atan2(this.vy, this.vx);
        this.va += (Math.random() * 2 - 1) * 0.03 * (this.speed / 6) * this.ctx.tmod;
        this.va *= Math.pow(0.95, this.ctx.tmod);
        a += this.va * this.ctx.tmod;
        this.vx = Math.cos(a) * this.speed;
        this.vy = Math.sin(a) * this.speed;
        this.genBubbles();
        this.ctx.plasmaDraw(this.view);
        break;
      }
      case BALL_KAMIKAZE: {
        const blocks = this.ctx.blocks;
        if (this.trg === null || this.trg.flDeath) {
          this.trg = blocks.length > 0 ? blocks[Math.floor(Math.random() * blocks.length)] : null;
          this.ca = 0.01;
        }
        if (this.trg !== null) {
          const trg = this.trg;
          let a = Math.atan2(this.vy, this.vx);
          const dx = getX(trg.x + 0.5) - this.view.x;
          const dy = getY(trg.y + 0.5) - this.view.y;
          const ta = Math.atan2(dy, dx);
          this.ca = Math.min(this.ca + 0.002 * this.ctx.tmod, 1);
          this.va += hMod(ta - a, Math.PI) * this.ca;
          this.va *= Math.pow(0.8, this.ctx.tmod);
          a += this.va;
          this.vx = Math.cos(a) * this.speed;
          this.vy = Math.sin(a) * this.speed;
        }
        this.ctx.plasmaDraw(this.view);
        break;
      }
      case BALL_YOYO: {
        const sp = this.speed * 4 * (1 - this.view.y / (MCH + 15));
        const a = Math.atan2(this.vy, this.vx);
        this.vx = Math.cos(a) * sp;
        this.vy = Math.sin(a) * sp;
        this.ctx.plasmaDraw(this.view);
        break;
      }
      case BALL_HALO:
      case BALL_SHADE:
      default:
        this.ctx.plasmaDraw(this.view);
        break;
    }

    // Bounce-angle clamp: if velocity vector falls in the [−1.57+ANGLE_MAX,
    // 1.57+ANGLE_MAX] thin-pass corridor, deflect.
    if (this.flBounce) {
      for (let i = 0; i < 2; i += 1) {
        let a = Math.atan2(this.vy, this.vx);
        const ba = i * Math.PI;
        const da = hMod(ba - a, Math.PI);
        const la = 1.57 - ANGLE_MAX;
        if (Math.abs(da) < la) {
          const dif = la - Math.abs(da);
          let sens = Math.abs(da) / da;
          if (da === 0) sens = 1;
          a -= dif * sens;
          this.setAngle(a);
        }
      }
    }
  }

  colPad(cx: number): void {
    this.moveTo(this.view.x, this.ctx.pad.y - this.ray);
    this.updatePos();
    const a = -1.57 + cx * ANGLE_MAX;
    this.vx = Math.cos(a) * this.speed;
    this.vy = Math.sin(a) * this.speed;

    // Glue: stick to pad.
    if (this.ctx.pad.type === PAD_GLUE) {
      this.gluePoint = this.view.x - this.ctx.pad.x;
      const max = 10;
      for (let i = 0; i < max; i += 1) {
        const ang = (-i / max) * Math.PI;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const sp = 0.5 + Math.random() * 3;
        const cr = 4;
        const sprite = makeSprite(this.ctx.assets.partGlue);
        sprite.anchor.set(0.5);
        this.ctx.partsLayer.addChild(sprite);
        const w = 0.1 + Math.random() * 0.15;
        makePart(this.ctx, {
          kind: 'phys',
          view: sprite,
          x: this.view.x + ca * sp * cr,
          y: this.view.y + sa * sp * cr,
          vx: ca * sp,
          vy: sa * sp,
          weight: w,
          timer: 10 + Math.random() * 10,
          life: 20,
          fadeType: 0,
          scale: w * 400,
        });
      }
    }

    // Halo: spawn 5 shade trails.
    if (this.type === BALL_HALO) {
      const max = 5;
      for (let i = 0; i < max; i += 1) {
        const b = this.clone();
        b.sleep = (i + 1) * 3 - 1;
        b.setType(BALL_SHADE);
        b.view.alpha = 0.5;
        // Source `Ball.hx:220` calls `dm.under(b.root)` which moves the SHADE
        // clone to the bottom of the DP_BALL plan, so the trails render BEHIND
        // the lead HALO ball (and any other balls) instead of obscuring them.
        // R22: mirror by re-parenting at index 0 of ballLayer.
        if (b.view.parent) b.view.parent.addChildAt(b.view, 0);
      }
    }
  }

  colProtect(): void {
    this.moveTo(this.view.x, this.ctx.pad.y - this.ray);
    this.updatePos();
    this.vy *= -1;
    const max = Math.floor(2 + 12 * Math.max(0, 1 - this.ctx.spriteCount() / 120));
    const cr = 3;
    for (let i = 0; i < max; i += 1) {
      const a = (i / max - 1) * Math.PI + (Math.random() * 2 - 1) * 0.2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const sp = 0.5 + Math.random() * 4;
      const sprite = makeSprite(this.ctx.assets.partLine);
      sprite.tint = 0xff00ff;
      this.ctx.partsLayer.addChild(sprite);
      makePart(this.ctx, {
        kind: 'spark',
        view: sprite,
        x: this.view.x + ca * sp * cr,
        y: this.view.y + sa * sp * cr + 5,
        vx: ca * sp,
        vy: sa * sp,
        weight: 0.1 + Math.random() * 0.1,
        timer: 10 + Math.random() * 20,
        life: 30,
        scale: 200,
      });
    }
  }

  setType(n: number): void {
    if (this.type === BALL_SHADE) return;
    this.type = n;
    const idx = Math.max(0, Math.min(n, this.ballFrames.length - 1));
    setFrame(this.body, this.ballFrames[idx]);
    switch (this.type) {
      case BALL_STANDARD:
        this.damage = 1;
        this.ray = 4;
        break;
      case BALL_FIRE:
        this.damage = 2;
        this.ray = 5;
        break;
      case BALL_ICE:
        this.damage = 1;
        this.ray = 4;
        break;
      case BALL_DRUNK:
        this.damage = 1;
        this.ray = 4;
        this.va = 0;
        break;
      case BALL_KAMIKAZE:
        this.damage = 1;
        this.ray = 5;
        this.va = 0;
        break;
      case BALL_HALO:
        this.damage = 1;
        this.ray = 4;
        break;
      default:
        break;
    }
  }

  setSpeed(n: number): void {
    if (n > 30 && this.type === BALL_KAMIKAZE) this.setType(BALL_STANDARD);
    this.speed = n;
    const a = Math.atan2(this.vy, this.vx);
    this.vx = Math.cos(a) * this.speed;
    this.vy = Math.sin(a) * this.speed;
  }

  setAngle(a: number): void {
    this.vx = Math.cos(a) * this.speed;
    this.vy = Math.sin(a) * this.speed;
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
    this.ctx.hit(px, py, this);
    this.flBounce = true;
    if (this.type === BALL_SHADE && px > 0 && px < XMAX) {
      this.destroy();
    }
  }

  clone(): Ball {
    const ball = this.ctx.newBall();
    ball.moveTo(this.view.x, this.view.y);
    ball.updatePos();
    ball.speed = this.speed;
    // Source `Ball.hx:316` writes `ball.flUp == flUp;` — a `==` typo, so the
    // expression is a discarded comparison, not an assignment. The cloned
    // ball therefore keeps its default `flUp = true` from the constructor.
    // Earlier port copied `flUp` properly, which diverges from source: a
    // MULTI-BALL clone of a ball that had already passed the pad (flUp=false)
    // would in source come back as flUp=true (and could re-collide with the
    // pad), but in port stayed flUp=false (and just fell off-screen). Mirror
    // the source's quirk verbatim.
    // ball.flUp = this.flUp;  // intentionally NOT mirrored — source typo `==`.
    ball.setType(this.type);
    ball.vx = this.vx;
    ball.vy = this.vy;
    ball.gluePoint = this.gluePoint;
    return ball;
  }

  // FX helpers — Phys-based sparks/shards/bubbles.
  private genSparks(frameIdx: number, turn: number): void {
    if (Math.floor(Math.random() * Math.max(1, this.ctx.spriteCount())) >= 20) return;
    const sprite = makeSprite(this.ctx.assets.partSpark[frameIdx % this.ctx.assets.partSpark.length]);
    sprite.anchor.set(0.5);
    this.ctx.underPartsLayer.addChild(sprite);
    const c = 0.3 + Math.random() * 0.5;
    sprite.rotation = Math.random() * Math.PI * 2;
    makePart(this.ctx, {
      kind: 'phys',
      view: sprite,
      x: this.view.x,
      y: this.view.y,
      vx: c * this.vx,
      vy: c * this.vy,
      vr: (Math.random() * 2 - 1) * turn,
      timer: 10 + Math.random() * 30,
      life: 40,
      frict: 0.95,
    });
  }
  private genIceShards(): void {
    if (Math.floor(Math.random() * Math.max(1, this.ctx.spriteCount())) >= 15) return;
    const sprite = makeSprite(this.ctx.assets.partIceShard);
    sprite.anchor.set(0.5);
    this.ctx.underPartsLayer.addChild(sprite);
    const c = 0.7 + Math.random() * 0.3;
    sprite.rotation = Math.atan2(this.vy, this.vx);
    makePart(this.ctx, {
      kind: 'phys',
      view: sprite,
      x: this.view.x + (Math.random() * 2 - 1) * 4,
      y: this.view.y + (Math.random() * 2 - 1) * 4,
      vx: c * this.vx,
      vy: c * this.vy,
      vr: (Math.random() * 2 - 1) * 8,
      weight: 0.1 + Math.random() * 0.1,
      timer: 10 + Math.random() * 10,
      life: 20,
      fadeType: 0,
    });
  }
  private genBubbles(): void {
    if (Math.floor(Math.random() * Math.max(1, this.ctx.spriteCount())) >= 15) return;
    const sprite = makeSprite(this.ctx.assets.partBubble);
    sprite.anchor.set(0.5);
    this.ctx.underPartsLayer.addChild(sprite);
    const c = 0.1 + Math.random() * 0.2;
    makePart(this.ctx, {
      kind: 'phys',
      view: sprite,
      x: this.view.x + (Math.random() * 2 - 1) * 4,
      y: this.view.y + (Math.random() * 2 - 1) * 4,
      vx: c * this.vx,
      vy: c * this.vy,
      weight: -(0.1 + Math.random() * 0.2),
      timer: 10 + Math.random() * 20,
      life: 30,
      fadeType: 0,
      scale: 50 + Math.random() * 100,
    });
  }

  destroy(): void {
    this.kill();
    if (this.ctx.balls.length === 0) {
      this.ctx.initGameOver();
    }
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    const i = this.ctx.balls.indexOf(this);
    if (i >= 0) this.ctx.balls.splice(i, 1);
    this.view.removeFromParent();
  }
}

// Num.hMod equivalent — wraps a value into the symmetric (-m, m] range.
function hMod(a: number, m: number): number {
  const t = ((a % (m * 2)) + m * 2) % (m * 2);
  return t > m ? t - m * 2 : t;
}
