// Pad — port of Pad.hx.
//
// 7 types: STANDARD, GLUE, TIME (slow-mo), LASER, PROTECTION, AIMANT, SHAKE.
// Power bar (0..1) recharges per type-specific recovery rate; some actions
// consume power. The SWF exports `mcPad` as a wrapper around three anonymous
// subclips: side0/side1 (`DefineSprite_119`) and mid (`DefineSprite_127`).
// The power bar is the nested `mid.smc` sprite (`DefineSprite_124`), scaled
// independently of the mid stretch just like `skin.mid.smc._xscale`.

import { ColorMatrixFilter, Container, type ColorMatrix, type Sprite } from 'pixi.js';
import type { GameContext } from './game-context';
import {
  BH,
  MCW,
  PAD_AIMANT,
  PAD_GLUE,
  PAD_LASER,
  PAD_PROTECTION,
  PAD_SHAKE,
  PAD_SIDE,
  PAD_SPEED,
  PAD_STANDARD,
  PAD_TIME,
  PAD_DY,
  SIDE,
  YMAX,
  getY,
} from './constants';
import { makeSprite, setFrame } from '../_shared/frames';
import { makePart } from './fx';

export class Pad {
  ctx: GameContext;
  view: Container;

  // 3-piece skin.
  midBody: Sprite; // stretched mid section
  powerSprite: Sprite; // nested `mid.smc` bar, scaled from center.
  private readonly powerColorFilter: ColorMatrixFilter;
  side0: Sprite;
  side1: Sprite;
  protectionView: Container | null = null;

  ray = 36;
  type = PAD_STANDARD;
  moveFactor: 1 | -1 = 1;

  flGo = false;
  flStop = false;
  flProtect = false;
  flMouse = false;
  padec: number | null = null;

  power: number | null = null;
  recovery = 0.01;

  // External keyboard state — pad input is shared with Game (set in index.ts).
  keys = { left: false, right: false };
  mouseX: number | null = null; // screen-space mouse x (or null when none)

  // Position fields (replacement for Sprite.x/y in source).
  x = 0;
  y = 0;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.view = new Container();
    ctx.padLayer.addChild(this.view);

    this.side0 = makeSprite(ctx.assets.padSide[0]);
    this.view.addChild(this.side0);

    this.side1 = makeSprite(ctx.assets.padSide[0]);
    this.side1.scale.x = -1;
    this.view.addChild(this.side1);

    this.midBody = makeSprite(ctx.assets.padMid[0]);
    this.view.addChild(this.midBody);

    this.powerSprite = makeSprite(ctx.assets.padPower);
    this.powerSprite.visible = false;
    this.powerColorFilter = new ColorMatrixFilter();
    this.powerSprite.filters = [this.powerColorFilter];
    this.view.addChild(this.powerSprite);

