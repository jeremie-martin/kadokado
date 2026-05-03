import { Container, Sprite as PixiSprite } from 'pixi.js';
import { Phys } from './phys';
import { Part, PartScore, type PartScoreRoot } from './part';
import { Rafale, Shot } from './projectiles';
import {
  TMOD, hMod, randInt,
  STAGE_WIDTH,
  WP_LASER, WP_SPEED,
} from './constants';
import type { IronChouquetteGame } from './game';
import type { Wave } from './wave';
import { makeSprite } from '../_shared/frames';

// Bads.mt — every adversary. The behavior list (`bList`) drives motion;
// shooting is delegated to a Rafale burst pattern.

export type BeeRange = { w: number; xMin: number; xMax: number; yMin: number; yMax: number };

export class Bads extends Phys {
  static scoreDisplayLimit = 100;

  flDeath = false;
  flInvincible = false;
  flSide = false;
  flOrient = false;
  hp = 2;
  score: number | null = null;
  score2: number | null = null;
  mid = 0;

  dif = 1;
  spawnDist = 0;

  a = 1.57;
  va = 0.1;
  speed = 3;
  speedCoef = 1;
  trg: { x: number; y: number } | null = null;
  acc: { c: number; lim: number } | null = null;
  turnCoef = 0.1;

  wave: Wave | null = null;
  pathIndex = 0;
  waveIndex = 0;
  bounceId: number | null = null;

  way = 0;
  level = 0;
  turnSpeed = 0;
  shieldLim = 0;

  waitTimer = 200;
  shootTimer = 0;
  flameTimer = 0;
  outSafeTimer = 100;

  shootRate = 30;
  cooldown = 200;

  weapons: Rafale[] = [];
  rafale: Rafale | null = null;

  fire: Container | null = null;
  follow: Container | null = null;
  turn: Container | null = null;
  // Source's follow logic assumes the sub-clip's natural orientation is
  // east-facing (rotation 0 = barrel pointing right). The port's bads/<n>.png
  // atlas frames are drawn south-facing, so for `skinView`-based follow we
  // shift the local rotation by -π/2 to compensate. Factories that wire
  // `follow` against the south-facing skin sprite set this to `-Math.PI/2`.
  followAngleOffset = 0;

  bList: number[] = [];
  partList: { b: Bads; dx: number; dy: number }[] = [];

  ond = {
    decal: 314,
    speed: 16,
    amp: 0.1,
    by: 50,
    vx: 3,
    sens: 1,
    svy: 0,
  };
  rect: { rw: number; rh: number } | null = null;

  beeRange: BeeRange[] = [];
  seekerLimit = 0;

  // Stub callbacks; overridden by Stykades.gen* factories.
  onTargetReach: () => void = () => {};
  onDeath: () => void = () => {};

  // Display sprite that swaps based on `setSkin()`. Exposed so factories can
  // wire `turn`/`follow` against it (the source attaches `b.root.smc` etc.).
  skinView: PixiSprite | null = null;

  constructor(game: IronChouquetteGame, root?: Container) {
    super(game, root ?? new Container());
    this.game.badsList.push(this);
    if (this.root.parent === null) {
      this.game.badsLayer.addChild(this.root);
    }
    this.ray = 16;
  }

  setLevel(lvl: number): void {
    if (this.level !== null) this.game.boss.monsterLevel -= this.level;
    this.level = lvl;
    this.game.boss.monsterLevel += this.level;
  }

  setRect(w: number, h: number): void {
    this.rect = { rw: w, rh: h };
    this.ray = Math.min(w, h);
  }

  setScore(sc: number): void {
    this.score = sc;
  }

  // Maps to root.gotoAndStop(string(n)). Original mcBads has 20 frames; assets/bads/<n>.png
  // mirror those frames 1..20.
  setSkin(n: number): void {
    const idx = Math.max(0, Math.min(n - 1, this.game.assets.bads.length - 1));
    if (this.skinView) {
      this.skinView.removeFromParent();
      this.skinView.destroy();
    }
    const sp = makeSprite(this.game.assets.bads[idx]);
    sp.anchor.set(0.5);
    this.root.addChild(sp);
    this.skinView = sp;
  }

