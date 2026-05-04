import { Application, BlurFilter, ColorMatrixFilter, Container, Graphics, RenderTexture, Sprite as PixiSprite, Matrix } from 'pixi.js';
import {
  STAGE_WIDTH, STAGE_HEIGHT, TMOD, setTmod,
  SCROLL_SPEED_INITIAL, SCROLL_SPEED_MAX, PLASMA_CACHE,
  ASSET_ROOT,
} from './constants';
import type { Sprite } from './sprite';
import type { Part } from './part';
import { Hero } from './hero';
import { Phys } from './phys';
import { Stykades } from './boss';
import { Bonus } from './bonus';
import type { Bads } from './bads';
import type { Shot } from './projectiles';
import { Inter } from './inter';
import { type Frame, loadFrame, loadSeries, makeSprite } from '../_shared/frames';
import type { GameHost } from '../types';

export type IronChouquetteAssets = {
  // Pre-rasterized rasters from bmp/.
  bg: Frame;
  bgVector: Frame;
  spaceRabbit: Frame;
  omegaBody: Frame;
  omegaTurn: Frame;
  blackron: Frame;
  furia: Frame;
  steack: Frame;
  orbs: Frame;
  unorbs: Frame;
  psxPad: Frame;
  // Vector single-frame.
  base1: Frame;
  base2: Frame;
  bigLaser: Frame;
  blackHole: Frame;
  laserRay: Frame;
  partInvincibility: Frame;
  partLaser: Frame;
  partLight: Frame;
  partSpark: Frame;
  planet: Frame;
  queueStandard: Frame;
  round: Frame;
  sonicBoom: Frame;
  // Multi-frame folders.
  bads: Frame[];
  bonus: Frame[];
  chouquette: Frame[];
  exploPart: Frame[];
  exploTrace: Frame[];
  hero: Frame[];
  icon: Frame[];
  laserLight: Frame[];
  magicBall: Frame[];
  miniExplo: Frame[];
  onde: Frame[];
  partBlackBall: Frame[];
  partBlackHole: Frame[];
  partConcentrate: Frame[];
  partImpact: Frame[];
  partMagicSpark: Frame[];
  partPaillette: Frame[];
  partPlasmaBolt: Frame[];
  partRay: Frame[];
  partScore: Frame[];
  partSparkSpeed: Frame[];
  partStatic: Frame[];
  queueMagicBall: Frame[];
  queueRocket: Frame[];
  shield: Frame[];
  shot: Frame[];
  slot: Frame[];
  speed: Frame[];
};

export async function loadAssets(): Promise<IronChouquetteAssets> {
  const single = (name: string) => loadFrame(`${ASSET_ROOT}/${name}`, 0, 0);
  const series = (name: string, count: number) => loadSeries(`${ASSET_ROOT}/${name}`, count, 0, 0);

  const [
    bg, bgVector, spaceRabbit, omegaBody, omegaTurn, blackron, furia, steack, orbs, unorbs, psxPad,
    base1, base2, bigLaser, blackHole, laserRay, partInvincibility, partLaser, partLight, partSpark,
    planet, queueStandard, round, sonicBoom,
    bads, bonus, chouquette, exploPart, exploTrace, hero, icon, laserLight, magicBall, miniExplo,
    onde, partBlackBall, partBlackHole, partConcentrate, partImpact, partMagicSpark, partPaillette,
    partPlasmaBolt, partRay, partScore, partSparkSpeed, partStatic, queueMagicBall, queueRocket,
    shield, shot, slot, speed,
  ] = await Promise.all([
    single('bg.jpg'), single('bg-vector.png'), single('space_rabbit.png'),
    single('omega_body.png'), single('omega_turn.png'), single('blackron.png'),
    single('furia.png'), single('steack.png'), single('orbs.png'), single('unorbs.png'),
    single('psx_pad.png'),
    single('base1.png'), single('base2.png'), single('big-laser.png'),
    single('black-hole.png'), single('laser-ray.png'), single('part-invincibility.png'),
    single('part-laser.png'), single('part-light.png'), single('part-spark.png'),
    single('planet.png'), single('queue-standard.png'), single('round.png'),
    single('sonic-boom.png'),
    series('bads', 20), series('bonus', 28), series('chouquette', 6),
    series('explo-part', 10), series('explo-trace', 3), series('hero', 20),
    series('icon', 6), series('laser-light', 9), series('magic-ball', 2),
    series('mini-explo', 8), series('onde', 5), series('part-black-ball', 2),
    series('part-black-hole', 9), series('part-concentrate', 13), series('part-impact', 14),
    series('part-magic-spark', 2), series('part-paillette', 3), series('part-plasma-bolt', 20),
    series('part-ray', 3), series('part-score', 11), series('part-spark-speed', 17),
    series('part-static', 5), series('queue-magic-ball', 16), series('queue-rocket', 19),
    series('shield', 5), series('shot', 23), series('slot', 7), series('speed', 5),
  ]);

  return {
    bg, bgVector, spaceRabbit, omegaBody, omegaTurn, blackron, furia, steack, orbs, unorbs, psxPad,
    base1, base2, bigLaser, blackHole, laserRay, partInvincibility, partLaser, partLight, partSpark,
    planet, queueStandard, round, sonicBoom,
    bads, bonus, chouquette, exploPart, exploTrace, hero, icon, laserLight, magicBall, miniExplo,
    onde, partBlackBall, partBlackHole, partConcentrate, partImpact, partMagicSpark, partPaillette,
    partPlasmaBolt, partRay, partScore, partSparkSpeed, partStatic, queueMagicBall, queueRocket,
    shield, shot, slot, speed,
  };
}

