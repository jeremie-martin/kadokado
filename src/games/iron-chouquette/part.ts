import { Container, Sprite as PixiSprite, Text } from 'pixi.js';
import { Phys } from './phys';
import { TMOD } from './constants';
import type { IronChouquetteGame } from './game';
import { setFrame, type Frame } from '../_shared/frames';

// Part.mt — particle. Lifetime decays via `timer`; the last `fadeLimit` frames
// shrink/fade the sprite. fadeType: 0 = both axes scale-fade, 1 = y-only, default = alpha.

export class Part extends Phys {
  timer: number | null = null;
  fadeType: number | null = null;
  fadeLimit = 10;

  // Animated frame walker. When set, advances through frames over the lifetime.
  // Kept on Part because almost every effect plays an animation via the original `gotoAndPlay`.
  frames: { texture: import('pixi.js').Texture; pivotX: number; pivotY: number }[] | null = null;
  frameIndex = 0;

  // Optional fields used when subclassed by the black-hole captures (mask / black tint percent).
  mask: Container | null = null;
  black = 0;

  constructor(game: IronChouquetteGame, root: Container) {
    super(game, root);
    this.game.pList.push(this);
    this.scale = 100;
    this.fadeLimit = 10;
  }

  update(): void {
    super.update();

    if (this.frames && this.frames.length > 1) {
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
      // The container is expected to be a single-sprite wrapper — first child is the sprite.
      const child = this.root.children[0] as unknown as {
        texture: import('pixi.js').Texture;
        pivot: { set(x: number, y: number): void };
      } | undefined;
      if (child) {
        const f = this.frames[this.frameIndex];
        child.texture = f.texture;
        child.pivot.set(f.pivotX, f.pivotY);
      }
    }

    if (this.timer !== null) {
      this.timer -= TMOD;
      if (this.timer < this.fadeLimit) {
        const c = this.timer / this.fadeLimit;
        switch (this.fadeType) {
          case 0:
            this.root.scale.set((this.scale / 100) * c);
            break;
          case 1:
            this.root.scale.y = (this.scale / 100) * c;
            break;
          default:
            this.root.alpha = c;
            break;
        }
        if (this.timer < 0) this.kill();
      }
    }
  }

  override kill(): void {
    if (this.killed) return;
    const idx = this.game.pList.indexOf(this);
    if (idx >= 0) this.game.pList.splice(idx, 1);
    super.kill();
  }
}

// PartScore — floating score popup for `score > scoreDisplayLimit (100)` enemy kills,
// per source `Bads.mt:die` lines 562-569. The original `partScore` MovieClip is an
// 11-frame timeline that scale-pops a TextField bound to `_parent.score`. Per-frame
// scales extracted from `gfx.swf` DefineSpriteTag spriteId="29":
//
//   frame 1: 0.133  (sting in)
//   frame 2: 0.627
//   frame 3: 0.949
//   frame 4: 1.100  (overshoot)
//   frame 5: 1.050
//   frame 6: 1.050  (hold; sets up the wobble target)
//   frame 7: 0.814  (wobble bottom — gotoAndPlay(_currentframe-1) loops 6↔7 while compt-->0)
//   frame 8: 0.628
//   frame 9: 0.442
//   frame 10: 0.257
//   frame 11: 0.071 -> obj.kill()
//
// `compt = 10` (set by `Bads.die`) makes the popup wobble between frame 6 and 7
// for ~10 ticks of throbbing visibility before frames 7→11 shrink it out. We
// replicate the exact frame sequencing so timing matches Flash. The TextField
// is rendered as a Pixi Text since the partScore frames extracted to PNG are
// background-only (the SWF used a TextField overlay).
//
// **TextField data binding (R20)** — Source `Bads.die` sets the wobble counter
// and the displayed score by *property assignment* on `p.root`:
//
//   downcast(p.root).compt  = 10;
//   downcast(p.root).score = v;
//
// The inner `DefineEditText` chid 27 declares `variableName="_parent.score"`,
// which makes Flash re-evaluate the field's text from `root.score` on every
// frame the TextField is rendered. R17's port hard-coded `String(score)` once
// at construction, missing the property-binding semantics: any caller that
// mutates `p.root.score` mid-life (none in the shipping source, but the
// binding is observable behaviour) wouldn't see the text update. R20 stores
// `score` as a runtime property on `root` and re-reads it each tick, exactly
// like the Flash variable-bound TextField — also moving `compt` to be a
// `root` property so the source's `downcast(p.root).compt = 10` shape ports
// 1:1 from `Bads.die`.

const PART_SCORE_FRAME_SCALES = [
  0.133, 0.627, 0.949, 1.100, 1.050, 1.050,
  0.814, 0.628, 0.442, 0.257, 0.071,
];

