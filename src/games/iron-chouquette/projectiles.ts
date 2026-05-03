import { Container, Sprite as PixiSprite } from 'pixi.js';
import { Phys } from './phys';
import { Part } from './part';
import { TMOD, randInt, DP_PARTS } from './constants';
import type { IronChouquetteGame } from './game';
import type { Bads } from './bads';
import { makeSprite } from '../_shared/frames';

// Shot.mt — one projectile (hero or enemy). Behavior list drives motion (homing, ondulate, swarm…).
// flGood = true => hero shot vs enemies; flGood = false => enemy shot vs hero.

export type ShotTarget = {
  x: number;
  y: number;
  ray: number;
  damage?: ((n: number) => void) | null;
  flDeath: boolean;
  shieldLim?: number | null;
};

export class Shot extends Phys {
  flGood = false;
  flPierce = false;
  flInvincible = false;
  ft = 0;

  sleep: number | null = null;
  damage = 0;
  timer: number | null = null;
  a = 0;
  decal = 0;
  speed = 2;
  va = 0.1;
  ca = 0.1;
  accel: { inc: number; max: number } | null = null;

  bList: number[] = [];
  trg: ShotTarget | null = null;
  thruster: { vx: number; vy: number; sleep: number | null } | null = null;
  queue: string | null = null;
  op: { x: number; y: number } | null = null;

  // Sprite atlas frame (mcShot frames 1..23, 1-indexed in source).
  skinFrame = 1;
  skinSpriteContainer: Container | null = null;

  constructor(game: IronChouquetteGame, root?: Container) {
    super(game, root ?? new Container());
    this.ray = 3;
    this.game.shotList.push(this);
  }

  setSkin(n: number, _depth: number): void {
    // Replace the visual content with the requested mcShot frame.
    this.root.removeChildren();
    const idx = Math.max(0, Math.min(n - 1, this.game.assets.shot.length - 1));
    const sp = makeSprite(this.game.assets.shot[idx]);
    sp.anchor.set(0.5);
    this.root.addChild(sp);
    this.skinFrame = n;
    this.skinSpriteContainer = sp as unknown as Container;
    // Shots all live in the shots layer at depth d (0..2). We just keep one parent for simplicity.
    if (this.root.parent === null) {
      this.game.shotsLayer.addChild(this.root);
    }
  }

  orient(): void {
    this.root.rotation = Math.atan2(this.vy, this.vx);
  }

  updateVit(): void {
    this.vx = Math.cos(this.a) * this.speed;
    this.vy = Math.sin(this.a) * this.speed;
    this.orient();
  }

  override update(): void {
    if (this.accel) {
      this.speed = Math.min(this.speed + this.accel.inc * TMOD, this.accel.max);
    }
    this.checkCols();
    if (this.killed) return;
    this.updateBehaviour();
    super.update();

    if (this.timer !== null) {
      this.timer -= TMOD;
      if (this.timer < 10) {
        switch (this.ft) {
          case 0:
            this.root.alpha = Math.max(0, this.timer / 10);
            break;
          case 3:
            this.root.scale.set(Math.max(0, this.timer / 10));
            break;
        }
        if (this.timer < 0) {
          this.timer = null;
          this.kill();
        }
      }
    }

    if (this.isOut(50)) this.kill();
  }