  // setSubSkin in source called allGoto(root, "$sub", fr) — affects sub-MovieClips.
  // We have no sub-clips; track the requested frame for parity but don't render it.
  setSubSkin(_fr: number): void {
    // intentionally a no-op in the port.
  }

  override update(): void {
    this.updateBehaviour();
    this.updateFlash();
    this.checkCols();
    this.updateShoot();
    this.updateParts();
    if (this.bounceId !== null) this.bounceFamily();

    if (this.flOrient) {
      this.root.rotation = Math.atan2(this.vy, this.vx);
    }

    if (this.follow && this.game.hero) {
      const dx = this.game.hero.x - this.x;
      const dy = this.game.hero.y - this.y;
      this.follow.rotation = Math.atan2(dy, dx) - this.root.rotation + this.followAngleOffset;
    }

    if (this.turn) {
      this.turn.rotation += this.vy * 8 * TMOD * 0.0174;
    }

    if (this.outSafeTimer > 0) {
      this.outSafeTimer -= TMOD;
    } else {
      let lim = 10;
      if (this.ray !== null) lim += this.ray;
      if (this.rect) lim += Math.max(this.rect.rw, this.rect.rh);
      if (this.isOut(lim)) this.kill();
    }

    super.update();
  }

  dropBonus(): void {
    // Spawned via Bonus class; placed at this Bads' position.
    this.game.spawnBonus(this.x, this.y);
  }

  // Collisions vs hero (body/laser/speed-aura).
  checkCols(): void {
    const h = this.game.hero;
    if (!h) return;

    let flHit = this.getDist(h) < this.ray + h.ray;
    if (this.rect) {
      flHit = Math.abs(h.x - this.x) < this.rect.rw + h.ray && Math.abs(h.y - this.y) < this.rect.rh + h.ray;
    }
    if (flHit) this.heroCollide();

    // LASER (Hero.WP_LASER) — list of points along laser ray.
    // Source `Bads.mt:181-211`: per-frame, per-laser-point hit, 1-in-`int((3/tmod)/PM)`
    // chance to spawn a `partLaser` particle that drifts outward from the bad's
    // edge with random angle / speed / scale, additive blend, ~10..20-tick life.
    // The visual is the bright spark trail you see flicking off enemies under
    // the Speed-sacrifice laser ray. The asset (`part-laser.png`) was loaded
    // at `assets.partLaser` since R1 but never spawned — the laser hit just
    // dealt damage with no spark feedback. R23 ports the spawn 1:1.
    const power = h.weapons[WP_LASER][0];
    const rl = 2 + h.weapons[WP_LASER][1] * 2.5;
    if (power > 0 && h.laserList) {
      for (let i = 0; i < h.laserList.length; i += 1) {
        const pos = h.laserList[i];
        let lh = Math.abs(pos[0] - this.x) + Math.abs(pos[1] - this.y) < this.ray + rl;
        if (this.rect) {
          lh = Math.abs(pos[0] - this.x) < this.rect.rw + rl && Math.abs(pos[1] - this.y) < this.rect.rh + rl;
        }
        if (lh) {
          // `Std.random(int((3/tmod)/PM))==0`. With PM=1, TMOD=1 ⇒ ~33%/frame.
          const denom = Math.max(1, Math.trunc((3 / Math.max(0.0001, TMOD)) / this.game.PM));
          if (randInt(denom) === 0) this.spawnLaserHitPart(power);
          this.damage((0.02 + power * 0.05) * TMOD);
          break;
        }
      }
    }

    // SPEED aura (WP_SPEED) — source `Bads.mt:214-232` samples plasma layer 0
    // at the bad's screen position and tests `o.g == 0 && o.r * 1.2 > 50` to
    // detect overlap with the red speed-weapon halo (Hero.control draws
    // mcSpeed into plasma layer 0 every frame while WP_SPEED is active). On
    // hit it damages by `(0.07 + 1*c)*tmod` where `c = (score-50)/(255-50)`,
    // and spawns a `partStatic` particle at a randomised offset.
    //
    // R22 ports this 1:1: ensures the per-frame plasma-layer-0 readback
    // buffer is populated (one extract per frame, gated on Speed being
    // active), then samples it at `(this.x, this.y)`. Falls back to the
    // R1 radial heuristic when extract returned null (teardown / first
    // frame) so the path is never silently dead.
    if (h.weapons[WP_SPEED][0] > 0) {
      this.game.samplePlasmaLayer0();
      const px = this.game.getPlasma0Pixel(this.x, this.y);
      if (px) {
        const lim = 50;
        const score = px.r * 1.2;
        if (px.g === 0 && score > lim) {
          const c = (score - lim) / (255 - lim);
          this.damage((0.07 + 1 * c) * TMOD);
          // Source partStatic spawn (mcPartStatic, 5 frames, additive).
          // Uses `mc._xscale = 100+c*100` ⇒ scale 1..2; `_rotation` random.
          this.spawnSpeedHitStatic(c);
        }
      } else {
        // Fallback: R1 radial heuristic — kept so a transient extract
        // failure doesn't make the speed weapon stop hurting enemies.
        const hx = h.x;
        const hy = h.y;
        const haloR = (60 + h.weapons[WP_SPEED][0] * 40) * 1.7 * 0.5;
        if (Math.abs(this.x - hx) < haloR && this.y < hy && Math.abs(this.y - hy) < haloR) {
          this.damage((0.07 + 0.5) * TMOD);
        }
      }
    }
  }

