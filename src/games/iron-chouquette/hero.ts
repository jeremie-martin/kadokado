import { ColorMatrixFilter, Container, Graphics, Sprite as PixiSprite } from 'pixi.js';
import { Phys } from './phys';
import { Part, PartInvincibility, PartTrace } from './part';
import { Shot } from './projectiles';
import {
  TMOD, randInt, hMod, clamp,
  WP_PLASMA, WP_SIDER, WP_LASER, WP_SPEED, WP_VOID, WP_MISSILE,
  HERO_RAY, HERO_INVINCIBLE_RAY,
  STAGE_WIDTH, STAGE_HEIGHT,
} from './constants';
import type { IronChouquetteGame } from './game';
import type { Bads } from './bads';
import { makeSprite, setFrame, type Frame } from '../_shared/frames';

// Hero.mt — the player ship. 6 weapon types, 3 active slots, sacrifice mechanic.
// State machine: control() handles input, updateShoot() dispatches per-weapon volleys,
// and special abilities (laser invincibility, big-laser, black-hole, sonic boom)
// each have their own update routines.

type LaserTrg = {
  x: number;
  y: number;
  ray: number;
  damage: ((n: number) => void) | null;
  flDeath: boolean;
  shieldLim: number | null;
};

type BigLaserRayBit = {
  view: PixiSprite;
  vr: number;
  t: number;
};

type BigLaser = {
  view: Container;
  ray: PixiSprite;
  rayScale: number;
  list: BigLaserRayBit[];
  t: number;
};

type Onde = {
  view: PixiSprite;
  list: Bads[];
  scale: number;
  x: number;
  y: number;
};

type BlackHoleEntry = {
  part: Part;
  mask: Container | null;
  blackFilter: ColorMatrixFilter | null;
  black: number;
  ray: number;
};

type BlackHole = {
  view: Container;
  scale: number;
  rotationDeg: number;
  vr: number;
  step: number;
  x: number;
  y: number;
  list: BlackHoleEntry[];
};

export class Hero extends Phys {
  flControl = false;

  slotMax = 3;
  speed = 3.6;
  rollX = 0;
  rollY = 0;
  invincibleTimer: number | null = null;
  private invincibleFilter: ColorMatrixFilter | null = null;

  // Laser fields.
  laserStartAngle = 0;
  laserTrg: LaserTrg | null = null;
  laserFlip = 0;
  laserList: number[][] | null = null;
  laserGfx: Graphics;
  laserRay: BigLaser | null = null;

  // Sonic boom.
  onde: Onde | null = null;
  blackHole: BlackHole | null = null;

  // Slot/weapon state.
  boxes: PixiSprite[] = [];
  slots: number[] = [];
  weapons: number[][] = [];

  // Hero animation frames (mcHero — frames 1..20).
  private heroSprite: PixiSprite;

  constructor(game: IronChouquetteGame) {
    const root = new Container();
    super(game, root);
    this.game.heroLayer.addChild(this.root);

    this.ray = HERO_RAY;
    this.frict = 0.6;

    // gotoAndStop("10") — Flash frames are 1-indexed, so atlas index 9 is the neutral idle.
    const frame: Frame = this.game.assets.hero[Math.min(9, this.game.assets.hero.length - 1)];
    this.heroSprite = makeSprite(frame);
    this.heroSprite.anchor.set(0.5);
    this.root.addChild(this.heroSprite);

    this.laserGfx = new Graphics();

    this.weapons = [];
    for (let i = 0; i < 6; i += 1) {
      this.weapons.push([i === 0 ? 1 : 0, 0]);
    }

    for (let i = 0; i < 3; i += 1) this.addBox();

    this.x = STAGE_WIDTH * 0.5 - 5;
    this.y = STAGE_HEIGHT + this.ray;
  }

  override update(): void {
    super.update();

    if (this.flControl) {
      this.control();
      this.updateShoot();
    } else {
      this.y -= 0.8 * TMOD;
    }

    if (this.onde) this.updateOnde();
    if (this.laserRay) this.updateLaserRay();
    if (this.blackHole) this.updateBlackHole();
    if (this.invincibleTimer !== null) this.updateInvincible();

    if (!this.flControl && this.game.boss.dif > 56) {
      this.game.SCROLL_SPEED += 2.4;
      this.flControl = true;
    }
  }