// Container with the Flash-style `score`/`compt` properties source assigns via
// `downcast(p.root).score = v`. Declared at module scope so callers (`Bads.die`)
// can `(p.root as PartScoreRoot).score = v` to drive the bound TextField.
export type PartScoreRoot = Container & { score?: number; compt?: number };

export class PartScore extends Part {
  // Animator state. `frame` indexes PART_SCORE_FRAME_SCALES (0-based, equiv to source frame N+1).
  private frame = 0;
  private text: Text;
  // Last value rendered into `text` — gates the Text.text reassignment so we
  // skip the relatively expensive glyph relayout when the bound `root.score`
  // is unchanged. Flash re-evaluates the variableName binding every frame; we
  // mirror the per-frame read but elide redundant text-buffer writes.
  private lastRenderedScore: number | string | null = null;

  constructor(game: IronChouquetteGame, root: Container, initialScore: number) {
    super(game, root);
    // Backdrop sprite from frame index 3 (frame 4 in source — the overshoot peak,
    // and the only frame with non-trivial backdrop content for our extracted PNGs).
    // The frames are 89x27 with the popup glow baked in. We anchor on centre
    // so root.scale and root.x/y rotate the popup around its visual centre.
    if (game.assets.partScore && game.assets.partScore.length > 3) {
      const f = game.assets.partScore[3];
      const bg = new PixiSprite(f.texture);
      bg.anchor.set(0.5);
      root.addChild(bg);
    }
    // White score text overlay — matches source EditText 27 (RGBA 255,255,255, fontHeight=400 twips ≈ 20px, align=right).
    this.text = new Text({
      text: String(initialScore),
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 14,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x000022, width: 2 },
        align: 'center',
      },
    });
    this.text.anchor.set(0.5);
    root.addChild(this.text);
    this.lastRenderedScore = initialScore;

    // Seed the bound `score` and `compt` properties on root so callers can
    // mutate them via `(p.root as PartScoreRoot).score = v` exactly as
    // `Bads.die` does in source. Default `compt` to 10 (source default).
    const rt = root as PartScoreRoot;
    if (rt.score === undefined) rt.score = initialScore;
    if (rt.compt === undefined) rt.compt = 10;

    // Frame 0 sting-in scale.
    root.scale.set(PART_SCORE_FRAME_SCALES[0]);
  }

  override update(): void {
    // Pure timeline-driven; bypass Phys integration / standard Part fade.
    // Source partScore has no velocity — it sits in place.
    this.root.x = this.x;
    this.root.y = this.y;

    // _parent.score binding: re-evaluate from root each tick (mirrors Flash
    // variableName="_parent.score"). Skip the expensive Text reassignment when
    // the value is unchanged.
    const rt = this.root as PartScoreRoot;
    const bound = rt.score;
    if (bound !== undefined && bound !== this.lastRenderedScore) {
      this.text.text = String(bound);
      this.lastRenderedScore = bound;
    }

    // Step the timeline. Frame 7 (index 6) houses the gotoAndPlay back to frame 6 (index 5)
    // while compt-- > 0, otherwise advance. Frame 11 (index 10) calls obj.kill().
    // Source's `if(compt-- > 0)` reads + decrements the *bound* `root.compt`,
    // so we mirror that read site too — any caller mutating `p.root.compt`
    // (none in shipped source, but the field is bound) gets honoured.
    if (this.frame === 6) {
      const c = rt.compt ?? 0;
      if (c > 0) {
        rt.compt = c - 1;
        this.frame = 5; // back to frame 6
      } else {
        this.frame = 7; // advance to frame 8
      }
    } else if (this.frame === 10) {
      // Source frame 11 fires obj.kill().
      this.kill();
      return;
    } else {
      this.frame += 1;
    }

    this.root.scale.set(PART_SCORE_FRAME_SCALES[this.frame]);
  }
}

// PartInvincibility — partInvincibility particle with an optional `mcLaserLight`
// child that plays its 9-frame timeline naturally for the part's lifetime.
//
// Source `Hero.mt:118-148` spawns a `partInvincibility` Part via the standard
// `new Part(dm.attach("partInvincibility", DP_UNDERPARTS))` flow, then with a
// 1/3 per-frame chance attaches a fresh `mcLaserLight` MovieClip as a child of
// the part's `root` (`pdm.attach("mcLaserLight", 0)` via a new DepthManager
// rooted at `p.root`). The laserLight clip auto-plays in Flash; the partInvincibility
// itself has `timer = 10` (set by the caller) so the laserLight gets ≤10 ticks of
// playback before its host part dies and removes the entire MovieClip subtree.
//
// We replicate this by attaching the laserLight as a second child sprite of `root`
// and stepping its frame each tick (since Part's standard frame walker only steps
// `children[0]`, the partInvincibility itself). The laserLight scale + rotation
// are randomised at spawn per source.
export class PartInvincibility extends Part {
  private laserLightFrames: Frame[] | null = null;
  private laserLightSprite: PixiSprite | null = null;
  private laserLightFrameIndex = 0;

