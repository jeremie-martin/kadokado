// FX particle system — port of fx/Part, fx/LineUp, fx/Spark, fx/Attract.
//
// The original fx classes all extend mt.bumdum.Phys. We collapse them into a
// single FxParticle record (see game-context.ts) and dispatch behaviour per
// `kind` flag. Each Phys has timer/life/fadeType/fadeLimit/sleep/vx/vy/vr/
// weight/frict semantics — the loop below mirrors Phys.update.
//
// Cs.getPerfCoef() = max(0, 1 - sprites/120). We approximate via ctx.spriteCount().

import { Container, Sprite } from 'pixi.js';
import type { FxParticle, GameContext } from './game-context';
import { BH, BW, SIDE, getX, getY, haxeInt } from './constants';
import { type Frame, makeSprite, setFrame } from '../_shared/frames';

export function makePart(
  ctx: GameContext,
  partial: Partial<FxParticle> & Pick<FxParticle, 'kind' | 'view'>,
): FxParticle {
  const p: FxParticle = {
    kind: partial.kind,
    view: partial.view,
    x: partial.x ?? partial.view.x,
    y: partial.y ?? partial.view.y,
    vx: partial.vx ?? 0,
    vy: partial.vy ?? 0,
    vr: partial.vr ?? 0,
    weight: partial.weight ?? 0,
    frict: partial.frict ?? 1,
    timer: partial.timer ?? 15,
    life: partial.life ?? partial.timer ?? 15,
    sleep: partial.sleep ?? 0,
    fadeType: partial.fadeType ?? 0,
    // Source's mt.bumdum.Phys defaults fadeLimit = 10 (line 25 of Phys.hx).
    // Particles only fade during the last `fadeLimit` frames of their timer.
    // Earlier port defaulted to 0 and faded over the entire life — particles
    // fade-shrunk from spawn to death instead of staying solid until the
    // final approach. Restored to 10.
    fadeLimit: partial.fadeLimit ?? 10,
    scale: partial.scale ?? 100,
    factor: partial.factor ?? 1,
    dx: partial.dx ?? 0,
    bounce: partial.bounce ?? null,
    rotateToVel: partial.rotateToVel ?? false,
    plasma: partial.plasma ?? false,
    frames: partial.frames ?? null,
    frameSprite: partial.frameSprite ?? null,
    frameAcc: partial.frameAcc ?? 0,
    frameSize: partial.frameSize ?? null,
    frameScale: partial.frameScale ?? null,
    onKill: partial.onKill,
  };
  // Sync initial position.
  p.view.x = p.x;
  p.view.y = p.y;
  if (p.scale !== 100) {
    const s = p.scale / 100;
    p.view.scale.set(s, s);
  }
  ctx.particles.push(p);
  return p;
}

export function killPart(ctx: GameContext, p: FxParticle): void {
  const i = ctx.particles.indexOf(p);
  if (i >= 0) ctx.particles.splice(i, 1);
  p.view.removeFromParent();
  if (p.onKill) p.onKill();
}