  updateBehaviour(): void {
    for (let n = 0; n < this.bList.length; n += 1) {
      const id = this.bList[n];
      switch (id) {
        case 0: // BOMB / spin
          if (this.vr !== null) this.rotationDeg += this.vr * TMOD;
          break;
        case 3: // HOMING
          if (this.sleep !== null && this.sleep > 0) {
            this.sleep -= TMOD;
            break;
          }
          this.getNewBadTrg();
          if (!this.trg) break;
          {
            let da = this.getAng(this.trg) - this.a;
            while (da > Math.PI) da -= Math.PI * 2;
            while (da < -Math.PI) da += Math.PI * 2;
            this.a += Math.min(Math.max(da * this.ca, -this.va), this.va) * TMOD;
            this.updateVit();
          }
          break;
        case 4: // ONDULE
          this.decal = (this.decal + 43 * TMOD) % 628;
          this.a += Math.cos(this.decal / 100) * 0.2 * TMOD;
          this.updateVit();
          break;
        case 5: // SWARM
          if (Math.sqrt(this.vx * this.vx + this.vy * this.vy) < 3 || Math.random() / TMOD < 0.1) {
            this.a = randInt(4) * 1.57;
            this.vx = Math.cos(this.a) * this.speed;
            this.vy = Math.sin(this.a) * this.speed;
          }
          break;
        case 6:
          this.game.plasmaDraw(this.root, 0);
          break;
        case 7:
          this.speed += 0.05 * TMOD;
          break;
        case 11: {
          const max = Math.max(1, Math.floor(2 * this.game.PM));
          for (let i = 0; i < max; i += 1) {
            const partRoot = new Container();
            const sp = makeSprite(this.game.assets.partPlasmaBolt[randInt(this.game.assets.partPlasmaBolt.length)]);
            sp.anchor.set(0.5);
            partRoot.addChild(sp);
            this.game.partsLayer.addChild(partRoot);
            const p = new Part(this.game, partRoot);
            const ang = Math.random() * 6.28;
            const r = Math.random() * 40;
            p.x = this.x + Math.cos(ang) * r;
            p.y = this.y + Math.sin(ang) * r;
            p.vy = -(1 + Math.random() + 6);
            p.setScale(150);
            p.fadeType = 0;
            p.timer = 14;
            // Source: `p.root.blendMode = BlendMode.ADD` (Shot.mt:159) — every
            // Plasma-sacrifice big-shot's bolt particle renders additively, producing the
            // bright glow swarm that characterises the WP_PLASMA sacrifice. Without it the
            // bolts read as opaque sprites against the playfield. (Source leaves `p.timer`
            // unset — the assignment is commented out at Shot.mt:156 — so its bolts float
            // off-screen instead of fading; the port adds `timer=14` to bound particle
            // accumulation, matching the developer-intended-but-disabled fade timer.)
            partRoot.blendMode = 'add';
          }
          break;
        }
      }
    }

    if (this.thruster) {
      if (this.thruster.sleep === null) {
        this.vx += this.thruster.vx * TMOD;
        this.vy += this.thruster.vy * TMOD;
      } else {
        this.thruster.sleep -= TMOD;
        if (this.thruster.sleep < 0) this.thruster.sleep = null;
      }
    }

    if (this.queue) {
      if (this.op) {
        // Queue trail: emit a textured streak between current pos and the previous
        // position (`op`) onto plasma layer 0. Source `Shot.mt:177-189` rotates the
        // streak MC by `180 + getAng(op)` (degrees) where `getAng(op)` is
        // `atan2(op.y - y, op.x - x)`; the +180° flip plus the streak art's
        // right-edge registration in Flash makes the streak extend *toward* op.
        // We use a left-anchored sprite (anchor.set(0,0.5)) drawn at the current
        // pos, rotated to point *from* current *toward* op, so it extends along the
        // path back to the previous position — visually equivalent to source.
        const queueAsset = this.queue === 'mcQueueStandard' ? this.game.assets.queueStandard : null;
        if (queueAsset) {
          const sp = makeSprite(queueAsset) as unknown as PixiSprite;
          sp.anchor.set(0, 0.5);
          const dx = this.op.x - this.x;
          const dy = this.op.y - this.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          sp.rotation = Math.atan2(dy, dx);
          sp.scale.x = dist / Math.max(1, sp.width || 1);
          sp.x = this.x;
          sp.y = this.y;
          if (this.timer !== null) sp.alpha = Math.min(Math.max(this.timer / 10, 0), 1);
          this.game.plasmaDraw(sp as unknown as Container, 0);
          sp.destroy();
        }
      }
      this.op = { x: this.x, y: this.y + this.game.SCROLL_SPEED * 3 };
    }
  }

  getNewBadTrg(): void {
    const list = this.game.badsList;
    if (list.length > 0) {
      const b = list[randInt(list.length)];
      this.trg = { x: b.x, y: b.y, ray: b.ray, flDeath: b.flDeath };
    } else {
      this.trg = null;
    }
  }

  checkCols(): void {
    if (this.flGood) {
      const list = this.game.badsList;
      for (let i = 0; i < list.length; i += 1) {
        const b = list[i];
        if (b.flDeath) continue;
        if (b.rect) {
          if (Math.abs(this.x - b.x) < b.rect.rw + this.ray && Math.abs(this.y - b.y) < b.rect.rh + this.ray) {
            this.hitBad(b);
            if (this.killed) return;
          }
        } else if (this.getDist(b) < this.ray + b.ray) {
          this.hitBad(b);
          if (this.killed) return;
        }
      }
    } else {
      const h = this.game.hero;
      if (!h || h.invincibleTimer !== null) return;
      const dist = this.getDist(h);
      if (dist < h.ray + this.ray) {
        h.hit(this);
        this.kill();
      }
    }
  }