  private updateInvincible(): void {
    if (this.invincibleTimer === null) return;
    this.invincibleTimer -= TMOD;
    // Source: Cs.setPercentColor(root, 70 + Math.cos(invincibleTimer*0.5)*20, 0xFFFFFF).
    // Per-channel lerp toward white via ColorMatrixFilter: diag=1-c, offset=c.
    // ColorMatrix can brighten beyond texture white (multiplicative tint cannot).
    const prc = 70 + Math.cos(this.invincibleTimer * 0.5) * 20;
    const c = Math.min(Math.max(prc, 0), 100) / 100;
    const k = 1 - c;
    const fl = this.invincibleFilter ?? new ColorMatrixFilter();
    fl.matrix = [
      k, 0, 0, 0, c,
      0, k, 0, 0, c,
      0, 0, k, 0, c,
      0, 0, 0, 1, 0,
    ];
    if (!this.invincibleFilter) {
      this.invincibleFilter = fl;
      this.heroSprite.filters = [fl];
    }
    const size = Math.min(this.invincibleTimer / 50, 1);
    // Spawn invincibility particles.
    const root = new Container();
    const sp = makeSprite(this.game.assets.partInvincibility);
    sp.anchor.set(0.5);
    root.addChild(sp);
    this.game.underPartsLayer.addChild(root);
    const p = new PartInvincibility(this.game, root);
    const a = Math.random() * 6.28;
    const speed = 1.5 + Math.random() * 1.5;
    p.x = this.x;
    p.y = this.y - 6;
    p.vx = Math.cos(a) * speed;
    p.vy = Math.sin(a) * speed + 4;
    p.plasmaId = 1;
    p.timer = 10;
    p.fadeType = 0;
    p.root.blendMode = 'add';
    p.setScale((150 + Math.random() * 100) * size);

    // Source `Hero.mt:142-147`: 1-in-3 per-frame chance to attach a fresh
    // mcLaserLight MovieClip as a child of the partInvincibility part. The clip
    // auto-plays its 9-frame timeline; with `timer = 10` the host part dies just
    // after the clip finishes one full cycle. Distinct random per-spawn rotation
    // and scale make the burst feel chaotic. Asset (`laserLight`, 9 frames) is
    // already loaded but was unused before this pass.
    if (Math.random() * 3 < 1 && this.game.assets.laserLight.length > 0) {
      p.attachLaserLight(this.game.assets.laserLight);
    }

    if (this.invincibleTimer < 0) {
      this.invincibleTimer = null;
      this.ray = HERO_RAY;
      this.heroSprite.tint = 0xffffff;
      if (this.invincibleFilter) {
        this.heroSprite.filters = [];
        this.invincibleFilter = null;
      }
    }
  }

  private control(): void {
    const boost = this.weapons[WP_SPEED][0];
    const sp = Math.min(this.speed + boost * 1.6, 10) * TMOD;

    let mx = 0;
    let my = 0;
    const bent = 0.25;
    const keys = this.game.keys;
    if (keys.has('ArrowLeft')) {
      mx -= sp;
      this.laserStartAngle -= bent;
      this.rollX -= TMOD * 5;
    }
    if (keys.has('ArrowRight')) {
      mx += sp;
      this.laserStartAngle += bent;
      this.rollX += TMOD * 5;
    }
    if (keys.has('ArrowUp')) {
      my -= sp;
      this.rollY -= TMOD * 3.5;
    }
    if (keys.has('ArrowDown')) {
      my += sp;
      this.rollY += TMOD * 3.5;
    }
    this.rollX *= 0.6;
    this.rollY *= Math.pow(0.87, TMOD);
    this.laserStartAngle *= Math.pow(0.94, TMOD);

    // Speed boost: glowing aura drawn into plasma layer 0 + spark particles.
    if (boost > 0) {
      // Aura: source loops k=0..max=2, drawing mcSpeed at hero+offset*coef and at random
      // ring positions (3 satellites) per pass, all into plasma layer 0.
      const speedFrames = this.game.assets.speed;
      const speedFrameIdx = clamp(boost - 1, 0, speedFrames.length - 1);
      const auraFrame = speedFrames[speedFrameIdx];
      const max = 2;
      for (let k = 0; k < max; k += 1) {
        const coef = k / max;
        const auraScale = ((120 + boost * 40) * 1.7) / 100;
        const aura = makeSprite(auraFrame);
        aura.anchor.set(0.5);
        aura.x = this.x + mx * coef;
        aura.y = this.y + (my + this.game.SCROLL_SPEED) * coef;
        aura.scale.set(auraScale);
        this.game.plasmaDraw(aura as unknown as Container, 0);
        // 3 satellites in a random ring around the hero, all into plasma 0.
        for (let i = 0; i < 3; i += 1) {
          const ang = Math.random() * 6.28;
          const ring = 20 + Math.random() * 50;
          const satScale = (100 + Math.random() * 150) / 100;
          aura.x = this.x + Math.cos(ang) * ring;
          aura.y = this.y + Math.sin(ang) * ring;
          aura.scale.set(satScale);
          this.game.plasmaDraw(aura as unknown as Container, 0);
        }
        aura.destroy();
      }

      const r = this.ray * (((60 + boost * 40) * 1.7) / 100) * 1.3;
      for (let i = 0; i < boost; i += 1) {
        const root = new Container();
        // Source `Hero.mt:224`: `p.root.gotoAndPlay( string( Std.random(p.root._totalframes)+1 ) )`
        // — each spark begins at a random timeline frame and plays forward, so a
        // burst of `boost` sparks per tick reads as chaotic phase-shifted glints
        // rather than a synchronised flicker. The port previously left
        // `Part.frameIndex = 0` for every spawn (lockstep animation across all
        // sparks), then on the first update tick overwrote the visible texture
        // from the precomputed random `sparkFrame`. Now we seed both the visible
        // texture *and* `Part.frameIndex` from the same random index so the
        // forward walk continues from there, matching source's
        // `gotoAndPlay(Std.random(N)+1)` semantics 1:1.
        const sparkFrames = this.game.assets.partSparkSpeed;
        const sparkStart = randInt(sparkFrames.length);
        const spr = makeSprite(sparkFrames[sparkStart]);
        spr.anchor.set(0.5);
        root.addChild(spr);
        this.game.underPartsLayer.addChild(root);
        const p = new Part(this.game, root);
        p.frames = sparkFrames;
        p.frameIndex = sparkStart;
        p.x = this.x + (Math.random() * 2 - 1) * r;
        p.y = this.y + (Math.random() * 2 - 1) * r;
        p.setScale(10 + Math.random() * (15 + boost * 5));
        p.vy = this.game.SCROLL_SPEED;
        p.timer = 20 + Math.random() * 10;
      }
    }

    this.x += mx;
    this.y += my;

    // Source: `frame = 1 + int(mm(0, 10+rollX, 20))` (1-indexed). Centre is 11.
    // In 0-indexed terms that's index 10 at neutral, so subtract 1 from the source value.
    const frameIdx = clamp(Math.floor(rollClamp(this.rollX)), 0, this.game.assets.hero.length - 1);
    setFrame(this.heroSprite, this.game.assets.hero[frameIdx]);

    this.checkBounds();
  }