// Mirrors Game.mt — the orchestrator. Owns sprite/shot/bads/bonus/part lists,
// the depth layers, plasma render textures, parallax decor, and the boss/difficulty driver.

type BulletTime = { trg: number; timer: number; val: number };

export class IronChouquetteGame {
  app: Application;
  assets: IronChouquetteAssets;
  host: GameHost;

  // Layers (z-order increases with index).
  bgLayer = new Container();        // DP_BG
  underPartsLayer = new Container(); // DP_UNDERPARTS
  drawLayer = new Container();       // DP_DRAW (laser graphics, etc.)
  badsLayer = new Container();       // DP_BADS
  shotsLayer = new Container();      // DP_SHOTS
  heroLayer = new Container();       // DP_HERO
  partsLayer = new Container();      // DP_PARTS
  interLayer = new Container();      // DP_INTER

  // Plasma render textures (replacement for BitmapData).
  // `scratch` is a ping-pong texture used to translate the layer's pixels each
  // frame, mirroring source's `bmp.scroll(0, SCROLL_SPEED*3*pq)`.
  plasma: { rt: RenderTexture; scratch: RenderTexture; sprite: PixiSprite; blur: BlurFilter }[] = [];
  pq = 0.5;
  PM = 1; // particle multiplier

  // Per-frame CPU mirror of plasma layer 0 for source-faithful speed-aura
  // collision (Bads.mt:214-232 reads `plasma.layer[0].bmp.getPixel32(...)`).
  // Lazily extracted on the first read in a frame and reused for the rest of
  // that frame; gated to frames where Hero has WP_SPEED active and at least
  // one bad is alive, so the GPU readback never runs outside Speed sacrifices.
  // R22: replaces the radial heuristic that was carried since R1.
  private plasmaSamples0: Uint8ClampedArray | null = null;
  private plasmaSamples0Width = 0;
  private plasmaSamples0Height = 0;
  private plasmaSamples0Frame = -1;
  // Per-tick frame counter used as the cache token for the plasma readback.
  // Bumped at the top of `main()` so any downstream consumer can detect frame
  // boundaries without re-deriving them from setTimeout/Pixi ticker state.
  frameCount = 0;

  // Bullet-time desaturation/blue-tint filter applied to the background.
  // Source: `bg.filters = [ColorMatrixFilter]` per frame while bt!=null.
  private bgFilter: ColorMatrixFilter | null = null;
  // White-flash filter applied to the stage when `flashouille > 0`.
  // Source: `Cs.setPercentColor(root, flashouille, 0xFFFFFF)` per frame —
  // a global per-channel lerp toward white, used as the screen-wide hit-feedback
  // pulse on every Hero.sacrifice (and any future caller). Same pattern as the
  // damage flash (`phys.ts:applyFlashTint`) and invincibility flash
  // (`hero.ts:updateInvincible`), but applied to the whole stage.
  private flashFilter: ColorMatrixFilter | null = null;