  // Spawn a `partStatic` particle on a speed-aura hit, mirroring
  // `Bads.mt:224-231` (the `attach("partStatic",DP_PARTS)` plus position /
  // scale / rotation / blendMode setup). The extracted partStatic asset is a
  // 5-frame folder; we cycle it via `Part.frames` over a short timer so the
  // animation plays once per hit. `c` is the source's intensity coefficient
  // `(score-50)/205` — drives both `_xscale = 100+c*100` ⇒ Pixi scale 1..2.
  private spawnSpeedHitStatic(c: number): void {
    const frames = this.game.assets.partStatic;
    if (!frames || frames.length === 0) return;
    const root = new Container();
    const sp = makeSprite(frames[0]);
    sp.anchor.set(0.5);
    root.addChild(sp);
    this.game.partsLayer.addChild(root);
    const p = new Part(this.game, root);
    p.frames = frames;
    p.x = this.x + (Math.random() * 2 - 1) * this.ray;
    p.y = this.y + (Math.random() * 2 - 1) * this.ray;
    const xs = 1 + c; // 100+c*100 percent ⇒ 1..2 in Pixi.
    p.setScale(xs * 100);
    p.rotationDeg = Math.random() * 360;
    p.root.blendMode = 'add';
    // Source partStatic timeline length: 5 frames; give it ~5 ticks of life
    // so it plays one cycle and fades, matching the SWF `removeMovieClip` at
    // end-of-timeline behaviour for a default-play MovieClip.
    p.timer = frames.length;
    p.fadeType = 0;
  }

