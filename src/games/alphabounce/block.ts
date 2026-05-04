// Block — port of Block.hx.
//
// Static grid element with type-driven life and scoring. Damage decrements
// life or freezes when an Ice ball hits; explode() spawns particles and
// (for normal blocks) may drop a power-up.

import { Container, Sprite } from 'pixi.js';
import type { FxParticle, GameContext } from './game-context';
import {
  BH,
  BW,
  BALL_ICE,
  MAX_OPTION,
  OPTION_COEF,
  SCORE_0,
  SCORE_BLOCK,
  SCORE_BONUS,
  SCORE_BOUNCE,
  SCORE_ICE,
  getX,
  getY,
} from './constants';
import { makeSprite, setFrame } from '../_shared/frames';
import { makePart, setColor, spawnBouncerPart, spawnMovieClip } from './fx';
import type { Ball } from './ball';

// Bonus type IDs are 10/11/12 (tier 0/1/2 bonus). Glass = 13.
const BONUS_BASE = 10;
const GLASS_TYPE = 13;

export class Block {
  ctx: GameContext;
  view: Container; // wraps the inner sprite (`mcBlock` skin)
  body: Sprite;
  iceOverlay: Sprite | null = null;
  blink: Sprite | null = null;
  blinkPart: FxParticle | null = null;
  blinkParts: FxParticle[] = [];

  x = 0;
  y = 0;
  type = 0;
  life = 0;
  score = 0;
  color = 0xffffff;
  flIce = false;
  flDeath = false;

  constructor(ctx: GameContext, px: number, py: number, t: number) {
    this.ctx = ctx;
    this.x = px;
    this.y = py;
    ctx.block += 1;
    ctx.blocks.push(this);
    ctx.grid[px][py] = this;

    this.view = new Container();
    this.body = makeSprite(ctx.assets.block[0]);
    // Stretch the block sprite to grid cell dimensions.
    this.body.width = BW;
    this.body.height = BH;
    this.view.addChild(this.body);
    this.view.x = getX(px);
    this.view.y = getY(py);
    ctx.blockLayer.addChild(this.view);

    this.setType(t);
  }

  setType(t: number): void {
    this.type = t;
    if (this.type < 10) {
      this.life = Math.min(this.type, 5);
      this.type = 0;
      this.color = this.ctx.bmpPaintGetPixel(this.x, this.y);
      this.score = SCORE_BLOCK;
    } else if (this.type <= 12) {
      const id = this.type - BONUS_BASE;
      this.score = SCORE_BONUS[id];
      this.life = 0;
      this.color = [0xb3fd02, 0x0bcdfd, 0xff5599][id];
    } else if (this.type === GLASS_TYPE) {
      this.life = 0;
      this.score = SCORE_0;
      this.color = 0xffffff;
    }
    this.setSkin();
  }

  setColor(col: number): void {
    this.color = col;
    setColor(this.body, col);
  }

  setLife(n: number): void {
    this.life = n;
    if (this.type < 5) {
      this.setSkin();
    } else if (this.color !== null) {
      this.setColor(this.color);
    }
  }

  setSkin(): void {
    const frames = this.ctx.assets.block;
    if (this.type < 5) {
      // Root mcBlock frame 1 contains `smc`; Block.hx drives
      // `root.smc.gotoAndStop(life+1)` for the five normal-block life skins.
      const lifeFrames = this.ctx.assets.blockLife;
      const idx = Math.max(0, Math.min(Math.floor(this.life), lifeFrames.length - 1));
      setFrame(this.body, lifeFrames[idx] ?? frames[0]);
    } else {
      let idx = this.type <= 12 ? (this.type - BONUS_BASE) + 1 : this.type - 8; // glass uses idx 5
      idx = Math.max(0, Math.min(idx, frames.length - 1));
      setFrame(this.body, frames[idx]);
    }
    this.body.width = BW;
    this.body.height = BH;
    setColor(this.body, this.color);
  }

  damage(_ball: Ball | null, ballType: number, ballDamage: number): void {
    // _ball is kept for API parity with the source signature (it consumed the
    // ball reference for chained collision logic we don't model here).
    if (this.flIce) {
      this.explode();
      return;
    }
    if (ballType === BALL_ICE) {
      this.iceIt();
      return;
    }
    const n = ballDamage;
    if (this.life >= n) {
      this.setLife(this.life - n);
      // mcBlink overlay — 9-frame self-playing MovieClip (round 11 fix).
      // Source's Block damage attaches `mcBlink` and lets the SWF timeline
      // play through 9 frames at engine rate (40 Hz ⇒ 0.225 s). Earlier port
      // wrapped a static frame[0] with alpha-fade for 6 frames, which was
      // both wrong duration and wrong visual. spawnMovieClip steps through
      // every frame at SWF rate, killing on overflow.
      //
      // Source attaches this directly on DP_BLOCK after the side clips and
      // copies `root._xscale/_yscale`; it is not squeezed into a 28x12 rect.
      // The frame loader uses mcBlink's Flash origin inside its exported sweep
      // bounds; otherwise the shine appears several cells to the right.
      const blinkPart = spawnMovieClip(
        this.ctx,
        this.ctx.blockOverlayLayer,
        this.ctx.assets.blink,
        this.view.x,
        this.view.y,
        { scale: { x: this.body.scale.x, y: this.body.scale.y } },
      );
      if (blinkPart) {
        this.blink = blinkPart.view as Sprite;
        this.blinkPart = blinkPart;
        this.blinkParts.push(blinkPart);
      }
      this.ctx.addScore(SCORE_BOUNCE);
    } else {
      this.explode();
    }
  }