  // Lists.
  sList: Sprite[] = [];
  pList: Part[] = [];
  shotList: Shot[] = [];
  badsList: Bads[] = [];
  bonusList: Bonus[] = [];

  hero: Hero | null = null;
  boss: Stykades;
  inter: Inter;

  // Game state.
  step = 0;
  timer = 0;
  flashouille: number | null = null;
  bt: BulletTime | null = null;
  lagTimer = 0;
  gfxMode = 4;

  // Background scroll.
  SCROLL_SPEED = SCROLL_SPEED_INITIAL;
  bg: PixiSprite;
  baseList: { sprite: PixiSprite; vy: number }[] = [];

  // Intro state.
  chouquette: Phys | null = null;
  kidnappers: Phys[] = [];
  knTurnRay = 10;
  knTurnDecal = 0;
  knTurnSpeed = 0;

  // Score.
  score = 0;

  // Input.
  keys = new Set<string>();

  ended = false;

  constructor(app: Application, assets: IronChouquetteAssets, host: GameHost) {
    this.app = app;
    this.assets = assets;
    this.host = host;

    // Compose stage layers in z-order.
    this.app.stage.addChild(
      this.bgLayer,
      this.underPartsLayer,
      this.drawLayer,
      this.badsLayer,
      this.shotsLayer,
      this.heroLayer,
      this.partsLayer,
      this.interLayer,
    );

    // Background sprite. Source attaches `mcBg` from decor.swf, not bmp/bg.jpg.
    this.bg = makeSprite(this.assets.bgVector);
    this.bg.x = 0;
    this.bg.y = 0;
    this.bgLayer.addChild(this.bg);

    this.boss = new Stykades(this);
    this.inter = new Inter(this, this.interLayer);

    this.initStep(0);
    this.initPlasma();
    this.host.updateScore(0);
  }

  // Plasma cache: 2 RenderTextures driven by Pixi's renderer instead of BitmapData.draw.
  // Source bakes a BlurFilter into the bitmap each frame (blurX/Y ≈ 2*pq*tmod for layer 0,
  // 10*pq*tmod for layer 1). We can't apply per-frame filters into a RenderTexture cheaply,
  // so a continuous `BlurFilter` lives on each plasma sprite — close enough visually.
  initPlasma(): void {
    const w = Math.max(1, Math.floor(STAGE_WIDTH * this.pq));
    const h = Math.max(1, Math.floor((STAGE_HEIGHT + PLASMA_CACHE) * this.pq));
    for (let i = 0; i < 2; i += 1) {
      const rt = RenderTexture.create({ width: w, height: h });
      const scratch = RenderTexture.create({ width: w, height: h });
      const spr = new PixiSprite(rt);
      spr.scale.set(1 / this.pq);
      spr.x = 0;
      spr.y = -PLASMA_CACHE;
      // Source only sets BlendMode.ADD on layer 0; layer 1 keeps Flash's
      // normal blend mode (the OVERLAY line is present but commented out).
      spr.blendMode = i === 0 ? 'add' : 'normal';
      // Layer 1 gets a heavier blur, matching source's 10*pq vs 2*pq.
      const blur = new BlurFilter({ strength: i === 0 ? 2 : 5, quality: 2 });
      spr.filters = [blur];
      this.bgLayer.addChild(spr);
      this.plasma.push({ rt, scratch, sprite: spr, blur });
    }
  }

  initStep(n: number): void {
    this.step = n;
    switch (n) {
      case 0: {
        // Chouquette intro — descends from below the screen, three kidnappers orbiting.
        const cRoot = new Container();
        const cSpr = makeSprite(this.assets.chouquette[0]);
        cSpr.anchor.set(0.5);
        cRoot.addChild(cSpr);
        this.badsLayer.addChild(cRoot);
        this.chouquette = new Phys(this, cRoot);
        this.chouquette.x = STAGE_WIDTH * 0.5 - 5;
        this.chouquette.y = STAGE_HEIGHT + 10;
        this.chouquette.frict = 0.92;

        // Three kidnappers using bads frame 6 (mcBads gotoAndStop("6")).
        for (let i = 0; i < 3; i += 1) {
          const kRoot = new Container();
          const kSpr = makeSprite(this.assets.bads[Math.min(5, this.assets.bads.length - 1)]);
          kSpr.anchor.set(0.5);
          kRoot.addChild(kSpr);
          this.badsLayer.addChild(kRoot);
          const kp = new Phys(this, kRoot);
          kp.x = -100;
          kp.y = -100;
          kp.updatePos();
          this.kidnappers.push(kp);
        }

        // Decor base sprites.
        const planet = makeSprite(this.assets.planet);
        planet.x = STAGE_WIDTH;
        planet.y = 160;
        this.bgLayer.addChild(planet);
        const b2 = makeSprite(this.assets.base2);
        const b1 = makeSprite(this.assets.base1);
        this.bgLayer.addChild(b2);
        this.partsLayer.addChild(b1);
        this.baseList = [
          { sprite: planet, vy: 0 },
          { sprite: b2, vy: 0 },
          { sprite: b1, vy: 0 },
        ];

        this.timer = 60;
        break;
      }
      case 1:
        this.hero = new Hero(this);
        break;
      case 2:
        // Free play.
        break;
    }
  }

