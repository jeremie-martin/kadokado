// Events — port of Event.hx + ev/{Wave,Javelot,Quasar,Unification}.hx.
//
// All events live in ctx.events and tick once per frame via update(). They
// kill themselves by calling ctx.events.splice and removing their visuals.

import { Container, Sprite } from 'pixi.js';
import type { GameContext } from './game-context';
import { BH, BW, MCW, XMAX, YMAX, getPX, getX, getY } from './constants';
import { makeSprite } from '../_shared/frames';
import { makePart, setColor } from './fx';
import type { Block } from './block';

export abstract class Event {
  ctx: GameContext;
  alive = true;
  constructor(ctx: GameContext) {
    this.ctx = ctx;
    ctx.events.push(this);
  }
  abstract update(): void;
  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    const i = this.ctx.events.indexOf(this);
    if (i >= 0) this.ctx.events.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------
// Wave — horizontal wave descending top-to-bottom; damages all blocks per row.
// Speed: 2 cells per frame.
// ---------------------------------------------------------------------------

export class Wave extends Event {
  view: Sprite;
  yCell: number;

  constructor(ctx: GameContext) {
    super(ctx);
    this.yCell = YMAX - 1;
    this.view = makeSprite(ctx.assets.wave);
    this.view.anchor.set(0.5, 0);
    this.view.x = MCW * 0.5;
    this.view.y = getY(this.yCell);
    ctx.partsLayer.addChild(this.view);
  }

  update(): void {
    for (let i = 0; i < 2; i += 1) {
      this.yCell -= 1;
      for (let x = 0; x < XMAX; x += 1) {
        const bl = this.yCell >= 0 && this.yCell < YMAX ? this.ctx.grid[x][this.yCell] : null;
        if (bl) bl.damage(null, 0, 1);
      }
    }
    this.view.y = getY(this.yCell);
    if (this.yCell < -2) this.kill();
  }

  kill(): void {
    this.view.removeFromParent();
    super.kill();
  }
}

// ---------------------------------------------------------------------------
// Javelot — vertical column descending; explodes blocks in that column.
// Speed: 5 cells per frame.
// ---------------------------------------------------------------------------

export class Javelot extends Event {
  view: Sprite;
  xCell: number;
  yCell: number;
  static SPEED = 5;

  constructor(ctx: GameContext) {
    super(ctx);
    this.xCell = getPX(ctx.pad.x);
    this.yCell = YMAX + 4;
    this.view = makeSprite(ctx.assets.javelot);
    this.view.anchor.set(0.5, 1);
    this.view.x = getX(this.xCell + 0.5);
    this.view.y = getY(this.yCell);
    this.view.blendMode = 'add';
    // Source `ev/Javelot.hx:26` calls `dm.under(mcJavelot)` which moves the
    // javelot column to the BOTTOM of the DP_PAD plan so it slides behind the
    // pad sprite. R22: re-parent at index 0 of padLayer.
    ctx.padLayer.addChildAt(this.view, 0);
  }

  update(): void {
    for (let i = 0; i < Javelot.SPEED; i += 1) {
      this.yCell -= 1;
      const xClamped = this.xCell;
      const bl = this.yCell >= 0 && this.yCell < YMAX && xClamped >= 0 && xClamped < XMAX
        ? this.ctx.grid[xClamped][this.yCell]
        : null;
      if (bl) bl.explode();
    }
    this.view.y = getY(this.yCell);

    // Trailing light particles.
    const max = Math.floor(3 + Math.max(0, 1 - this.ctx.spriteCount() / 120) * 8);
    const hh = BH * Javelot.SPEED;
    for (let i = 0; i < max; i += 1) {
      const sp = makeSprite(this.ctx.assets.partLight);
      sp.anchor.set(0.5);
      this.ctx.partsLayer.addChild(sp);
      makePart(this.ctx, {
        kind: 'phys',
        view: sp,
        x: this.view.x + (Math.random() * 2 - 1) * 10,
        y: this.view.y + Math.random() * hh,
        vy: -Math.random() * hh * 0.75,
        timer: 10 + Math.random() * 20,
        life: 30,
      });
    }

    if (this.yCell < -14) this.kill();
  }