  // Spawn a `partLaser` particle on a laser-ray hit, mirroring source
  // `Bads.mt:190-205`: random-angle outward velocity from the bad's edge,
  // scale `100 + power*10 + rand*50` (Pixi units 1.0..(1+0.1*power+0.5)),
  // 10..20-tick life, fadeType=0 (scale-fade), additive blend. The extracted
  // partLaser asset is a single PNG (no timeline), so we render it as a
  // static additive sprite that scale-shrinks over its lifetime — the source
  // MovieClip likewise just sits at frame 1 (no `gotoAndPlay` is issued by
  // the spawn path). `power` is `hero.weapons[WP_LASER][0]` ∈ {1,2,3,…} —
  // the laser-stack count, scales spark size with weapon strength.
  private spawnLaserHitPart(power: number): void {
    const frame = this.game.assets.partLaser;
    if (!frame) return;
    const root = new Container();
    const sp = makeSprite(frame);
    sp.anchor.set(0.5);
    root.addChild(sp);
    this.game.partsLayer.addChild(root);
    const p = new Part(this.game, root);
    const a = Math.random() * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const sp2 = 3 + Math.random() * 3;
    p.x = this.x + ca * this.ray;
    p.y = this.y + sa * this.ray;
    p.vx = ca * sp2 + this.vx;
    p.vy = sa * sp2 + this.vy;
    // Source: `_xscale = 100 + power*10 + rand*50` ⇒ 1.0..(1 + 0.1*power + 0.5).
    p.setScale(100 + power * 10 + Math.random() * 50);
    p.timer = 10 + Math.random() * 10;
    p.fadeType = 0;
    p.root.blendMode = 'add';
    // `p.fadeLimit` defaults to 10 (Part ctor); source's animation clip plays
    // for the same window, so the scale-fade reads identically over the
    // 10-frame tail of the lifetime.
  }

  heroCollide(): void {
    const h = this.game.hero;
    if (!h) return;
    if (h.invincibleTimer === null) {
      h.explode();
    }
    this.score = null;
    this.damage(10);
  }

  bounceFamily(): void {
    const list = this.game.badsList;
    for (let i = 0; i < list.length; i += 1) {
      const b = list[i];
      if (b === this || b.bounceId !== this.bounceId) continue;
      const dist = this.getDist(b);
      const dif = (this.ray + b.ray) - dist;
      if (dif > 0) {
        const ang = this.getAng(b);
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        this.x -= ca * dif * 0.5;
        this.y -= sa * dif * 0.5;
        b.x += ca * dif * 0.5;
        b.y += sa * dif * 0.5;
      }
    }
  }