  main(): void {
    if (this.ended) return;
    this.frameCount += 1;

    if (this.bt) {
      this.updateBulletTime();
      // Source sets `Timer.tmod = bt.val` so every per-frame *tmod term slows down.
      setTmod(this.bt.val);
    } else {
      setTmod(1);
    }
    this.updateFlash();
    this.updatePlasma();

    // Update Sprites (including hero, bads, shots, parts).
    const list = this.sList.slice();
    for (const s of list) {
      if (!s.killed) s.update();
    }

    switch (this.step) {
      case 0:
        if (this.chouquette) {
          if (this.chouquette.y > STAGE_HEIGHT * 0.5) {
            this.chouquette.vy -= 0.3 * TMOD;
          } else {
            this.initStep(1);
          }
        }
        this.knTurnRay += 0.35 * TMOD;
        this.updateKidnappers();
        this.timer = 60;
        break;
      case 1:
        this.knTurnSpeed += 0.15 * TMOD;
        if (this.timer > 0) {
          this.timer -= TMOD;
        } else if (this.chouquette) {
          this.chouquette.vy -= 0.8 * TMOD;
          if (this.chouquette.y < -100) {
            while (this.kidnappers.length > 0) {
              const k = this.kidnappers.pop();
              if (k) k.kill();
            }
            this.chouquette.kill();
            this.chouquette = null;
            this.initStep(2);
          }
        }
        this.updateKidnappers();
        this.boss.update();
        break;
      case 2:
        this.boss.update();
        break;
    }

    if (this.SCROLL_SPEED > 0) this.updateScroll();
    this.inter.update();
  }

  updateKidnappers(): void {
    if (!this.chouquette) return;
    for (let i = 0; i < this.kidnappers.length; i += 1) {
      const k = this.kidnappers[i];
      const c = i / this.kidnappers.length;
      this.knTurnDecal = (this.knTurnDecal + this.knTurnSpeed * TMOD) % 628;
      k.x = this.chouquette.x + Math.cos(this.knTurnDecal * 0.01 + c * 6.28) * this.knTurnRay;
      k.y = this.chouquette.y + Math.sin(this.knTurnDecal * 0.01 + c * 6.28) * this.knTurnRay;
    }
  }

  updateBulletTime(): void {
    if (!this.bt) return;
    const dif = this.bt.trg - this.bt.val;
    this.bt.val += dif * 0.1;
    if (Math.abs(dif) < 0.1) this.bt.val = this.bt.trg;
    this.bt.timer -= 1;
    if (this.bt.timer <= 0) this.bt.trg = 1;
    if (this.bt.val === 1) {
      this.bt = null;
      this.bg.filters = [];
      this.bgFilter = null;
      return;
    }
    // Source applies a per-frame ColorMatrixFilter on `bg` for the bullet-time tint.
    // matrix is 4x5 with diag 1+c*sat and constant offsets that drift toward
    // (200, -50, -50) per channel scaled by c=1-bt.val (a desaturated blue-warm bias).
    // Pixi's ColorMatrixFilter offsets are normalized 0..1, so divide source byte offsets by 255.
    const c = 1 - this.bt.val;
    const sat = 0.3;
    const inc = Math.random() * 15;
    const fl = this.bgFilter ?? new ColorMatrixFilter();
    fl.matrix = [
      1 + c * sat, 0, 0, 0, (inc + 200 * c) / 255,
      0, 1 + c * sat, 0, 0, (inc - 50 * c) / 255,
      0, 0, 1 + c * sat, 0, (inc - 50 * c) / 255,
      0, 0, 0, 1, 0,
    ];
    if (!this.bgFilter) {
      this.bgFilter = fl;
      this.bg.filters = [fl];
    }
  }