  private iceIt(): void {
    this.type = 0;
    this.score = SCORE_ICE;
    this.flIce = true;
    const frames = this.ctx.assets.ice;
    if (frames.length === 0) return;
    const sp = makeSprite(frames[Math.floor(Math.random() * frames.length)]);
    const nx = Math.floor(Math.random() * 2);
    const ny = Math.floor(Math.random() * 2);
    sp.scale.set((nx * 2 - 1), (ny * 2 - 1));
    // Source uses hardcoded magic numbers 30 and 10 (not BW/BH), see Block.hx:138-139.
    sp.x = (1 - nx) * 30;
    sp.y = (1 - ny) * 10;
    this.view.addChild(sp);
    this.iceOverlay = sp;
  }

  explode(): void {
    this.ctx.addScore(this.score);
    const max = Math.max(2, Math.min(16, Math.floor(24 - this.ctx.spriteCount() * 0.25)));

    if (this.type < 5) {
      // Normal block — burst overlay with the block root's copied Flash scale,
      // then mcPart debris.
      // Source attaches a `partExplode` MovieClip (Block.hx:151-156) tinted to
      // the block colour. Its exported 45-frame timeline contains a blank tail
      // and a final reset-shaped frame after the SWF frame action, so the asset
      // loader keeps only the 23 visible playable frames. Round 11 replaces the
      // previous static frame[0] alpha-fade approximation with a true
      // MovieClip-style frame stepper that walks the visible frames at 40 Hz
      // (independent of tmod), killing on overflow. Frozen normal blocks still get
      // this burst in Block.hx, then add the ice-shard burst below.
      //
      // The source copies `root._xscale/_yscale` from the 28x12-scaled
      // mcBlock. The extracted partExplode frames preserve the Flash origin
      // inside a larger canvas, so preserving scale is visually different from
      // forcing 28x12 or treating the canvas top-left as the origin.
      spawnMovieClip(
        this.ctx,
        this.ctx.partsLayer,
        this.ctx.assets.partExplode,
        this.view.x,
        this.view.y,
        { tint: this.color, scale: { x: this.body.scale.x, y: this.body.scale.y } },
      );
      // Normal block — explode with mcPart debris (Bouncer-aware).
      for (let n = 0; n < max; n += 1) {
        const sp = makeSprite(this.ctx.assets.part);
        sp.anchor.set(0.5);
        sp.tint = this.color;
        this.ctx.partsLayer.addChild(sp);
        const cx = this.view.x + BW * 0.5;
        const cy = this.view.y + BH * 0.5;
        const px = getX(this.x + Math.random());
        const py = getY(this.y + Math.random());
        const dx = px - cx;
        const dy = py - cy;
        const a = Math.atan2(dy, dx);
        const sp2 = Math.sqrt(dx * dx + dy * dy) * 0.2;
        const part = spawnBouncerPart(this.ctx, sp, px, py);
        part.vx = Math.cos(a) * sp2;
        part.vy = Math.sin(a) * sp2;
        part.timer = 10 + Math.random() * 30;
        part.life = part.timer;
        part.weight = 0.05 + Math.random() * 0.1;
        part.fadeType = 0;
        part.frict = 0.98;
        part.scale = part.weight * 700;
      }
      // 20% drop chance for an Option (capped to MAX_OPTION on screen).
      if (Math.random() < OPTION_COEF && this.ctx.options.length < MAX_OPTION) {
        this.ctx.newOption(null, getX(this.x + 0.5), getY(this.y + 0.5));
      }
    } else if (this.type <= 12) {
      // Bonus block — radial twinkles.
      // Source `Block.hx:189` calls `gotoAndPlay(Std.random(2)+1)` on the
      // attached partTwinkle MovieClip, picking frame 1 or 2 (1-indexed) as
      // the starting point and letting Flash auto-play through the 6-frame
      // timeline (looping by default). Port now feeds the partTwinkle frame
      // list to the looped twinkle stepper added in R16; `frameAcc = 0 | 1`
      // matches the random start offset.
      const twinkleFrames = this.ctx.assets.partTwinkle;
      for (let i = 0; i < max; i += 1) {
        const startIdx = Math.floor(Math.random() * 2); // 0 or 1
        const sp = makeSprite(twinkleFrames[startIdx]);
        sp.anchor.set(0.5);
        sp.blendMode = 'add';
        this.ctx.partsLayer.addChild(sp);
        const a = (i / max) * Math.PI * 2;
        const ray = 5 + Math.random() * 20;
        makePart(this.ctx, {
          kind: 'twinkle',
          view: sp,
          x: getX(this.x + 0.5) + Math.cos(a) * ray,
          y: getY(this.y + 0.5) + Math.sin(a) * ray,
          timer: 10 + Math.random() * 10,
          life: 20,
          fadeType: 0,
          scale: 50 + Math.random() * 100,
          sleep: Math.random() * (ray - 5),
          vy: -Math.random(),
          frames: twinkleFrames,
          frameSprite: sp,
          frameAcc: startIdx,
        });
      }
    }

    // Glass block: spawn a new ball + glass shards.
    if (this.type === GLASS_TYPE) {
      const b = this.ctx.newBall();
      b.moveTo(this.view.x + BW * 0.5, this.view.y + BH * 0.5);
      b.setAngle(Math.random() * Math.PI * 2);
      for (let n = 0; n < max; n += 1) {
        const idx = Math.floor(Math.random() * this.ctx.assets.partGlass.length);
        const sp = makeSprite(this.ctx.assets.partGlass[idx]);
        sp.anchor.set(0.5);
        this.ctx.partsLayer.addChild(sp);
        const cx = this.view.x + BW * 0.5;
        const cy = this.view.y + BH * 0.5;
        const px = getX(this.x + Math.random());
        const py = getY(this.y + Math.random());
        const dx = px - cx;
        const dy = py - cy;
        const a = Math.atan2(dy, dx);
        const sp2 = Math.sqrt(dx * dx + dy * dy) * 0.2;
        // Source `Block.hx:205` sets `p.root._rotation = Math.random()*2-1;` —
        // `_rotation` is degrees in AS2/Flash, so this is a tiny ±1° tilt.
        // Earlier port assigned the value directly to Pixi's `sprite.rotation`
        // (radians), which spawned shards at up to ±57°. Convert via 0.0174
        // (deg→rad) to mirror source's near-upright initial pose.
        sp.rotation = (Math.random() * 2 - 1) * 0.0174;
        const part = spawnBouncerPart(this.ctx, sp, px, py);
        part.vx = Math.cos(a) * sp2;
        part.vy = Math.sin(a) * sp2;
        part.vr = (Math.random() * 2 - 1) * 12;
        part.timer = 10 + Math.random() * 30;
        part.life = part.timer;
        part.weight = 0.05 + Math.random() * 0.1;
        part.fadeType = 0;
        part.frict = 0.98;
        // Source `setScale(p.weight*700)` then `setScale(p.scale*(1+random*0.6))`
        // chains scale off the same `weight` value; earlier port drew a fresh
        // random for `baseScale`, decoupling shard size from its weight (and
        // therefore decoupling visual size from the per-frame gravity drop).
        part.scale = part.weight * 700 * (1 + Math.random() * 0.6);
      }
    }

    // Frozen block: extra ice-shard burst.
    if (this.flIce) {
      const iceMax = Math.floor(max * 0.5);
      for (let n = 0; n < iceMax; n += 1) {
        const sp = makeSprite(this.ctx.assets.partIceShard);
        sp.anchor.set(0.5);
        this.ctx.partsLayer.addChild(sp);
        const cx = this.view.x + BW * 0.5;
        const cy = this.view.y + BH * 0.5;
        const px = getX(this.x + Math.random());
        const py = getY(this.y + Math.random());
        const dx = px - cx;
        const dy = py - cy;
        const a = Math.atan2(dy, dx);
        const sp2 = Math.sqrt(dx * dx + dy * dy) * 0.2;
        sp.rotation = a;
        makePart(this.ctx, {
          kind: 'phys',
          view: sp,
          x: px,
          y: py,
          vx: Math.cos(a) * sp2,
          vy: Math.sin(a) * sp2,
          vr: (Math.random() * 2 - 1) * 6,
          timer: 10 + Math.random() * 30,
          life: 40,
          weight: (0.05 + Math.random() * 0.1) * 0.5,
          fadeType: 0,
          frict: 0.98,
        });
      }
    }

    // Score popup for >=200pt blocks.
    if (this.score >= 200) {
      const r = (this.color >> 16) & 0xff;
      const g = (this.color >> 8) & 0xff;
      const b = this.color & 0xff;
      const popupCol = ((Math.max(0, r - 100)) << 16) | ((Math.max(0, g - 100)) << 8) | Math.max(0, b - 100);
      this.ctx.displayScore(getX(this.x + 0.5), getY(this.y + 0.5), this.score, popupCol, 1);
    }

    this.kill();
  }

  kill(): void {
    if (this.flDeath) return;
    this.flDeath = true;
    this.ctx.removeBlock();
    if (this.blinkParts.length > 0) {
      for (const part of this.blinkParts) this.ctx.killPart(part);
      this.blinkParts = [];
      this.blinkPart = null;
      this.blink = null;
    } else if (this.blink) {
      this.blink.removeFromParent();
      this.blink = null;
    }
    this.ctx.grid[this.x][this.y] = null;
    const i = this.ctx.blocks.indexOf(this);
    if (i >= 0) this.ctx.blocks.splice(i, 1);
    this.view.removeFromParent();
  }
}