  updateBehaviour(): void {
    if (this.shootTimer > 0) this.shootTimer -= TMOD;
    if (this.waitTimer > 0) this.waitTimer -= TMOD;

    for (let i = 0; i < this.bList.length; i += 1) {
      const n = this.bList[i];
      switch (n) {
        case 0:
          this.behaviorPath();
          break;
        case 1:
          this.va += (Math.random() * 2 - 1) * 0.06;
          this.va *= Math.pow(0.8, TMOD);
          this.a += this.va;
          this.updateVit();
          break;
        case 2:
          this.ond.decal = (this.ond.decal + this.ond.speed * TMOD) % 628;
          this.a += Math.cos(this.ond.decal / 100) * this.ond.amp;
          this.updateVit();
          break;
        case 3: {
          if (!this.trg) break;
          let da = this.getAng(this.trg) - this.a;
          while (da > Math.PI) da -= Math.PI * 2;
          while (da < -Math.PI) da += Math.PI * 2;
          this.a += Math.min(Math.max(da * this.turnCoef, -this.va), this.va) * TMOD;
          this.vx = Math.cos(this.a) * this.speed;
          this.vy = Math.sin(this.a) * this.speed;
          if (this.getDist(this.trg) < 50) this.onTargetReach();
          break;
        }
        case 4:
          if (this.shootTimer <= 0) {
            if (randInt(Math.max(1, Math.trunc(this.shootRate / TMOD))) === 0) this.initShot();
          }
          break;
        case 5:
          if (this.vy > 0) {
            if (this.y >= this.ond.by) {
              this.ond.svy = this.vy;
              this.vy = 0;
              this.y = this.ond.by;
              this.ond.decal = 0;
            }
          } else if (this.vy < 0) {
            // moving up — wait until off-screen
          } else {
            this.ond.decal = (this.ond.decal + this.ond.speed * TMOD) % 628;
            this.y = this.ond.by + Math.sin(this.ond.decal / 100) * (this.ond.amp * 100);
            this.x += this.ond.vx * this.ond.sens * TMOD;
            const m = 10;
            if (this.x < this.ray + m || this.x > STAGE_WIDTH - (this.ray + m)) {
              this.ond.sens *= -1;
              this.x = Math.min(Math.max(this.x, this.ray + m), STAGE_WIDTH - (this.ray + m));
            }
            if (this.waitTimer <= 0) this.vy = -this.ond.svy;
          }
          break;
        case 6:
          if (!this.trg) this.chooseBeeTrg();
          if (this.trg && this.acc) {
            this.speedToward(this.trg, this.acc.c, this.acc.lim);
            const dx = this.trg.x - this.x;
            const dy = this.trg.y - this.y;
            if (Math.abs(dx) + Math.abs(dy) < 20 + this.ray) this.trg = null;
          }
          break;
        case 7:
          if (this.game.hero) {
            const pa = 0.3;
            const da = hMod(this.getAng(this.game.hero) - 1.57, 3.14);
            if (Math.abs(da) < pa && this.getDist(this.game.hero) < 100) {
              this.flameTimer = 8;
            }
            if (this.flameTimer > 0) {
              this.flameTimer -= TMOD;
              const root = new Container();
              this.game.shotsLayer.addChild(root);
              const shot = new Shot(this.game, root);
              shot.setSkin(22, 1);
              const ang = 1.57 + (Math.random() * 2 - 1) * pa;
              const sp = 5 + Math.random() * 3;
              shot.x = this.x + Math.cos(ang) * this.ray;
              shot.y = this.y + Math.sin(ang) * this.ray;
              shot.vx = Math.cos(ang) * sp;
              shot.vy = Math.sin(ang) * sp;
              shot.ray = 8;
              shot.timer = 10 + Math.random() * 10;
              shot.vr = (Math.random() * 2 - 1) * 20;
              shot.root.blendMode = 'add';
              shot.plasmaId = 1;
              shot.updatePos();
            }
          }
          break;
        case 8:
          if (this.y > this.seekerLimit) {
            this.vy = 0;
            this.bList.splice(i, 1);
            this.bList.push(3);
            this.trg = this.game.hero;
            this.hp = 2;
            this.score = this.score2;
            this.flOrient = true;
            i -= 1;
          }
          break;
        case 9:
          if (this.waitTimer > 0) {
            if (this.trg && this.y > this.trg.y) {
              if (this.vy > 0) this.shootTimer = 0;
              this.vy = 0;
            }
          } else {
            this.vy -= 0.3;
            this.shootTimer = 200;
          }
          break;
        case 10: {
          // Shield: push hero shots away
          for (let k = 0; k < this.game.shotList.length; k += 1) {
            const shot = this.game.shotList[k];
            if (shot.flGood && shot.skinFrame !== 14) {
              const dist = this.getDist(shot);
              if (dist < this.shieldLim) {
                const d = this.shieldLim - dist;
                shot.x += Math.cos(this.a) * d;
                shot.y += Math.sin(this.a) * d;
              }
            }
          }
          break;
        }
      }
    }
  }

  private behaviorPath(): void {
    const wave = this.wave;
    if (!wave) return;
    const sp = wave.speed * TMOD;
    this.way += sp * this.speedCoef;
    if (this.way > wave.pl[this.pathIndex]) {
      this.pathIndex += 1;
      if (this.pathIndex === wave.pl.length) {
        this.kill();
        return;
      }
      const p0 = wave.path[this.pathIndex - 1];
      const p1 = wave.path[this.pathIndex];
      const dx = p1[0] - p0[0];
      const dy = p1[1] - p0[1];
      const ang = Math.atan2(dy, dx);
      const op = wave.pl[this.pathIndex - 1];
      const ecart = wave.pl[this.pathIndex] - op;
      const c = (this.way - op) / ecart;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      this.x = p0[0] + ca * c * sp;
      this.y = p0[1] + sa * c * sp;
      if (!wave.flLinear) this.speedCoef = (ecart / 5) / wave.speed;
      this.vx = ca * wave.speed * this.speedCoef;
      this.vy = sa * wave.speed * this.speedCoef;
      const marker = p0[2];
      if (marker === 0) {
        this.initShot();
      } else if (marker === 1) {
        for (let k = 0; k < wave.bList.length; k += 1) {
          wave.bList[k].initShot();
        }
        p0.splice(2, 1);
      }
    }
  }