  updateFlash(): void {
    if (this.flashouille !== null) {
      // Source: every frame applies `Cs.setPercentColor(stage, flashouille, 0xFFFFFF)`
      // — diag = 1-c, RGB offset = c (normalised). c ∈ [0,1] from `flashouille / 100`.
      // Apply on the whole `app.stage` so the entire scene (bg, plasma, enemies,
      // hero, shots, HUD) flashes white, matching the source's stage-level flash.
      const c = Math.min(Math.max(this.flashouille, 0), 100) / 100;
      const k = 1 - c;
      const fl = this.flashFilter ?? new ColorMatrixFilter();
      fl.matrix = [
        k, 0, 0, 0, c,
        0, k, 0, 0, c,
        0, 0, k, 0, c,
        0, 0, 0, 1, 0,
      ];
      if (!this.flashFilter) {
        this.flashFilter = fl;
        this.app.stage.filters = [fl];
      }
      this.flashouille *= 0.6;
      if (this.flashouille < 2) {
        this.flashouille = null;
        this.app.stage.filters = [];
        this.flashFilter = null;
      }
    }
  }

  // Plasma update — decays the additive layer and the normal-blend layer.
  // Source applies a per-frame BitmapData colorTransform that subtracts a small
  // amount from each channel (layer 0: -2 RGB; layer 1: 0.95×R 0.8×GB -10 RGB -10 A).
  // We approximate with a multiply-blended grey rectangle over each render texture:
  // pixels darken toward black each frame, mimicking the trail decay.
  updatePlasma(): void {
    // Source applies `bmp.scroll(0, int(SCROLL_SPEED*3*pq))` only when SCROLL_SPEED > 0.2.
    // The offset is in *texture* pixels (post-pq), and `int()` is Flash truncation.
    const scrollDy = this.SCROLL_SPEED > 0.2 ? Math.trunc(this.SCROLL_SPEED * 3 * this.pq) : 0;
    const w = Math.max(1, Math.floor(STAGE_WIDTH * this.pq));
    const h = Math.max(1, Math.floor((STAGE_HEIGHT + PLASMA_CACHE) * this.pq));
    for (let i = 0; i < this.plasma.length; i += 1) {
      const layer = this.plasma[i];
      // Source per-frame ColorTransform on each plasma BitmapData:
      //   layer 0: ColorTransform(1, 1, 1, 1, -2, -2, -2, 0)        — flat `-2/255` byte sub
      //   layer 1: ColorTransform(0.95, 0.8, 0.8, 1, -10, -20, -20, -10) — channel-skewed
      // Decompose into a multiply pass for the diagonal scales (0xff for layer 0 ≡ identity)
      // and a `subtract` blend pass for the negative byte offsets. `subtract` in Pixi v8 is
      // GPU `dst - src`, so a tinted rect with rgb=(off,off,off)/255 reproduces source exactly.
      if (i === 1) {
        // 0.95R / 0.8G / 0.8B multiply.
        const mul = new Graphics();
        mul.rect(0, 0, w, h).fill({ color: 0xf2cccc, alpha: 1 }); // (242, 204, 204) ≈ (0.95, 0.8, 0.8)
        mul.blendMode = 'multiply';
        this.app.renderer.render({ container: mul, target: layer.rt, clear: false });
        mul.destroy();
      }
      // Subtract pass: layer 0 → (2,2,2), layer 1 → (10,20,20).
      const sub = new Graphics();
      const subColour = i === 0 ? ((2 << 16) | (2 << 8) | 2) : ((10 << 16) | (20 << 8) | 20);
      sub.rect(0, 0, w, h).fill({ color: subColour, alpha: 1 });
      sub.blendMode = 'subtract';
      this.app.renderer.render({ container: sub, target: layer.rt, clear: false });
      sub.destroy();

      // Plasma scroll: copy `rt` into `scratch` translated by +scrollDy in texture
      // space, then swap so subsequent draws/sample reads see the shifted content.
      // Mirrors `flash.display.BitmapData.scroll(0, dy)` — pixels move down with
      // the world; the top edge becomes blank (cleared on the copy).
      if (scrollDy > 0) {
        const copy = new PixiSprite(layer.rt);
        copy.x = 0;
        copy.y = scrollDy;
        this.app.renderer.render({ container: copy, target: layer.scratch, clear: true });
        copy.destroy();
        // Swap rt <-> scratch so the layer sprite samples the shifted texture.
        const tmp = layer.rt;
        layer.rt = layer.scratch;
        layer.scratch = tmp;
        layer.sprite.texture = layer.rt;
      }
    }
  }