export function updateParticles(ctx: GameContext): void {
  const tmod = ctx.tmod;
  for (let i = 0; i < ctx.particles.length; i += 1) {
    const p = ctx.particles[i];

    // Sleep before any motion. Source `Phys.update` (libs-haxe2 Phys.hx:36-44)
    // decrements `sleep` by exactly 1 per call (`sleep --`), independent of
    // `mt.Timer.tmod` — distinct from `Ball.update`'s tmod-scaled `sleep -=
    // tmod` (Ball.hx:48-52). The Phys variant is also distinct from physics
    // integration (which IS tmod-scaled) because Flash's MovieClip stop/play
    // gating sleeps until exactly N Flash ticks have elapsed regardless of
    // any per-frame integration multiplier the application uses (the same
    // Flash-runtime independence-from-tmod principle that R14 established
    // for `mc.play()` auto-advance). Earlier port subtracted `tmod`, which
    // stretched HALO 5-clone stagger ({2,5,8,11,14} frames), pad-powerUp
    // LineUp delays (`Math.random()*5` frames), and bonus-block twinkle
    // delays (`Math.random()*(ray-5)` ⇒ up to 15 frames) by 10× during
    // TIME-pad slow-mo (`tmod=0.1`).
    if (p.sleep > 0) {
      p.sleep -= 1;
      // Source `Phys.update` (Phys.hx:36-44) returns early during sleep, so
      // Phys integration (gravity, friction, position) is paused — but the
      // underlying Flash MovieClip auto-play is NOT gated by Phys.sleep. The
      // SWF runtime advances the timeline once per Flash tick regardless of
      // any per-frame Phys state, so a sleeping particle whose root is a
      // multi-frame MovieClip continues to cycle frames at SWF FPS while
      // staying stationary at its spawn position. R23: advance the looped
      // twinkle frame stepper during sleep so bonus-block partTwinkle
      // particles (`Block.hx:186` ⇒ `sleep = Math.random()*(ray-5)` ⇒ up to
      // ~15 frames of sleep with the per-call `gotoAndPlay(Std.random(2)+1)`
      // already started) keep cycling their 6-frame sparkle texture during
      // the sleep window. Earlier port held the texture at startIdx for the
      // entire sleep, then started cycling once sleep ended — visually,
      // sparkles "appeared frozen at spawn, then started animating after
      // delay" instead of "animated sparkles spawn, then start moving." The
      // `'movie'` kind's callers (mcBlink/mcOnde/partExplode) never set
      // sleep>0 in current usage so the behavioural difference is restricted
      // to the bonus-block twinkle path. Sleep itself is still tmod-
      // independent (R18), and Phys integration remains paused.
      if (p.kind === 'twinkle' && p.frames && p.frameSprite) {
        p.frameAcc += 1;
        const idx = Math.floor(p.frameAcc) % p.frames.length;
        setFrame(p.frameSprite, p.frames[idx]);
        if (p.frameSize) {
          p.frameSprite.width = p.frameSize.w;
          p.frameSprite.height = p.frameSize.h;
        }
        if (p.frameScale) p.frameSprite.scale.set(p.frameScale.x, p.frameScale.y);
      }
      continue;
    }

    // Type-specific pre-step (only kinds that REPLACE physics integration go
    // here; other kinds just observe vx/vy after standard update).
    switch (p.kind) {
      case 'attract': {
        // Move toward (pad.x+dx, pad.y) by 0.3, then derive xscale & rotation.
        const oldX = p.x;
        const oldY = p.y;
        const tx = ctx.pad.x + p.dx;
        const ty = ctx.pad.y;
        p.x += (tx - p.x) * 0.3;
        p.y += (ty - p.y) * 0.3;
        const vx = p.x - oldX;
        const vy = p.y - oldY;
        const vit = Math.sqrt(vx * vx + vy * vy);
        const a = Math.atan2(vy, vx);
        p.view.scale.set(Math.max(0.01, vit / 100), p.view.scale.y);
        p.view.rotation = a;
        const dist = Math.hypot(tx - p.x, ty - p.y);
        if (dist < 5) {
          killPart(ctx, p);
          i -= 1;
          continue;
        }
        break;
      }
      case 'spark': {
        const vit = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        const a = Math.atan2(p.vy, p.vx);
        p.view.scale.x = Math.max(0.01, vit / 100);
        p.view.rotation = a;
        break;
      }
      case 'lineUp':
      default:
        break;
    }

    // Standard Phys update (gravity, friction, position integration).
    // Source `Phys.update` (Phys.hx:50-54) applies friction as
    // `f = Math.pow(frict, mt.Timer.tmod); vx *= f; vy *= f` — i.e. the
    // friction coefficient is exponentiated by `tmod` so that slow-mo
    // (`tmod=0.1`) attenuates each frame's drag accordingly. Earlier port
    // multiplied by raw `p.frict`, which under TIME-pad slow-mo (tmod=0.1)
    // hit Ball.genSparks's `frict=0.95` and Block.initExplode's `frict=0.98`
    // particles ~10× harder than source (e.g. 0.95 vs 0.995), causing
    // explosion debris and sparks to brake far more aggressively under
    // slow-mo than the source intended. With default `frict=1`, both forms
    // are identical, so the fix is a no-op outside the explicit `frict<1`
    // call sites.
    p.vy += p.weight * tmod;
    const f = p.frict === 1 ? 1 : Math.pow(p.frict, tmod);
    p.vx *= f;
    p.vy *= f;
    if (p.kind === 'part' && p.bounce) {
      // fx.Part overrides Phys.update: undoes the Phys position step then runs
      // the Bouncer (grid-aware stepping) which writes back its own x, y.
      // We model this by NOT applying the integration step for Part — bouncer
      // is the sole position authority. See Part.hx:14-21.
      stepBouncer(ctx, p);
      p.view.x = p.x;
      p.view.y = p.y;
    } else {
      p.x += p.vx * tmod;
      p.y += p.vy * tmod;
      p.view.x = p.x;
      p.view.y = p.y;
    }
    p.view.rotation += p.vr * tmod * 0.0174;

    // LineUp post-step moved after the Phys fade block (R17): source's
    // `fx.LineUp.update` calls `super.update()` first (which runs Phys's
    // fade-window scale-shrink for fadeType=0) and then overwrites
    // `root._xscale`/`_yscale` with velocity-derived values, so the fade
    // never reaches the LineUp sprite. Earlier port ran LineUp before fade,
    // letting the fade clobber the velocity-derived streak with `c*scale` —
    // the 24× pad powerUp burst and 16× option-pickup streaks shrank to a
    // 1×-baseline dot during the final 10 frames of life instead of holding
    // their horizontal streak. See block at the bottom of the per-particle
    // loop for the relocated assignment.

    // Movie-clip stepper. Advances the sprite's texture through the supplied
    // frame list at engine rate — exactly 1 frame per `step_()` tick,
    // independent of `tmod`. Source's `mc.play()` (Flash MovieClip auto-play)
    // advances at the SWF frame rate regardless of `mt.Timer.tmod`: line 142
    // of Game.hx assigns `tmod = timeCoef` for physics integration only, but
    // MovieClip frame advancement is wallclock-bound to the SWF FPS and not
    // gated by tmod. Earlier rounds (R11) tied `frameAcc += tmod` which made
    // partExplode/mcBlink/mcOnde all 10× longer than source during TIME-pad
    // slow-mo (`tmod=0.1`). The clip plays once and the particle is killed
    // when the timeline ends — SWF MovieClips remove themselves at the last
    // frame and don't loop.
    if (p.kind === 'movie' && p.frames && p.frameSprite) {
      p.frameAcc += 1;
      const idx = Math.floor(p.frameAcc);
      if (idx >= p.frames.length) {
        killPart(ctx, p);
        i -= 1;
        continue;
      }
      setFrame(p.frameSprite, p.frames[idx]);
      if (p.frameSize) {
        p.frameSprite.width = p.frameSize.w;
        p.frameSprite.height = p.frameSize.h;
      }
      if (p.frameScale) p.frameSprite.scale.set(p.frameScale.x, p.frameScale.y);
      // Movie clips skip the timer/fade path — frameAcc is the timeline.
      continue;
    }

    // Looped frame stepper for `'twinkle'` particles. Source's bonus-block
    // explode (`Block.hx:189`) attaches `partTwinkle` and calls
    // `gotoAndPlay(Std.random(2)+1)` — a Flash MovieClip auto-play with a
    // random initial offset of frame 1 or 2. Source's Unification event
    // (`ev/Unification.hx:45`) attaches `partTwinkle` with default frame 1.
    // Both rely on Flash's default MovieClip looping — the 6-frame timeline
    // cycles repeatedly through the particle's 10-20 frame Phys lifetime.
    // Earlier port rendered a static frame[0] (or `i % 6`), so bonus-block
    // shatters and Unification rings showed only one of the six twinkle
    // shapes. Looping at engine rate (no `tmod` gating, R14 model) restores
    // the cycling sparkle. The Phys timer/fade path still runs below; this
    // only swaps the sprite's texture each tick.
    if (p.kind === 'twinkle' && p.frames && p.frameSprite) {
      p.frameAcc += 1;
      const idx = Math.floor(p.frameAcc) % p.frames.length;
      setFrame(p.frameSprite, p.frames[idx]);
      if (p.frameSize) {
        p.frameSprite.width = p.frameSize.w;
        p.frameSprite.height = p.frameSize.h;
      }
      if (p.frameScale) p.frameSprite.scale.set(p.frameScale.x, p.frameScale.y);
    }

    p.timer -= tmod;
    if (p.timer <= 0) {
      killPart(ctx, p);
      i -= 1;
      continue;
    }

    // Phys fade semantics (Phys.hx:66-95): only fade once timer < fadeLimit;
    // c = timer/fadeLimit ramps from 1 → 0 over the final fadeLimit frames.
    // fadeType 0 ⇒ scale-shrink (root._xscale = c*scale); default ⇒ alpha-fade
    // (root._alpha = c*alpha). Port-specific particles that need full-life
    // fade pass fadeLimit equal to their timer.
    if (p.timer < p.fadeLimit) {
      const tlife = Math.max(0, p.timer / p.fadeLimit);
      if (p.fadeType === 0) {
        const baseScale = p.scale / 100;
        p.view.scale.set(baseScale * tlife, baseScale * tlife);
      } else {
        p.view.alpha = Math.max(0, tlife);
      }
    }

    // R17: LineUp's velocity-derived xscale/yscale runs LAST so it overwrites
    // any fade-window scale set by the Phys fadeType=0 branch above. Mirrors
    // source's `fx.LineUp.update` ordering (Phys super first, LineUp scale
    // assignment second).
    if (p.kind === 'lineUp') {
      let xs = -100 * p.factor * p.vx;
      let ys = -100 * p.factor * p.vy;
      if (Math.abs(xs) < 100) xs = 100;
      if (Math.abs(ys) < 100) ys = 100;
      p.view.scale.set(xs / 100, ys / 100);
    }

    if (p.plasma) ctx.plasmaDraw(p.view);
  }
}