  kill(): void {
    this.view.removeFromParent();
    super.kill();
  }
}

// ---------------------------------------------------------------------------
// Quasar — area-of-effect implosion. Spawns at center, pulls all blocks
// within RAY=100 toward center over ~60 frames. Blocks become "block ghosts"
// that drift in; on kill, total score is awarded as one popup.
// ---------------------------------------------------------------------------

type QuasarPart = {
  view: Container;
  body: Sprite;
  a: number;
  c: number;
  cs: number;
  speed: number;
  acc: number;
  scale: number;
  flBlock: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  timer: number;
  fadeType: number;
  // Original color (used to fade-to-black via per-channel scaling — matches
  // source's `Col.setPercentColor(p.root, (1-c)*100, 0)` which interpolates
  // each channel toward black as c decreases. Default 0xFFFFFF for non-block
  // light-burst parts (their tint is the partLight texture default white).
  color: number;
};

function makeBlockGhostBody(ctx: GameContext, bl: Block): Sprite {
  let frame = ctx.assets.block[0];
  if (bl.type < 5) {
    const lifeFrames = ctx.assets.blockLife;
    const idx = Math.max(0, Math.min(Math.floor(bl.life), lifeFrames.length - 1));
    frame = lifeFrames[idx] ?? frame;
  } else if (bl.type <= 12) {
    frame = ctx.assets.block[Math.max(0, Math.min(bl.type - 9, ctx.assets.block.length - 1))] ?? frame;
  } else {
    frame = ctx.assets.block[Math.max(0, Math.min(bl.type - 8, ctx.assets.block.length - 1))] ?? frame;
  }
  const body = makeSprite(frame);
  setColor(body, bl.color);
  return body;
}

export class Quasar extends Event {
  static RAY = 100;
  centerView: Sprite;
  cx: number;
  cy: number;
  list: QuasarPart[] = [];
  timer = 60;
  score = 0;

  constructor(ctx: GameContext) {
    super(ctx);
    this.centerView = makeSprite(ctx.assets.quasar);
    this.centerView.anchor.set(0.5);
    this.cx = MCW * 0.5;
    this.cy = 100;
    this.centerView.x = this.cx;
    this.centerView.y = this.cy;
    this.centerView.scale.set(0);
    ctx.underPartsLayer.addChild(this.centerView);

    // Capture all blocks within radius and convert to ghost particles.
    for (let x = 0; x < XMAX; x += 1) {
      for (let y = 0; y < YMAX; y += 1) {
        const bl = ctx.grid[x][y];
        if (!bl) continue;
        const blx = getX(x + 0.5);
        const bly = getY(y + 0.5);
        const dx = blx - this.cx;
        const dy = bly - this.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= Quasar.RAY) continue;
        this.score += bl.score;
        // Build ghost wrapper.
        const wrapper = new Container();
        const body = makeBlockGhostBody(ctx, bl);
        body.x = -BW * 0.5;
        body.y = -BH * 0.5;
        body.width = BW;
        body.height = BH;
        wrapper.addChild(body);
        ctx.underPartsLayer.addChild(wrapper);
        const part = this.newPart(wrapper, body, blx, bly);
        part.flBlock = true;
        part.color = bl.color;
        bl.kill();
      }
    }
  }

  private newPart(view: Container, body: Sprite, x: number, y: number): QuasarPart {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const a = Math.atan2(dy, dx);
    const part: QuasarPart = {
      view,
      body,
      a: a + 1.57,
      c: 0.05,
      cs: 0.003,
      speed: 0,
      acc: 0.2,
      scale: 100,
      flBlock: false,
      x,
      y,
      vx: 0,
      vy: 0,
      timer: 60,
      fadeType: 0,
      color: 0xffffff,
    };
    view.x = x;
    view.y = y;
    this.list.push(part);
    return part;
  }

  update(): void {
    this.centerView.rotation += 0.0174;
    this.timer -= this.ctx.tmod;
    let c = this.timer / 10;

    const lst = this.list.slice();
    for (const p of lst) {
      const dx = this.cx - p.x;
      const dy = this.cy - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const ta = Math.atan2(dy, dx);
      p.c = Math.min(p.c + p.cs * this.ctx.tmod, 1);
      p.speed = Math.min(p.speed + p.acc * this.ctx.tmod, 5);
      const da = hMod(ta - p.a, Math.PI);
      p.a += da * p.c * this.ctx.tmod;
      p.vx = Math.cos(p.a) * p.speed;
      p.vy = Math.sin(p.a) * p.speed;

      const ds = Math.min(dist, p.scale) - p.scale;
      p.scale = p.scale + ds * 0.1 * this.ctx.tmod;
      p.view.scale.set(Math.max(0.01, p.scale / 100));

      // Block ghosts darken toward black with timer (R26: was alpha-fade —
      // documented as approximation. Source `Col.setPercentColor(p.root,
      // (1-c)*100, 0)` scales each channel of the original color toward 0
      // (black) as c→0, no alpha change. Pixi `tint` multiplies the texture
      // by tint/255 so setting tint = originalColor * c reproduces that
      // exactly while leaving alpha at 1).
      if (c < 1 && p.flBlock) {
        const t = Math.max(0, c);
        const r = Math.floor(((p.color >> 16) & 0xff) * t);
        const g = Math.floor(((p.color >> 8) & 0xff) * t);
        const b = Math.floor((p.color & 0xff) * t);
        p.body.tint = (r << 16) | (g << 8) | b;
      }

      p.x += p.vx * this.ctx.tmod;
      p.y += p.vy * this.ctx.tmod;
      p.view.x = p.x;
      p.view.y = p.y;

      if (!p.flBlock && dist < 20) {
        p.view.removeFromParent();
        const i = this.list.indexOf(p);
        if (i >= 0) this.list.splice(i, 1);
      }
    }

    // Burst extra light particles inwards.
    const burstCount = Math.max(0, Math.floor(this.timer / 20));
    for (let i = 0; i < burstCount; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 150;
      const x = this.cx + Math.cos(a) * r;
      const y = this.cy + Math.sin(a) * r;
      const sp = makeSprite(this.ctx.assets.partLight);
      sp.anchor.set(0.5);
      this.ctx.partsLayer.addChild(sp);
      // Wrap in a Container so it can be a QuasarPart-style ghost.
      const wrapper = new Container();
      wrapper.addChild(sp);
      this.ctx.partsLayer.addChild(wrapper);
      const p = this.newPart(wrapper, sp, x, y);
      p.acc = 0.4;
      p.cs = 0.001;
    }

    if (this.timer > 50) c = 1 - (this.timer - 50) / 10;
    if (c < 1) this.centerView.scale.set(c);

    if (this.timer < 0) this.kill();
  }