  // Plasma draw: render a transient container into the chosen plasma RenderTexture.
  // Source's `Game.mt:plasmaDraw` builds the bitmap-space matrix from the
  // MovieClip's _xscale/_yscale (as a fraction), _rotation, _x, _y:
  //   m.scale(xs*pq, ys*pq); m.rotate(rot); m.translate(x*pq, (y+PLASMA_CACHE)*pq)
  // Pixi's `Renderer.render({ transform })` *replaces* the container's
  // localTransform, so the container's own scale/rotation/position would be
  // dropped if we only set scale+translate from `mc.x/mc.y`. Combine all three
  // into the matrix exactly like source so callers can set scale/rotation/x/y
  // on the container and have them honoured in the plasma stamp (matters for
  // the Bads.explode mcExploTrace stamps and the Hero speed-aura mcSpeed
  // stamps, both of which set per-frame random rotation and per-boost-level
  // scale on the container before calling plasmaDraw).
  plasmaDraw(mc: Container, n: number): void {
    if (n < 0 || n >= this.plasma.length) return;
    const target = this.plasma[n].rt;
    const m = new Matrix();
    m.scale(mc.scale.x * this.pq, mc.scale.y * this.pq);
    if (mc.rotation !== 0) m.rotate(mc.rotation);
    m.translate(mc.x * this.pq, (mc.y + PLASMA_CACHE) * this.pq);
    // Add to the existing texture (no clear).
    this.app.renderer.render({ container: mc, target, clear: false, transform: m });
    // Invalidate the cached plasma-layer-0 sample buffer if this draw landed in
    // layer 0 — any subsequent `samplePlasmaLayer0()` in this frame must re-read.
    // (Layer 1 reads aren't currently consumed; if that changes, mirror this.)
    if (n === 0) this.plasmaSamples0Frame = -1;
  }

  // Source-faithful plasma-layer-0 readback for `Bads.mt:214-232` speed-aura
  // collision. Pulls the entire layer-0 RenderTexture into a CPU `Uint8ClampedArray`
  // via `renderer.extract.pixels` — this is synchronous in Pixi v8 (`gl.readPixels`
  // under the hood), so it triggers a GPU sync stall. Cost is amortised across
  // every Bads sampling the buffer in the same frame: the first call extracts,
  // subsequent calls in the same `main()` tick reuse via the `frameCount` token.
  // Gated by callers (only invoked when Hero has WP_SPEED > 0 active), so the
  // stall only happens during Speed boost windows. The buffer is texture-space
  // (pq-scaled, PLASMA_CACHE y-offset baked in by source coordinate convention).
  samplePlasmaLayer0(): void {
    if (this.plasmaSamples0Frame === this.frameCount) return;
    if (this.plasma.length === 0) return;
    // Use the plasma-layer-0 RT as the extract target. Note: `updatePlasma`
    // ping-pongs `rt`/`scratch` when scrolling; we always extract from `rt`,
    // which is the live texture the layer sprite samples from.
    try {
      const out = this.app.renderer.extract.pixels({ target: this.plasma[0].rt });
      this.plasmaSamples0 = out.pixels;
      this.plasmaSamples0Width = out.width;
      this.plasmaSamples0Height = out.height;
      this.plasmaSamples0Frame = this.frameCount;
    } catch {
      // Extract can fail during teardown or first-frame init; keep the radial
      // fallback path active by leaving `plasmaSamples0` null this frame.
      this.plasmaSamples0 = null;
      this.plasmaSamples0Frame = this.frameCount;
    }
  }