  // WEAPON management
  addWeapon(id: number): void {
    if (this.slots.length === this.boxes.length) {
      this.sacrifice(0);
    }
    this.weapons[id][0] += 1;
    this.slots.push(id);
    this.updateBoxes();
  }

  addBox(): void {
    const box = makeSprite(this.game.assets.slot[0]);
    // Source Hero.mt addBox uses Flash MovieClip default top-left anchor
    // and pins _x=8, _y = mch-(8 + boxes.length*14). Anchor 0.5 in earlier
    // ports shifted slot centres up by 6 px and left by 6 px vs source.
    box.anchor.set(0, 0);
    box.x = 8;
    box.y = STAGE_HEIGHT - (8 + this.boxes.length * 14);
    this.game.interLayer.addChild(box);
    this.boxes.push(box);
  }

  updateBoxes(): void {
    for (let i = 0; i < this.boxes.length; i += 1) {
      const id = this.slots[i];
      const frameIdx = clamp((id ?? -1) + 1, 0, this.game.assets.slot.length - 1);
      setFrame(this.boxes[i], this.game.assets.slot[frameIdx]);
    }
  }

  sacrifice(n?: number | null): void {
    if (this.slots.length === 0) return;
    const idx = n ?? this.slots.length - 1;
    const id = this.slots[idx];
    this.weapons[id][0] -= 1;
    this.slots.splice(idx, 1);
    this.updateBoxes();

    switch (id) {
      case WP_PLASMA: {
        const shot = this.newShot(0, 14);
        shot.setSkin(18, 1);
        shot.ray = 50;
        shot.damage = 50;
        shot.flPierce = true;
        shot.bList.push(11);
        break;
      }
      case WP_SIDER: {
        if (this.onde) this.onde.view.removeFromParent();
        const sp = makeSprite(this.game.assets.sonicBoom);
        sp.anchor.set(0.5);
        sp.scale.set(0.8);
        sp.x = this.x;
        sp.y = this.y;
        this.game.underPartsLayer.addChild(sp);
        this.onde = { view: sp, list: [], scale: 80, x: this.x, y: this.y };
        break;
      }
      case WP_VOID: {
        if (this.blackHole) break;
        const view = new Container();
        const bhSprite = makeSprite(this.game.assets.blackHole);
        bhSprite.anchor.set(0.5);
        view.addChild(bhSprite);
        view.x = this.x;
        view.y = this.y;
        view.scale.set(0.1);
        this.game.underPartsLayer.addChild(view);
        const bh: BlackHole = {
          view, scale: 10, rotationDeg: 0, vr: 10, step: 0,
          x: this.x, y: this.y,
          list: [],
        };
        // Suck in all enemies and enemy shots.
        const list: Phys[] = [];
        for (const b of this.game.badsList) list.push(b);
        for (const s of this.game.shotList) list.push(s);
        while (list.length > 0) {
          const b = list.pop();
          if (!b) continue;
          if (b.flash !== null) {
            b.flash = 0;
            b.updateFlash();
          }
          // Capture the visual root and re-parent under partsLayer as a Part.
          const captured = b.root;
          if (captured.parent) captured.parent.removeChild(captured);
          this.game.partsLayer.addChild(captured);
          const p = new Part(this.game, captured);
          p.x = b.x;
          p.y = b.y;
          p.vx = b.vx;
          p.vy = b.vy;
          p.frict = 0.94;
          p.ray = b.ray;
          // Detach b from update lists (we've stolen its root). Source nulls `b.root`
          // and calls `b.kill()` so the full bookkeeping cascade runs (decrements
          // `Stykades.monsterLevel`, drops the Bads from its `Wave.bList`, etc.). Pixi
          // can't safely null the root before we also need it as the captured Part, so
          // we replicate the kill() bookkeeping inline.
          if ('hp' in b) {
            const bb = b as Bads;
            bb.flDeath = true;
            // Source: `if(level!=null) Stykades.monsterLevel -= level` in Bads.kill.
            // Skipping this leaves monsterLevel inflated and the spawn dispatcher's
            // `monsterLevel < dif*0.01` gate stuck — new waves stop spawning after a
            // black-hole pull until enough difficulty accrues to overshoot the leak.
            if (bb.level !== null) this.game.boss.monsterLevel -= bb.level;
            if (bb.wave) {
              const wi = bb.wave.bList.indexOf(bb);
              if (wi >= 0) bb.wave.bList.splice(wi, 1);
            }
            const i = this.game.badsList.indexOf(bb);
            if (i >= 0) this.game.badsList.splice(i, 1);
          } else if ('flGood' in b) {
            const ss = b as Shot;
            const i = this.game.shotList.indexOf(ss);
            if (i >= 0) this.game.shotList.splice(i, 1);
          }
          // Mark the original Sprite as killed so any stray sList iteration skips it,
          // and pull it out of sList. The Part we just spawned has its own sList entry.
          b.killed = true;
          const si = this.game.sList.indexOf(b);
          if (si >= 0) this.game.sList.splice(si, 1);
          bh.list.push({ part: p, mask: null, blackFilter: null, black: 0, ray: b.ray });
        }
        this.blackHole = bh;
        break;
      }
      case WP_SPEED: {
        if (this.laserRay) break;
        const view = new Container();
        const ray = makeSprite(this.game.assets.bigLaser);
        ray.anchor.set(0.5, 1);
        view.addChild(ray);
        view.blendMode = 'add';
        view.x = this.x;
        view.y = this.y;
        this.game.underPartsLayer.addChild(view);
        const list: BigLaserRayBit[] = [];
        for (let i = 0; i < 12; i += 1) {
          const bit = makeSprite(this.game.assets.laserRay);
          bit.anchor.set(0.5, 1);
          bit.rotation = Math.random() * Math.PI * 2;
          bit.scale.set(1 + Math.random(), 1 + Math.random() * 5);
          bit.blendMode = 'add';
          view.addChild(bit);
          list.push({ view: bit, vr: (Math.random() * 2 - 1) * 5, t: 10 + Math.random() * 50 });
        }
        this.laserRay = { view, ray, rayScale: 0, list, t: 80 };
        break;
      }
      case WP_LASER: {
        this.invincibleTimer = 300;
        this.ray = HERO_INVINCIBLE_RAY;
        break;
      }
      case WP_MISSILE: {
        const max = 12;
        for (let i = 0; i < max; i += 1) {
          const shot = this.newMissile((6.28 * i) / max);
          shot.sleep = 6;
          shot.timer = 60;
        }
        break;
      }
      default: {
        // Empty slot sacrifice triggers bullet-time slow-mo.
        this.game.bt = { trg: 0.3, timer: 100, val: 1 };
        break;
      }
    }

    // Clean enemy shots.
    const allShots = this.game.shotList.slice();
    for (const s of allShots) {
      if (!s.flGood) s.kill();
    }
    this.game.flashouille = 100;
    this.game.lagTimer = -70;
    this.game.boss.nextWave = 100;
  }