function stepBouncer(ctx: GameContext, p: FxParticle): void {
  // Port of Bouncer.update — grid-aware bouncing for explosion debris.
  // Operates on (px, py, ox, oy) in p.bounce; outputs into p.x / p.y.
  if (!p.bounce) return;
  const tmod = ctx.tmod;
  let parc = 1;
  let vvx = p.vx * tmod;
  let vvy = p.vy * tmod;
  let safety = 0;
  while (parc > 0 && safety < 16) {
    safety += 1;
    let cx: number;
    let cy: number;
    if (vvx > 0) cx = (BW - p.bounce.ox) / vvx;
    else if (vvx < 0) cx = p.bounce.ox / vvx;
    else cx = 1;
    if (vvy > 0) cy = (BH - p.bounce.oy) / vvy;
    else if (vvy < 0) cy = p.bounce.oy / vvy;
    else cy = 1;

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
    p.bounce.ox += vvx * c;
    p.bounce.oy += vvy * c;
    parc -= c;

    if (flCheck) {
      // Source `Bouncer.update` (Bouncer.hx:80-93) flips velocity with
      // `vvx *= -frict; sp.vx *= -frict;` where `frict` is the *Bouncer*'s
      // own field, initialised to 1 in `Bouncer.new` (Bouncer.hx:17) and
      // never reassigned by any Alphabounce caller. The Phys's `p.frict`
      // (set to 0.98 in Block.initExplode and 0.95 in Ball.genSparks) is
      // a *separate* field used only by `Phys.update` for per-frame drag
      // (`vx *= pow(frict, tmod)`, R18 fix). Earlier port conflated the
      // two by passing `p.frict` to the bouncer collision flip, so block-
      // explosion debris (`frict=0.98`) and ball spark bouncer-debris
      // bounced inelastically off grid cells (~2% energy loss per bounce)
      // instead of perfectly elastic. Visual: explosion shrapnel that
      // ricocheted off a neighboring block lost speed at every bounce,
      // making compact debris piles fall faster than source's source's
      // bouncier shrapnel pattern. Bouncer's own frict is always 1, so
      // the flip is a pure sign-reversal — Phys integration still applies
      // the per-tick drag correctly via `pow(0.98, tmod)`.
      if (sx !== null) {
        if (ctx.isFree(p.bounce.px + sx, p.bounce.py)) {
          p.bounce.px += sx;
          p.bounce.ox -= sx * BW;
        } else {
          vvx = -vvx;
          p.vx = -p.vx;
        }
      }
      if (sy !== null) {
        if (ctx.isFree(p.bounce.px, p.bounce.py + sy)) {
          p.bounce.py += sy;
          p.bounce.oy -= sy * BH;
        } else {
          vvy = -vvy;
          p.vy = -p.vy;
        }
      }
    }
  }
  p.x = getX(p.bounce.px) + p.bounce.ox;
  p.y = getY(p.bounce.py) + p.bounce.oy;
}