  private hitBad(b: Bads): void {
    const hp = b.hp;
    b.hit(this);
    if (!this.flInvincible) {
      if (this.flPierce && hp < this.damage) {
        this.damage -= hp;
      } else {
        // Impact effect.
        const partRoot = new Container();
        const sp = makeSprite(this.game.assets.partImpact[0]);
        sp.anchor.set(0.5);
        partRoot.addChild(sp);
        partRoot.x = this.x;
        partRoot.y = this.y;
        const s = (50 + this.damage * 100) / 100;
        partRoot.scale.set(s);
        partRoot.rotation = Math.random() * Math.PI * 2;
        partRoot.blendMode = 'add';
        this.game.partsLayer.addChild(partRoot);
        const p = new Part(this.game, partRoot);
        p.frames = this.game.assets.partImpact;
        p.timer = this.game.assets.partImpact.length;
        p.fadeType = 2;
        this.kill();
      }
    }
  }

  override kill(): void {
    if (this.killed) return;
    const idx = this.game.shotList.indexOf(this);
    if (idx >= 0) this.game.shotList.splice(idx, 1);
    super.kill();
  }
}

// Rafale.mt — burst-fire pattern attached to a Bads.
export class Rafale {
  cooldown = 200;
  w = 1;
  dx = 0;
  dy: number;
  cInert: number | null = null;
  orientRay: number | null = null;

  list: { type: number; params: number[]; cooldown: number }[] = [];
  index = 0;
  timer = 0;

  b: Bads;

  constructor(b: Bads) {
    this.b = b;
    this.dy = b.ray;
  }

  init(): void {
    this.index = 0;
    this.timer = 0;
    this.b.rafale = this;
    this.b.shootTimer = this.cooldown;
  }

  update(): void {
    this.timer -= TMOD;
    if (this.timer <= 0) {
      const si = this.list[this.index];
      this.shot(si.type, si.params);
      this.timer += si.cooldown;
      this.index += 1;
      if (this.index === this.list.length) {
        this.b.rafale = null;
      }
    }
  }

  addShot(n: number, a: number[], cd: number, max?: number): void {
    const m = max ?? 1;
    for (let i = 0; i < m; i += 1) {
      this.list.push({ type: n, params: a, cooldown: cd });
    }
  }

  shot(type: number, a: number[]): void {
    let shot: Shot | null = null;
    switch (type) {
      case 0: // FRONT (speed, skin, ray?)
        shot = this.newShot();
        shot.vy = a[0];
        shot.setSkin(a[1], 1);
        if (a[2] !== undefined) shot.ray = a[2];
        break;
      case 1: // STANDARD (speed, accuracy)
        shot = this.newAimedShot(a[0], a[1]);
        shot.setSkin(13, 1);
        break;
      case 2: // CIBLE (speed, skin)
        shot = this.newAimedShot(a[0], 0);
        shot.setSkin(a[1], 1);
        shot.orient();
        break;
      case 3: // MULTI (speed, skin, count, spread)
        for (let i = 0; i < a[2]; i += 1) {
          const c = (i / Math.max(1, a[2] - 1)) * 2 - 1;
          shot = this.newAngledShot(a[0], 1.57 + c * a[3]);
          shot.setSkin(a[1], 1);
        }
        break;
      case 4: // FRONT ANGLED (speed, accuracy)
        {
          const c = Math.random() * 2 - 1;
          shot = this.newAngledShot(a[0], 1.57 + c * a[1]);
          shot.setSkin(13, 1);
        }
        break;
    }

    if (this.cInert !== null && shot) {
      shot.vx += this.cInert * this.b.vx;
      shot.vy += this.cInert * this.b.vy;
    }
  }

  newShot(): Shot {
    const game = this.b.game;
    const root = new Container();
    game.shotsLayer.addChild(root);
    const shot = new Shot(game, root);
    shot.x = this.b.x + this.dx;
    shot.y = this.b.y + this.dy;
    if (this.orientRay !== null) {
      const hero = game.hero;
      if (hero) {
        const ang = this.b.getAng(hero);
        shot.x += Math.cos(ang) * this.orientRay;
        shot.y += Math.sin(ang) * this.orientRay;
      }
    }
    return shot;
  }

  newAimedShot(speed: number, da: number): Shot {
    const hero = this.b.game.hero;
    const baseAng = hero ? this.b.getAng(hero) : Math.PI / 2;
    return this.newAngledShot(speed, baseAng + (Math.random() * 2 - 1) * da);
  }

  newAngledShot(speed: number, a: number): Shot {
    const shot = this.newShot();
    shot.vx = Math.cos(a) * speed;
    shot.vy = Math.sin(a) * speed;
    return shot;
  }
}