  kill(): void {
    this.ctx.displayScore(this.cx, this.cy, this.score, undefined, 1.5);
    this.ctx.addScore(this.score);
    // Source kills flBlock parts immediately and lets non-flBlock light bursts
    // fade out via Phys timer (they remain on the global sprite list). Port
    // doesn't run them through ctx.particles, so we'd orphan their views; clean
    // them up here to avoid leaks. Visual diff: light bursts disappear with the
    // Quasar instead of fading over ~10 frames. Acceptable.
    while (this.list.length > 0) {
      const p = this.list.pop();
      if (p) p.view.removeFromParent();
    }
    this.centerView.removeFromParent();
    super.kill();
  }
}

// ---------------------------------------------------------------------------
// Unification — expanding-circle wave from upper-left; converts all blocks
// to bonus type 10 (greenish). Expands at 0.2 cells/frame.
// ---------------------------------------------------------------------------

type UnifEntry = { bl: Block; ray: number };

export class Unification extends Event {
  cx: number;
  cy: number;
  ray = 0;
  list: UnifEntry[] = [];

  constructor(ctx: GameContext) {
    super(ctx);
    this.cx = XMAX * 0.5;
    this.cy = 5;
    for (const bl of ctx.blocks) {
      const dx = bl.x - this.cx;
      const dy = bl.y - this.cy;
      this.list.push({ bl, ray: Math.sqrt(dx * dx + dy * dy) });
    }
  }

  update(): void {
    this.ray += 0.2 * this.ctx.tmod;
    const a = this.list.slice();
    for (const o of a) {
      if (o.ray < this.ray) {
        const i = this.list.indexOf(o);
        if (i >= 0) this.list.splice(i, 1);
        o.bl.setType(10);
      }
    }

    const max = Math.floor(2 + Math.max(0, 1 - this.ctx.spriteCount() / 120) * 14);
    const rdec = Math.random();
    // Source `ev/Unification.hx:45` attaches `partTwinkle` with default frame
    // 1 — Flash's MovieClip auto-play loops through the 6-frame timeline at
    // SWF FPS. Port wires the frame list into the looped twinkle stepper
    // added in R16 so the Unification ring sparkles cycle through all six
    // partTwinkle frames instead of holding frame 0 throughout the 20-frame
    // particle lifetime.
    const twinkleFrames = this.ctx.assets.partTwinkle;
    for (let i = 0; i < max; i += 1) {
      const ang = (rdec + (i / max - 1)) * Math.PI * 2;
      const sp = makeSprite(twinkleFrames[0]);
      sp.anchor.set(0.5);
      this.ctx.partsLayer.addChild(sp);
      makePart(this.ctx, {
        kind: 'twinkle',
        view: sp,
        x: getX(this.cx + 0.5 + Math.cos(ang) * (this.ray + 1)),
        y: getY(this.cy + 0.5 + Math.sin(ang) * (this.ray + 1)),
        timer: 10 + Math.random() * 10,
        life: 20,
        fadeType: 0,
        frames: twinkleFrames,
        frameSprite: sp,
        frameAcc: 0,
      });
    }

    if (this.list.length === 0) this.kill();
  }
}

// Num.hMod — wraps `a` into (−m, m].
function hMod(a: number, m: number): number {
  const t = ((a % (m * 2)) + m * 2) % (m * 2);
  return t > m ? t - m * 2 : t;
}