  updateVit(): void {
    this.vx = Math.cos(this.a) * this.speed;
    this.vy = Math.sin(this.a) * this.speed;
  }

  initShot(): void {
    if (this.weapons.length === 0) return;
    let max = 0;
    for (let i = 0; i < this.weapons.length; i += 1) max += this.weapons[i].w;
    const rid = randInt(max);
    let sum = 0;
    for (let i = 0; i < this.weapons.length; i += 1) {
      const raf = this.weapons[i];
      sum += raf.w;
      if (sum > rid) {
        raf.init();
        break;
      }
    }
  }

  updateShoot(): void {
    if (this.shootTimer === null || this.shootTimer === undefined) return;
    if (!this.rafale) {
      this.shootTimer -= TMOD;
      if (this.shootTimer <= 0) this.initShot();
    } else {
      this.rafale.update();
    }
  }

  newRafale(): Rafale {
    if (!this.weapons) this.weapons = [];
    const raf = new Rafale(this);
    this.weapons.push(raf);
    return raf;
  }

  hit(shot: Shot): void {
    this.damage(shot.damage);
  }

  damage(n: number): void {
    this.flash = 100;
    this.hp -= n;
    if (this.hp <= 0) {
      if (!this.flDeath) this.die();
    }
  }

  die(): void {
    this.onDeath();
    if (this.score !== null && this.score > 0) {
      this.game.addScore(this.score);
      // Source `Bads.mt:die` (lines 562-569): when the per-kill score exceeds
      // `scoreDisplayLimit` (100), spawn a `partScore` floating popup at the
      // enemy position with the score as text + blue glow. Asset (`partScore`,
      // 11 frames) was loaded but unused before this pass.
      if (this.score > Bads.scoreDisplayLimit) {
        const root = new Container() as PartScoreRoot;
        this.game.partsLayer.addChild(root);
        const p = new PartScore(this.game, root, this.score);
        p.x = this.x;
        p.y = this.y;
        // Mirror source `Bads.die`:
        //   downcast(p.root).compt  = 10;
        //   downcast(p.root).score = v;
        // The `compt`/`score` properties are read by PartScore.update each tick
        // (R20 _parent.score TextField data binding). `score` is also seeded in
        // PartScore's constructor; we re-assign it here so the assignment site
        // matches source 1:1 and any mid-life mutation by callers would
        // propagate to the bound TextField.
        root.compt = 10;
        root.score = this.score;
        // Source applies `Cs.glow(p.root, 6, 5, 0x0000FF)` — a blue 6px-blur
        // GlowFilter. Pixi v8 core has no GlowFilter (lives in pixi-filters,
        // not installed here), so we approximate with a soft blue stroke on
        // the Text already and leave a comment for future enrichment.
      }
    }
    this.explode();
    this.kill();
  }