// Helper: spawn a self-playing MovieClip-style particle on `layer` at (x, y).
// `frames` is the extracted SWF clip (one Frame per frame); `tint` is
// optionally applied to the underlying Sprite. `size`, when supplied, is
// re-applied after each frame swap so the clip keeps a consistent absolute
// size. `scale` mirrors Flash `_xscale/_yscale` copies, preserving the clip's
// native proportions while applying the source caller's scale factors. Anchor
// 0,0 (top-left) by default; pass an `anchor` tuple to centre. Returns the
// particle so callers can stash a reference if needed.
export function spawnMovieClip(
  ctx: GameContext,
  layer: Container,
  frames: Frame[],
  x: number,
  y: number,
  opts: {
    tint?: number;
    size?: { w: number; h: number };
    scale?: { x: number; y: number };
    anchor?: { x: number; y: number };
  } = {},
): FxParticle | null {
  if (frames.length === 0) return null;
  const sp = makeSprite(frames[0]);
  if (opts.anchor) sp.anchor.set(opts.anchor.x, opts.anchor.y);
  sp.x = x;
  sp.y = y;
  if (opts.tint !== undefined) sp.tint = opts.tint;
  if (opts.size) {
    sp.width = opts.size.w;
    sp.height = opts.size.h;
  }
  if (opts.scale) sp.scale.set(opts.scale.x, opts.scale.y);
  layer.addChild(sp);
  // timer/life are not consulted by the 'movie' branch — frameAcc drives the
  // lifetime — but we set them to the frame count for diagnostics consistency.
  return makePart(ctx, {
    kind: 'movie',
    view: sp,
    x,
    y,
    timer: frames.length,
    life: frames.length,
    frames,
    frameSprite: sp,
    frameAcc: 0,
    frameSize: opts.size ?? null,
    frameScale: opts.scale ?? null,
  });
}

// Helper: spawn a Part with bouncer at (x, y).
export function spawnBouncerPart(ctx: GameContext, view: Container, x: number, y: number): FxParticle {
  // Ball-frame: get px/py + sub-cell offsets exactly like Bouncer.setPos.
  const px = haxeInt((x - SIDE) / BW);
  const py = haxeInt(y / BH);
  const ox = x - getX(px);
  const oy = y - getY(py);
  return makePart(ctx, {
    kind: 'part',
    view,
    x,
    y,
    bounce: { px, py, ox, oy },
  });
}

// Util — tint a sprite/container's first sprite child to a given colour.
export function setColor(view: Container, color: number): void {
  if (view instanceof Sprite) {
    view.tint = color;
    return;
  }
  for (const child of view.children) {
    if (child instanceof Sprite) {
      child.tint = color;
    }
  }
}