  private updateShoot(): void {
    const keys = this.game.keys;
    const flFire = keys.has('Space') || keys.has('Alt') || keys.has('Enter');

    this.laserGfx.clear();

    for (let i = 0; i < 6; i += 1) {
      const a = this.weapons[i];
      if (a[0] <= 0) continue;
      if (a[1] > 0) a[1] = a[1] - TMOD;

      // Each weapon volleys until the firing cooldown re-loads.
      let safety = 16;
      while (flFire && a[1] <= 0 && !this.blackHole && !this.laserRay && safety-- > 0) {
        switch (i) {
          case WP_PLASMA: {
            switch (a[0]) {
              case 1: {
                const s = this.newShot(0, 12);
                s.setSkin(14, 1);
                s.ray = 6;
                s.damage = 1;
                break;
              }
              case 2:
                for (let n = 0; n < 2; n += 1) {
                  const s = this.newShot(0, 12);
                  s.setSkin(14, 1);
                  s.ray = 6;
                  s.x = this.x + (n * 2 - 1) * 5;
                  s.damage = 1;
                }
                break;
              case 3: {
                const big = this.newShot(0, 15);
                big.setSkin(14, 1);
                big.ray = 8;
                big.setScale(150);
                big.damage = 2;
                big.flPierce = true;
                for (let n = 0; n < 2; n += 1) {
                  const sens = n * 2 - 1;
                  const s = this.newShot(sens * 0.15, 12);
                  s.setSkin(14, 1);
                  s.ray = 8;
                  s.x = this.x + sens * 5;
                  s.damage = 1;
                }
                break;
              }
              default: {
                const big = this.newShot(0, 15);
                big.setSkin(14, 1);
                big.ray = 4 + a[0];
                big.setScale(100 + a[0] * 25);
                big.damage = 1 + a[0] * 0.5;
                big.flPierce = true;
                for (let n = 0; n < 2; n += 1) {
                  const sens = n * 2 - 1;
                  for (let k = 0; k < a[0] * 0.5; k += 1) {
                    const s = this.newShot(sens * (0.15 + k * 0.15), 12 - k * 1.5);
                    s.setSkin(14, 1);
                    s.ray = 8;
                    s.x = this.x + sens * (5 + k * 5);
                    s.damage = 1;
                  }
                }
              }
            }
            a[1] += 8;
            break;
          }
          case WP_SIDER: {
            for (let n = 0; n < 2; n += 1) {
              const max = Math.min(a[0], 6);
              for (let k = 0; k < max; k += 1) {
                const sens = n * 2 - 1;
                const c = max === 1 ? 0 : (k / (max - 1)) - 0.5;
                const ec = 0.3 + a[0] * 0.1;
                const shot = this.newShot(sens * (1.57 - this.rollY * 0.05) + ec * c, 14);
                shot.setSkin(16, 1);
                shot.damage = 0.85;
                shot.x += sens * 14;
                shot.y += 16;
                shot.orient();
                shot.updatePos();
                if (k > 1 && k < max - 1) {
                  shot.setScale(150);
                  shot.damage = 1.5;
                  shot.speed = 18;
                  shot.updateVit();
                  shot.x += sens * 6;
                }
              }
            }
            a[1] += 5;
            break;
          }
          case WP_LASER: {
            // Build laser polyline. Targets nearest live bad; iteratively steers toward it.
            if (!this.laserTrg || this.laserTrg.flDeath) {
              let dist = Infinity;
              this.laserTrg = { x: this.x, y: -20, ray: 10, damage: null, flDeath: true, shieldLim: null };
              for (const b of this.game.badsList) {
                const d = this.getDist(b);
                if (d < dist) {
                  this.laserTrg = { x: b.x, y: b.y, ray: b.ray, damage: (n) => b.damage(n), flDeath: false, shieldLim: null };
                  dist = d;
                }
              }
            }

            const op: number[] = [this.x, this.y - 6];
            const list: number[][] = [op];
            let angle = -1.57;
            if (!this.laserTrg.flDeath) angle += this.laserStartAngle;
            let va = 0.1;
            let ca = 0.1;
            const sp = 7;
            let tr = 0;

            let cur = op;
            for (;;) {
              const dx = this.laserTrg.x - cur[0];
              const dy = this.laserTrg.y - cur[1];
              const ta = Math.atan2(dy, dx);
              const da = hMod(ta - angle, 3.14);
              angle += clamp(da * ca, -va, va);
              const nx = cur[0] + Math.cos(angle) * sp;
              const ny = cur[1] + Math.sin(angle) * sp;
              if (this.laserTrg.shieldLim !== null && this.laserTrg.shieldLim !== undefined) {
                const distToTrg = Math.sqrt((nx - this.laserTrg.x) ** 2 + (ny - this.laserTrg.y) ** 2);
                if (distToTrg < this.laserTrg.shieldLim) {
                  angle = Math.atan2(this.laserTrg.y - ny, this.laserTrg.x - nx) + this.laserStartAngle * 0.2;
                  ca = 0.5;
                  va = 10;
                }
              }
              const np: number[] = [nx, ny];
              list.push(np);
              cur = np;
              if (Math.abs(dx) + Math.abs(dy) < this.laserTrg.ray * 0.5) break;
              if (tr++ > 100) break;
              ca = Math.min(ca + 0.01, 1);
              va += 0.01;
            }

            // Draw with two strokes: fat red core + thin white inside.
            this.laserFlip = (this.laserFlip + 1) % 2;
            const s0 = 12 + (a[0] + this.laserFlip * 2) * 3;
            const s1 = 1 + (a[0] + this.laserFlip) * 2.5;
            const gfx = this.laserGfx;

            gfx.moveTo(list[0][0], list[0][1]);
            for (let n = 1; n < list.length; n += 1) {
              gfx.lineTo(list[n][0], list[n][1]);
            }
            gfx.stroke({ width: s0, color: 0xff0000, alpha: 0.3, cap: 'round', join: 'round' });

            gfx.moveTo(list[0][0], list[0][1]);
            for (let n = 1; n < list.length; n += 1) {
              gfx.lineTo(list[n][0], list[n][1]);
            }
            gfx.stroke({ width: s1, color: 0xffffff, alpha: 1, cap: 'round', join: 'round' });

            // Source draws three short random white branches onto the same
            // temporary MovieClip before stamping it into plasma layer 1.
            if (list.length > 3) {
              const ba = 2;
              const br = 2;
              const ra = 3 + s1;
              for (let n = 0; n < 3; n += 1) {
                let k = 0;
                let st = randInt(list.length - 3);
                gfx.moveTo(list[st][0], list[st][1]);
                while (k === 0 || randInt(k) === 0) {
                  k += 1;
                  st = Math.min(st + ba + randInt(br), list.length - 1);
                  const px = list[st][0] + (Math.random() * 2 - 1) * ra;
                  const py = list[st][1] + (Math.random() * 2 - 1) * ra;
                  gfx.lineTo(px, py);
                }
                st = Math.min(st + ba + randInt(br), list.length - 1);
                gfx.lineTo(list[st][0], list[st][1]);
              }
              gfx.stroke({ width: 1, color: 0xffffff, alpha: 1, cap: 'round', join: 'round' });
            }

            gfx.blendMode = 'add';
            this.game.plasmaDraw(gfx, 1);
            gfx.clear();

            this.laserList = list;
            a[1] = 0.1;
            break;
          }
          case WP_SPEED:
            a[1] = 0.1;
            break;
          case WP_VOID: {
            const shot = this.newShot((Math.random() * 2 - 1) * (0.3 + a[0] * 0.15), 10);
            shot.setSkin(17, 1);
            shot.damage = 1.2;
            shot.orient();
            shot.bList.push(4);
            shot.speed = 12;
            shot.decal = Math.random() * 628;
            a[1] += 18 / (a[0] * 4);
            break;
          }
          case WP_MISSILE: {
            for (let n = 0; n < 2; n += 1) {
              const sens = n * 2 - 1;
              for (let k = 0; k < a[0]; k += 1) {
                const c = a[0] === 1 ? 0 : (k / (a[0] - 1)) - 0.5;
                const ec = 0.5 + a[0] * 0.2;
                this.newMissile(sens * 1.9 + ec * c);
              }
            }
            a[1] += 40;
            break;
          }
        }
      }
    }

    if (!flFire) {
      this.laserTrg = null;
      this.laserList = null;
    }
  }