  explode(): void {
    const max = Math.max(1, Math.floor(5 * this.game.PM));
    for (let i = 0; i < max; i += 1) {
      const root = new Container();
      // Source `Bads.mt:595`: `var p = new Part(...attach("mcExploPart",...))` with
      // no explicit gotoAndPlay — Flash auto-plays from frame 1, equivalent to
      // port frame 0. The initial-texture random pick was a port artefact: the
      // first update tick overwrites the texture to `frames[1]` so the random
      // initial frame was visible for ≤ 1 tick before the standard frame walker
      // took over. Restored frame-0 start to match source auto-play semantics
      // (paired with the partSparkSpeed `gotoAndPlay(Std.random()+1)` fix in
      // `Hero.control`, which intentionally *does* phase-shift its starting
      // frame because source explicitly calls it out).
      const sp = makeSprite(this.game.assets.exploPart[0]);
      sp.anchor.set(0.5);
      root.addChild(sp);
      this.game.partsLayer.addChild(root);
      const p = new Part(this.game, root);
      p.setScale(20 + Math.random() * 30);
      const ang = Math.random() * 6.28;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const ray = 8;
      const speed = 3 + Math.random() * 5;
      p.x = this.x + ca * ray;
      p.y = this.y + sa * ray;
      p.vx = ca * speed;
      p.vy = sa * speed + this.game.SCROLL_SPEED * (0.6 + Math.random() * 0.4);
      p.plasmaId = 1;
      p.timer = 10 + Math.random() * 10;
      p.frames = this.game.assets.exploPart;
      p.root.blendMode = 'add';
      p.rotationDeg = Math.random() * 360;
    }

    // Source `Bads.explode` follows the particle burst with three additive
    // mcExploTrace stamps into plasma layer 1 — the bright glow trail every
    // enemy death leaves on plasma layer 1. Source uses `gotoAndStop("3")`
    // (frame 3 of the 3-frame mcExploTrace MovieClip) and reuses one MovieClip
    // for all three stamps with random per-stamp position/scale/rotation.
    // Asset pipeline: `exploTrace` 3 frames map to atlas indices 0/1/2;
    // source frame "3" is index 2.
    const traceRay = 8;
    const traceFrame = this.game.assets.exploTrace[Math.min(2, this.game.assets.exploTrace.length - 1)];
    const trace = makeSprite(traceFrame);
    trace.anchor.set(0.5);
    trace.blendMode = 'add';
    for (let i = 0; i < 3; i += 1) {
      trace.x = this.x + (Math.random() * 2 - 1) * traceRay;
      trace.y = this.y + (Math.random() * 2 - 1) * traceRay;
      const xs = (100 + Math.random() * 100) / 100;
      trace.scale.set(xs, xs);
      trace.rotation = Math.random() * Math.PI * 2;
      this.game.plasmaDraw(trace as unknown as Container, 1);
    }
    trace.destroy();
  }

  setPart(b: Bads, dx: number, dy: number): void {
    if (!this.partList) this.partList = [];
    this.partList.push({ b, dx, dy });
  }

  updateParts(): void {
    for (let i = 0; i < this.partList.length; i += 1) {
      const o = this.partList[i];
      o.b.x = this.x + o.dx;
      o.b.y = this.y + o.dy;
    }
  }

  chooseBeeTrg(): void {
    let max = 0;
    for (let i = 0; i < this.beeRange.length; i += 1) max += this.beeRange[i].w;
    const rid = randInt(max);
    let cur = 0;
    for (let i = 0; i < this.beeRange.length; i += 1) {
      const o = this.beeRange[i];
      cur += o.w;
      if (cur > rid) {
        this.trg = {
          x: o.xMin + Math.random() * (o.xMax - o.xMin),
          y: o.yMin + Math.random() * (o.yMax - o.yMin),
        };
        break;
      }
    }
  }

  chooseNewTarget(xMin: number, xMax: number, yMin: number, yMax: number): void {
    if (this.waitTimer <= 0) {
      this.trg = { x: this.x, y: -200 };
      return;
    }
    this.trg = {
      x: xMin + Math.random() * (xMax - xMin),
      y: yMin + Math.random() * (yMax - yMin),
    };
  }

  override kill(): void {
    if (this.killed) return;
    for (let i = 0; i < this.partList.length; i += 1) {
      const b = this.partList[i].b;
      if (!b.flDeath && b.flSide) b.die();
    }
    this.partList = [];
    this.flDeath = true;
    if (this.level !== null) this.game.boss.monsterLevel -= this.level;
    if (this.wave) {
      const idx = this.wave.bList.indexOf(this);
      if (idx >= 0) this.wave.bList.splice(idx, 1);
    }
    const idx = this.game.badsList.indexOf(this);
    if (idx >= 0) this.game.badsList.splice(idx, 1);
    super.kill();
  }
}