    this.y = getY(YMAX + PAD_DY);
    this.x = MCW * 0.5;
    this.flMouse = false;
    this.init();
  }

  init(): void {
    this.flGo = false;
    this.flStop = false;
    this.flProtect = false;
    this.power = null;
    this.moveFactor = 1;
    this.setRay(36);
    this.setType(PAD_STANDARD);
  }

  update(): void {
    this.move();
    if (this.power !== null) this.updatePower();
    if (this.ctx.flPress) this.salve();

    switch (this.type) {
      case PAD_AIMANT: {
        for (const b of this.ctx.balls) {
          if (b.vy > 0 && b.type !== 4 /* KAMIKAZE */ && b.type !== 7 /* SHADE */ && b.view.y < this.y) {
            let a = Math.atan2(b.vy, b.vx);
            const dx = this.x - b.view.x;
            const dy = this.y - b.view.y;
            const ta = Math.atan2(dy, dx);
            const dist = Math.sqrt(dx * dx + dy * dy);
            a += hMod(ta - a, Math.PI) * 0.25;
            b.vx = Math.cos(a) * b.speed;
            b.vy = Math.sin(a) * b.speed;
            if (dist < 150 && Math.random() * dist < 30) {
              const sp = makeSprite(this.ctx.assets.partLine);
              sp.anchor.set(0, 0.5);
              this.ctx.partsLayer.addChild(sp);
              const ec = 12;
              makePart(this.ctx, {
                kind: 'attract',
                view: sp,
                x: b.view.x + (Math.random() * 2 - 1) * ec,
                y: b.view.y + (Math.random() * 2 - 1) * ec,
                dx: (Math.random() * 2 - 1) * this.ray,
                timer: 30,
                life: 30,
              });
            }
          }
        }
        this.queue('green', 100);
        break;
      }
      case PAD_SHAKE: {
        this.x += (Math.random() * 2 - 1) * 14;
        this.queue('pink', 15);
        break;
      }
      default:
        break;
    }

    // Side recall (clamp to playfield) when not exiting.
    if (!this.flGo) {
      const r = this.ray + SIDE - 1;
      this.x = Math.max(r, Math.min(this.x, MCW - r));
    }
    this.updatePos();
  }

  private move(): void {
    if (this.flGo) {
      this.x += 3;
      if (this.x > MCW + this.ray + 2) this.ctx.leaveLevel();
      if (this.flProtect) this.removeProtection();
      return;
    }

    let inc: number | null = null;
    if (this.keys.left) inc = -1;
    if (this.keys.right) inc = 1;
    if (inc !== null) {
      this.flMouse = false;
      this.x += inc * PAD_SPEED * this.moveFactor * this.ctx.tmod;
    }
    if (this.flMouse && this.mouseX !== null) {
      const c = (this.mouseX / MCW) * 2 - 1;
      this.x = MCW * (0.5 + this.moveFactor * c * 0.5);
    }

    if (this.flProtect && this.power !== null) {
      this.power = Math.max(this.power - 0.04, 0);
      this.displayPowerBar();
      if (this.power === 0) {
        this.removeProtection();
        this.powerSprite.alpha = 0.5;
      }
    }
  }

  private initPower(): void {
    this.power = 1;
    this.powerSprite.visible = true;
    this.powerSprite.alpha = 1;
    this.displayPowerBar();
  }
  private updatePower(): void {
    if (this.power === null) return;
    if (this.power < 1) {
      this.power = Math.min(this.power + this.recovery * this.ctx.tmod, 1);
      this.displayPowerBar();
      if (this.power === 1) this.powerSprite.alpha = 1;
    }
  }
  private displayPowerBar(): void {
    if (this.power === null) return;
    this.powerSprite.scale.x = this.powerScaleBase() * this.power;
  }
  private powerScaleBase(): number {
    const w = this.ray - PAD_SIDE;
    return (w * 2) / Math.max(1, this.powerSprite.texture.width);
  }

  action(): void {
    switch (this.type) {
      case PAD_TIME:
        if (this.power === 1) this.flStop = true;
        break;
      case PAD_PROTECTION:
        if (this.power === 1) this.initProtection();
        break;
      case PAD_LASER: {
        const cost = 0.2;
        if (this.power !== null && this.power > cost) {
          this.power -= cost;
          for (let i = 0; i < 2; i += 1) {
            this.ctx.spawnLaser(this.x + (i * 2 - 1) * (this.ray - 9), this.y);
          }
        }
        break;
      }
      default:
        break;
    }
  }
  release(): void {
    if (this.type === PAD_TIME && this.flStop) {
      this.flStop = false;
      this.powerSprite.alpha = 0.5;
    }
  }
  salve(): void {
    for (const b of this.ctx.balls) b.gluePoint = null;
    if (this.type === PAD_TIME && this.flStop && this.power !== null) {
      this.power = Math.max(this.power - 0.03, 0);
      this.displayPowerBar();
      if (this.power === 0) this.release();
    }
  }

  private initProtection(): void {
    this.flProtect = true;
    const view = new Container();
    const sp = makeSprite(this.ctx.assets.protection[0]);
    sp.anchor.set(0.5, 0.5);
    view.addChild(sp);
    view.x = this.x;
    view.y = this.y + 5;
    // Source `Pad.hx:220` calls `dm.under(mcProtection)` which moves the dome
    // to the BOTTOM of the DP_PAD plan, rendering behind the pad sprite. R22:
    // re-parent at index 0 of padLayer instead of the default top-of-stack.
    this.ctx.padLayer.addChildAt(view, 0);
    this.protectionView = view;
  }
  private removeProtection(): void {
    this.flProtect = false;
    if (this.protectionView) {
      this.protectionView.removeFromParent();
      this.protectionView = null;
    }
  }

  setType(n: number): void {
    // Cleanup of previous type.
    switch (this.type) {
      case PAD_GLUE:
        for (const b of this.ctx.balls) b.gluePoint = null;
        break;
      case PAD_TIME:
        this.flStop = false;
        break;
      case PAD_PROTECTION:
        this.removeProtection();
        break;
      default:
        break;
    }
    this.type = n;
    this.setSkinFrames();
    this.power = null;
    this.powerSprite.visible = false;
    this.powerSprite.alpha = 1;

    // Haxe switches do not fall through: the empty GLUE/SHAKE cases in
    // Pad.hx are real no-ops. Only TIME/LASER/PROTECTION own `mid.smc`.
    switch (this.type) {
      case PAD_TIME:
        this.recovery = 0.01;
        this.setPowerColorTransform(0, 0, 0);
        this.initPower();
        break;
      case PAD_LASER:
        this.recovery = 0.007;
        this.setPowerColorTransform(-84, -24, 241);
        this.initPower();
        break;
      case PAD_PROTECTION:
        this.recovery = 0.01;
        this.setPowerColorTransform(125, -65, 199);
        this.initPower();
        break;
      default:
        break;
    }
  }

  private setSkinFrames(): void {
    const sideIdx = clampIndex(this.type, this.ctx.assets.padSide.length);
    setFrame(this.side0, this.ctx.assets.padSide[sideIdx]);
    setFrame(this.side1, this.ctx.assets.padSide[sideIdx]);
    this.side1.scale.x = -Math.abs(this.side1.scale.x || 1);

    if (this.type === PAD_TIME || this.type === PAD_LASER || this.type === PAD_PROTECTION) {
      setFrame(this.midBody, this.ctx.assets.padMidPowerBase);
    } else {
      const midIdx = clampIndex(this.type, this.ctx.assets.padMid.length);
      setFrame(this.midBody, this.ctx.assets.padMid[midIdx]);
    }
    this.midBody.tint = 0xffffff;
    this.side0.tint = 0xffffff;
    this.side1.tint = 0xffffff;
    this.setRay(this.ray);
  }

  private setPowerColorTransform(redAdd: number, greenAdd: number, blueAdd: number): void {
    const matrix: ColorMatrix = [
      1, 0, 0, 0, redAdd,
      0, 1, 0, 0, greenAdd,
      0, 0, 1, 0, blueAdd,
      0, 0, 0, 1, 0,
    ];
    this.powerColorFilter.matrix = matrix;
  }

  setRay(r: number): void {
    this.ray = r;
    const w = r - PAD_SIDE;
    this.midBody.scale.x = (w * 2) / Math.max(1, this.midBody.texture.width);
    this.midBody.scale.y = 1;
    this.midBody.x = -w;
    this.midBody.y = 0;
    this.powerSprite.x = 0;
    this.powerSprite.y = 5;
    this.powerSprite.scale.y = 1;
    this.powerSprite.scale.x = this.powerScaleBase() * (this.power ?? 1);
    this.side0.x = -r;
    this.side0.y = 0;
    this.side0.scale.x = Math.abs(this.side0.scale.x || 1);
    this.side0.scale.y = 1;
    this.side1.x = r;
    this.side1.y = 0;
    this.side1.scale.x = -Math.abs(this.side1.scale.x || 1);
    this.side1.scale.y = 1;
  }

  // FX: power-up flourish.
  powerUp(): void {
    for (let i = 0; i < 24; i += 1) {
      const sp = makeSprite(this.ctx.assets.partLineUp);
      sp.anchor.set(0.5, 1);
      this.ctx.partsLayer.addChild(sp);
      makePart(this.ctx, {
        kind: 'lineUp',
        view: sp,
        x: this.x + (Math.random() * 2 - 1) * this.ray,
        y: this.y,
        sleep: Math.random() * 5,
        timer: 10 + Math.random() * 20,
        life: 30,
        weight: -(0.1 + Math.random() * 0.3),
        factor: 3,
      });
      sp.blendMode = 'add';
    }
  }

  // queue() — paint pad-shaped brush into the plasma layer.
  // Original draws an mcGreenBar / mcPinkBar at pad position with set _alpha.
  private queue(kind: 'green' | 'pink', alpha: number): void {
    const frame = kind === 'green' ? this.ctx.assets.greenBar : this.ctx.assets.pinkBar;
    const sp = makeSprite(frame);
    sp.anchor.set(0.5, 0);
    sp.height = BH;
    sp.width = this.ray * 2;
    sp.x = this.x;
    sp.y = this.y;
    sp.alpha = alpha / 100;
    // Draw to plasma immediately, then discard.
    this.ctx.plasmaDraw(sp);
    sp.removeFromParent();
  }

  updatePos(): void {
    this.view.x = this.x;
    this.view.y = this.y;
    if (this.protectionView) {
      this.protectionView.x = this.x;
      this.protectionView.y = this.y + 5;
    }
  }

  // Used by safe-mode/colPad calculations elsewhere; expose padding helpers.
  destroy(): void {
    this.removeProtection();
    this.view.removeFromParent();
  }
}

// Num.hMod — wraps `a` into (−m, m] (matches the source helper used in colPad).
function hMod(a: number, m: number): number {
  const t = ((a % (m * 2)) + m * 2) % (m * 2);
  return t > m ? t - m * 2 : t;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Math.floor(index), Math.max(0, length - 1)));
}