  private updateLaserRay(): void {
    if (!this.laserRay) return;
    const lr = this.laserRay;
    lr.view.x = this.x;
    lr.view.y = this.y;
    if (lr.t >= 10) {
      lr.rayScale += 0.32 * TMOD;
    }
    lr.rayScale *= Math.pow(0.9, TMOD);
    lr.ray.scale.x = lr.rayScale;
    lr.t -= TMOD;

    for (let i = 0; i < lr.list.length; i += 1) {
      const bit = lr.list[i];
      const dr = hMod(-Math.PI / 2 - bit.view.rotation, Math.PI);
      bit.view.rotation += bit.vr * 0.0174 + dr * 0.03 * TMOD;
      bit.view.scale.x += 0.1;
      bit.t -= TMOD;
      if (lr.t < 10) {
        bit.view.scale.y *= 0.6;
      }
      if (bit.t < 10) {
        bit.view.alpha = bit.t / 10;
        if (bit.t < 0) {
          bit.view.removeFromParent();
          bit.view.destroy();
          lr.list.splice(i, 1);
          i -= 1;
        }
      }
    }

    // Source: while(laserRay.list.length < Math.min(12, laserRay.t*0.5)) spawn new mcLaserRay.
    // Keeps the ray array topped up while t > 0 so the aura looks dense for the full duration.
    while (lr.list.length < Math.min(12, lr.t * 0.5)) {
      const bit = makeSprite(this.game.assets.laserRay);
      bit.anchor.set(0.5, 1);
      bit.rotation = Math.random() * Math.PI * 2;
      bit.scale.set(1 + Math.random(), 1 + Math.random() * 10);
      bit.blendMode = 'add';
      lr.view.addChild(bit);
      lr.list.push({ view: bit, vr: (Math.random() * 2 - 1) * 5, t: 10 + Math.random() * 60 });
    }

    if (lr.t > 0) {
      // Damage enemies in line above the hero.
      for (const b of this.game.badsList) {
        if (Math.abs(b.x - this.x) < 8 * lr.rayScale + b.ray && b.y < this.y) {
          b.damage(2.5 * TMOD);
        }
      }
    } else if (lr.t < -10) {
      lr.view.removeFromParent();
      lr.view.destroy({ children: true });
      this.laserRay = null;
    }
  }