  // Sample plasma layer 0 at world-space (x, y) — mirrors source
  // `bmp.getPixel32(int(root._x*pq), int((root._y+PLASMA_CACHE)*pq))`. Returns
  // the RGBA bytes (premultiplied; Pixi v8 `extract.pixels` returns straight
  // texture-source bytes, premul on add-blended `add` targets) or null when no
  // buffer is available (caller should fall back to the radial heuristic).
  getPlasma0Pixel(x: number, y: number): { r: number; g: number; b: number; a: number } | null {
    const buf = this.plasmaSamples0;
    if (!buf) return null;
    const w = this.plasmaSamples0Width;
    const h = this.plasmaSamples0Height;
    // Source uses `int()` which truncates toward zero; replicate with `Math.trunc`.
    const px = Math.trunc(x * this.pq);
    const py = Math.trunc((y + PLASMA_CACHE) * this.pq);
    if (px < 0 || px >= w || py < 0 || py >= h) return null;
    const idx = (py * w + px) * 4;
    return { r: buf[idx], g: buf[idx + 1], b: buf[idx + 2], a: buf[idx + 3] };
  }

  updateScroll(): void {
    if (this.gfxMode < 3) {
      this.SCROLL_SPEED *= 0.95;
      if (this.SCROLL_SPEED < 0.5) this.SCROLL_SPEED = 0;
    } else if (this.step > 1) {
      this.SCROLL_SPEED = Math.min(this.SCROLL_SPEED + 0.01 * TMOD, SCROLL_SPEED_MAX);
    }

    // Source: `bg._y += SCROLL_SPEED; if(bg._y>0) bg._y -= 1800`.
    // `mcBg` is 300x3600; the 1800 half-height wrap is part of the original
    // parallax loop and starts the visible viewport on the second half after
    // the first scroll tick.
    this.bg.y += this.SCROLL_SPEED;
    if (this.bg.y > 0) this.bg.y -= 1800;

    for (let i = 0; i < this.baseList.length; i += 1) {
      const b = this.baseList[i];
      if (b.sprite.y === 0) b.sprite.y = STAGE_HEIGHT;
      b.sprite.y += this.SCROLL_SPEED;
      if (b.sprite.y > STAGE_HEIGHT + 100) {
        b.sprite.removeFromParent();
        b.sprite.destroy();
        this.baseList.splice(i, 1);
        i -= 1;
      }
    }
  }

  addScore(value: number): void {
    this.score += value;
    this.host.updateScore(this.score);
  }

  spawnBonus(x: number, y: number): Bonus {
    return new Bonus(this, x, y);
  }

  gameOver(): void {
    if (this.ended) return;
    this.ended = true;
    this.inter.setGameOver();
    this.host.endRun({ score: this.score });
  }

  destroy(): void {
    // Best-effort exhaustive cleanup.
    for (const list of [this.sList.slice(), this.pList.slice(), this.shotList.slice(), this.badsList.slice(), this.bonusList.slice()]) {
      for (const s of list) {
        if (!s.killed) s.kill();
      }
    }
    this.sList.length = 0;
    this.pList.length = 0;
    this.shotList.length = 0;
    this.badsList.length = 0;
    this.bonusList.length = 0;
    for (const layer of this.plasma) {
      layer.sprite.filters = [];
      layer.blur.destroy();
      layer.sprite.removeFromParent();
      layer.sprite.destroy();
      layer.rt.destroy(true);
      layer.scratch.destroy(true);
    }
    this.plasma = [];
    if (this.bgFilter) {
      this.bg.filters = [];
      this.bgFilter.destroy();
      this.bgFilter = null;
    }
    if (this.flashFilter) {
      this.app.stage.filters = [];
      this.flashFilter.destroy();
      this.flashFilter = null;
    }
    this.bgLayer.removeFromParent();
    this.bgLayer.destroy({ children: true });
    this.underPartsLayer.removeFromParent();
    this.underPartsLayer.destroy({ children: true });
    this.drawLayer.removeFromParent();
    this.drawLayer.destroy({ children: true });
    this.badsLayer.removeFromParent();
    this.badsLayer.destroy({ children: true });
    this.shotsLayer.removeFromParent();
    this.shotsLayer.destroy({ children: true });
    this.heroLayer.removeFromParent();
    this.heroLayer.destroy({ children: true });
    this.partsLayer.removeFromParent();
    this.partsLayer.destroy({ children: true });
    this.interLayer.removeFromParent();
    this.interLayer.destroy({ children: true });
  }
}