  attachLaserLight(frames: Frame[]): void {
    if (frames.length === 0) return;
    this.laserLightFrames = frames;
    const sp = new PixiSprite(frames[0].texture);
    sp.anchor.set(0.5);
    sp.pivot.set(frames[0].pivotX, frames[0].pivotY);
    // Source `mcLaserLight._rotation = Math.random()*360` (degrees) ⇒ radians.
    sp.rotation = Math.random() * Math.PI * 2;
    // Source `mc._xscale = 100+Math.random()*100` (=100..200%) and
    // `mc._yscale = 50+Math.random()*100` (=50..150%).
    sp.scale.set(1 + Math.random(), 0.5 + Math.random());
    this.root.addChild(sp);
    this.laserLightSprite = sp;
  }

  override update(): void {
    super.update();
    // Step laserLight child timeline (mirrors Flash auto-play). One frame per tick;
    // wraps modulo length so a part outliving the clip-length keeps cycling.
    if (this.laserLightFrames && this.laserLightSprite) {
      this.laserLightFrameIndex = (this.laserLightFrameIndex + 1) % this.laserLightFrames.length;
      setFrame(this.laserLightSprite, this.laserLightFrames[this.laserLightFrameIndex]);
    }
  }
}

// PartTrace — animated `mcExploTrace` clip used by `Hero.explode`. Source
// `Hero.mt:927-938` spawns six clips at randomised position / scale / rotation,
// each starting at a random frame `Std.random(3)+1` and playing forward. The
// `mcExploTrace` MovieClip is a 3-frame timeline whose final frame's DoAction is
// `obj.plasmaDraw(this,1); removeMovieClip()` (verified via FFDec on
// `gfx.swf` DefineSprite_66 frame_3) — i.e. each clip stamps its current
// (final) frame into plasma layer 1 additively when it reaches frame 3, then
// removes itself. A clip starting at frame 1 lives for 3 ticks (frames 1→2→3),
// at frame 2 for 2 ticks (2→3), at frame 3 for 1 tick. We replicate this
// per-clip lifetime exactly: animate the visible Sprite over the three frames,
// then on the tick that reaches the last frame call `plasmaDraw` and `kill`.
//
// Distinct from `Bads.explode` (R16) which used `gotoAndStop("3")` and stamped
// three times from a single throwaway MovieClip — that path uses one-shot
// stamps with no on-screen lifetime. Hero traces are visible and additive over
// 1-3 ticks before stamping.
export class PartTrace extends Part {
  private startFrame: number;
  private spriteChild: PixiSprite | null = null;

  constructor(
    game: IronChouquetteGame,
    root: Container,
    frames: Frame[],
    startFrame: number,
  ) {
    super(game, root);
    this.frames = frames;
    // Source random index `Std.random(3)+1` in [1,3] maps to 0-based [0,2].
    this.startFrame = Math.max(0, Math.min(frames.length - 1, startFrame));
    this.frameIndex = this.startFrame;
    // Wrap the texture in a Sprite child of `root` so the clip is visible
    // additively in DP_PARTS while it plays. PartScore showed the layout
    // (anchor-centred sprite as first child); we mirror it.
    const f0 = frames[this.frameIndex];
    if (f0) {
      const sp = new PixiSprite(f0.texture);
      sp.anchor.set(0.5);
      sp.pivot.set(f0.pivotX, f0.pivotY);
      root.addChild(sp);
      this.spriteChild = sp;
    }
  }

  override update(): void {
    // Pure timeline + position; no velocity (mcExploTrace is stationary).
    this.root.x = this.x;
    this.root.y = this.y;

    // Render the current frame onto the visible sprite child.
    if (this.spriteChild && this.frames) {
      setFrame(this.spriteChild, this.frames[this.frameIndex]);
    }

    // If we've reached the final frame, stamp into plasma layer 1 and kill —
    // matches the SWF frame_3 DoAction. The stamp must compose the container's
    // current scale + rotation + position, which is what R16 fixed in
    // `Game.plasmaDraw` (transform compose).
    if (this.frameIndex >= (this.frames?.length ?? 1) - 1) {
      this.game.plasmaDraw(this.root, 1);
      this.kill();
      return;
    }

    this.frameIndex += 1;
  }
}