  private updateOnde(): void {
    if (!this.onde) return;
    this.onde.scale *= 1.25;
    this.onde.view.scale.set(this.onde.scale / 100);
    for (const b of this.game.badsList) {
      let already = false;
      for (const seen of this.onde.list) {
        if (seen === b) { already = true; break; }
      }
      if (!already && b.getDist({ x: this.onde.x, y: this.onde.y }) < this.onde.scale * 0.5) {
        b.damage(5);
        this.onde.list.push(b);
      }
    }
    if (this.onde.scale > STAGE_WIDTH * 2) {
      this.onde.view.removeFromParent();
      this.onde.view.destroy();
      this.onde = null;
    }
  }

  private updateBlackHole(): void {
    if (!this.blackHole) return;
    const bh = this.blackHole;
    bh.vr *= 1.05;
    bh.rotationDeg += 12 * TMOD;
    bh.view.rotation = (bh.rotationDeg * Math.PI) / 180;
    const acc = 1;
    let allMasked = true;
    for (let i = 0; i < bh.list.length; i += 1) {
      const e = bh.list[i];
      const p = e.part;
      if (e.mask) {
        p.vx *= 1.2;
        p.vy *= 1.2;
        e.black = Math.min(e.black + 8 * TMOD, 100);
        const k = 1 - e.black / 100;
        const fl = e.blackFilter ?? new ColorMatrixFilter();
        fl.matrix = [
          k, 0, 0, 0, 0,
          0, k, 0, 0, 0,
          0, 0, k, 0, 0,
          0, 0, 0, 1, 0,
        ];
        if (!e.blackFilter) {
          e.blackFilter = fl;
          p.root.filters = [fl];
        }

        if (p.getDist(bh) > bh.scale * 0.5 + e.ray) {
          e.mask.removeFromParent();
          e.mask.destroy();
          if (e.blackFilter) e.blackFilter.destroy();
          p.kill();
          bh.list.splice(i, 1);
          i -= 1;
        }
      } else {
        allMasked = false;
        const a = p.getAng(bh);
        p.vx += Math.cos(a) * acc * TMOD;
        p.vy += Math.sin(a) * acc * TMOD;
        if (p.getDist(bh) < bh.scale * 0.5 - e.ray) {
          // Add a circular mask so subsequent renders clip.
          const mask = new Container();
          const ring = makeSprite(this.game.assets.round);
          ring.anchor.set(0.5);
          mask.addChild(ring);
          mask.x = bh.x;
          mask.y = bh.y;
          mask.scale.set(bh.scale / 100);
          this.game.badsLayer.addChild(mask);
          p.root.mask = mask;
          e.mask = mask;
        }
      }
    }

    switch (bh.step) {
      case 0:
      case 2: {
        const ts = bh.step === 0 ? 150 : 0;
        const ds = ts - bh.scale;
        bh.scale += ds * 0.3;
        if (Math.abs(ds) < 1) {
          bh.step += 1;
          bh.scale = ts;
        }
        bh.view.scale.set(bh.scale / 100);
        for (const e of bh.list) {
          if (e.mask) e.mask.scale.set(bh.scale / 100);
        }
        break;
      }
      case 1:
        if (allMasked) bh.step = 2;
        break;
      case 3:
        if (bh.list.length === 0) {
          bh.view.removeFromParent();
          bh.view.destroy({ children: true });
          this.blackHole = null;
        }
        break;
    }
  }

  newShot(angle: number, speed: number): Shot {
    const a = angle - 1.57;
    const root = new Container();
    this.game.shotsLayer.addChild(root);
    const shot = new Shot(this.game, root);
    shot.a = a;
    shot.flGood = true;
    shot.x = this.x;
    shot.y = this.y - 20;
    shot.vx = Math.cos(a) * speed;
    shot.vy = Math.sin(a) * speed;
    return shot;
  }

  newMissile(a: number): Shot {
    const shot = this.newShot(a, 4);
    shot.y += 10;
    shot.setSkin(15, 1);
    shot.ray = 8;
    shot.damage = 2;
    shot.speed = 4;
    shot.accel = { inc: 0.5, max: 16 };
    shot.va = 0.2;
    shot.ca = 0.1;
    shot.orient();
    shot.queue = 'mcQueueStandard';
    shot.bList.push(3);
    shot.timer = 120;
    return shot;
  }

  hit(_shot: Shot): void {
    this.explode();
  }

  explode(): void {
    // Particle burst.
    for (let i = 0; i < 12; i += 1) {
      const root = new Container();
      const sp = makeSprite(this.game.assets.exploPart[0]);
      sp.anchor.set(0.5);
      root.addChild(sp);
      this.game.partsLayer.addChild(root);
      const p = new Part(this.game, root);
      p.frames = this.game.assets.exploPart;
      p.setScale(20 + Math.random() * 30);
      const a = Math.random() * 6.28;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const ray = 8;
      const speed = 6 + Math.random() * 6;
      p.x = this.x + ca * ray;
      p.y = this.y + sa * ray;
      p.vx = ca * speed;
      p.vy = sa * speed;
      p.plasmaId = 1;
      p.timer = 10 + Math.random() * 30;
      p.frict = 0.96;
      p.root.blendMode = 'add';
      p.rotationDeg = Math.random() * 360;
    }

    // TRACE — six animated `mcExploTrace` clips per source `Hero.mt:927-938`.
    // Each clip starts at frame `Std.random(3)+1` (1, 2 or 3, here 0-based 0/1/2),
    // plays forward to frame 3, then frame 3's DoAction stamps it into plasma
    // layer 1 additively and removes it. Random per-clip pos / scale / rotation,
    // additive blend on the visible clip while it plays, scale 1.5x..3.0x
    // (source `_xscale = 150 + Math.random()*150`). The R16 plasmaDraw transform
    // compose lets the per-stamp scale + rotation propagate into the layer-1 RT.
    const traceRay = 8;
    for (let i = 0; i < 6; i += 1) {
      const root = new Container();
      this.game.partsLayer.addChild(root);
      const start = randInt(3); // Std.random(3) -> 0/1/2
      const trace = new PartTrace(this.game, root, this.game.assets.exploTrace, start);
      trace.x = this.x + (Math.random() * 2 - 1) * traceRay;
      trace.y = this.y + (Math.random() * 2 - 1) * traceRay;
      const xs = (150 + Math.random() * 150) / 100;
      root.scale.set(xs, xs);
      root.rotation = Math.random() * Math.PI * 2;
      root.blendMode = 'add';
    }

    // Onde wave.
    const ondeSp = makeSprite(this.game.assets.onde[0]);
    ondeSp.anchor.set(0.5);
    ondeSp.x = this.x;
    ondeSp.y = this.y;
    ondeSp.scale.set(1.5);
    this.game.underPartsLayer.addChild(ondeSp);
    const ondeRoot = new Container();
    ondeRoot.addChild(ondeSp);
    this.game.underPartsLayer.addChild(ondeRoot);
    const ondePart = new Part(this.game, ondeRoot);
    ondePart.frames = this.game.assets.onde;
    ondePart.timer = this.game.assets.onde.length;
    ondePart.fadeType = 2;

    this.kill();
  }

  override kill(): void {
    if (this.killed) return;
    this.game.gameOver();
    if (this.laserRay) {
      this.laserRay.view.removeFromParent();
      this.laserRay.view.destroy({ children: true });
      this.laserRay = null;
    }
    if (this.onde) {
      this.onde.view.removeFromParent();
      this.onde.view.destroy();
      this.onde = null;
    }
    if (this.laserGfx.parent) this.laserGfx.parent.removeChild(this.laserGfx);
    this.laserGfx.destroy();
    super.kill();
  }

  private checkBounds(): void {
    const c = -0.3;
    if (this.x < this.ray || this.x > STAGE_WIDTH - this.ray) {
      this.vx *= c;
      this.x = clamp(this.x, this.ray, STAGE_WIDTH - this.ray);
    }
    if (this.y < this.ray || this.y > STAGE_HEIGHT - this.ray) {
      this.vy *= c;
      this.y = clamp(this.y, this.ray, STAGE_HEIGHT - this.ray);
    }
  }
}

function rollClamp(rollX: number): number {
  // Hero gotoAndStop("1"+int(mm(0,10+rollX,20))) — center frame ~10, range 0..20.
  return Math.min(Math.max(0, 10 + rollX), 20);
}
