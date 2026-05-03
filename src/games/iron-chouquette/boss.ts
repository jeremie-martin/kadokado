import { Container } from 'pixi.js';
import {
  CDIF, PROB, TMOD, randInt,
  STAGE_WIDTH, STAGE_HEIGHT,
  C_OMEGA, C_BLACKRON, C_FURIA, C_GROMPH, C_SURGROMPH, C_BRIAROS,
  C_NES, C_MINE, C_SHIELD, C_BLOCK, C_ORB, C_GERGIN, C_STORM, C_CUTTY_OPEN, C_CUTTY_CLOSE,
  C0,
} from './constants';
import { Bads } from './bads';
import { Wave } from './wave';
import type { IronChouquetteGame } from './game';
import { makeSprite } from '../_shared/frames';

// Stykades.mt — the brief notes this is *not* a traditional boss with HP.
// It is a difficulty curve: `dif` accumulates, gates which monster types can spawn,
// and caps `monsterLevel` (sum of alive enemies' difficulty contributions).

export class Stykades {
  game: IronChouquetteGame;

  BADS_LIMIT = 4; // degrades to 2 on lag
  FL_CREATE_LOCK = false;

  monsterLevel = 0;
  waveTimer = 150;
  nextWave = 300;
  dif = 0;
  nextBonus = 300;

  constructor(game: IronChouquetteGame) {
    this.game = game;
  }

  update(): void {
    this.dif += CDIF * TMOD;
    this.waveTimer += TMOD;
    if (this.waveTimer > this.nextWave) {
      this.waveTimer = 0;
      this.nextWave = 10 + Math.random() * 20;
      this.checkWave();
    }
  }

  checkWave(): void {
    if (this.dif > this.nextBonus) {
      this.genMonster(21);
      this.nextBonus += 80 + Math.random() * (200 + this.dif);
    }

    if (this.monsterLevel < this.dif * 0.01) {
      const list: number[] = [];
      for (let i = 0; i < PROB.length; i += 1) {
        const a = PROB[i];
        const min = Math.min(this.dif - 2000, 2500);
        if (this.dif > a[1] && (a[1] > min || i > PROB.length - 8)) {
          list.push(a[0]);
        }
      }
      if (list.length > 0) {
        this.genMonster(list[randInt(list.length)]);
      }
    }
  }

  // Factory dispatch.
  genMonster(n: number): Bads | null {
    switch (n) {
      case 1: {
        const wave = new Wave(randInt(5), 3, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newOmega(), 5);
        return null;
      }
      case 2: {
        const wid = 5 + randInt(3);
        for (let k = 0; k < 2; k += 1) {
          const wave = new Wave(wid, 3, true);
          if (k === 0) wave.flipPath(0);
          wave.addBads(() => this.newOmega(), 5);
        }
        return null;
      }
      case 3: {
        const wid = 8 + randInt(4);
        const wave = new Wave(wid, 4, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newBlackron(), 4);
        return null;
      }
      case 4: {
        const wid = 12 + randInt(3);
        const wave = new Wave(wid, 6, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newFuria(), 8);
        return null;
      }
      case 5: {
        const wave = new Wave(15, 5.5, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newGromph(), 1);
        return null;
      }
      case 6: {
        const wid = 16 + randInt(5);
        const wave = new Wave(wid, 5.5, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newGromph(), 1);
        return null;
      }
      case 7:
        return this.newBlock();
      case 8: {
        const wid = 15 + randInt(6);
        const wave = new Wave(wid, 5.5, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newSurGromph(), 1);
        return null;
      }
      case 9:
        return this.newBriaros();
      case 10:
      case 11:
      case 12:
        return this.newStorm(n - 10);
      case 16:
        for (let i = 0; i < 6; i += 1) this.newBriaros();
        return null;
      case 17: {
        const m = 80;
        const x = m + Math.random() * (STAGE_WIDTH - 2 * m);
        const max = 5;
        for (let i = 0; i < max; i += 1) {
          const c = (i / (max - 1)) * 2 - 1;
          const b = this.newCutty();
          if (b) {
            b.x = x + c * 40;
            b.vy = 4 - Math.abs(c) * 1;
            b.seekerLimit = STAGE_HEIGHT * 0.5 + 10 * c;
          }
        }
        return null;
      }
      case 18: {
        const wave = new Wave(21, 4, true);
        if (randInt(2) === 0) wave.flipPath(0);
        wave.addBads(() => this.newNes(), 1);
        return null;
      }
      case 20:
        return this.newOrb();
      case 21:
        return this.newCarrier();
      case 22:
        return this.newGergin();
      case 30:
        return this.newMine();
      case 31:
        for (let i = 0; i < 5; i += 1) this.newMine();
        return null;
      case 32:
        for (let i = 0; i < 10; i += 1) this.newMine();
        return null;
      case 33:
        return this.newShield();
      case 34: {
        for (let i = 0; i < 8; i += 1) {
          const b = this.newBriaros();
          if (!b) continue;
          const m = -15;
          b.x = m + randInt(2) * (STAGE_WIDTH - 2 * m);
          b.y = STAGE_HEIGHT * 0.5 + 20;
          if (b.beeRange[0]) b.beeRange[0].w = 0;
          if (b.beeRange[1]) b.beeRange[1].yMax += 20;
          b.hp = 120;
          const raf = b.newRafale();
          raf.addShot(1, [3, 0.6], 10, 1);
          b.cooldown = 10;
          b.shootTimer = 5 + Math.random() * 10;
        }
        return null;
      }
    }
    return null;
  }

  // Helper used by every spawn factory: spawn capped by BADS_LIMIT unless FL_CREATE_LOCK is set.
  private newBad(): Bads | null {
    if (!this.FL_CREATE_LOCK && this.game.badsList.length > this.BADS_LIMIT) return null;
    const b = new Bads(this.game, new Container());
    this.game.badsLayer.addChild(b.root);
    const m = 15;
    b.x = m + Math.random() * (STAGE_WIDTH - 2 * m);
    b.vy = 3;
    b.outSafeTimer = 100;
    return b;
  }

  newOmega(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(1.6);
    b.setScore(C_OMEGA);
    b.hp = 1;
    b.setSkin(1);
    // Source: `b.turn = downcast(b.root.smc).turn` — a sub-clip representing
    // the spinning rear ring. The port's setSkin(1) renders the bads/1.png
    // atlas frame which is the static body. We layer the extracted
    // `omega_turn.png` (the dedicated 37×37 ring) below the body sprite and
    // wire it as `b.turn` so Bads.update's `turn._rotation += vy*8*tmod`
    // path spins it per-frame, matching the source's rear-spinner cue.
    const turnSprite = makeSprite(this.game.assets.omegaTurn);
    turnSprite.anchor.set(0.5);
    if (b.skinView) {
      b.root.addChildAt(turnSprite, b.root.getChildIndex(b.skinView));
    } else {
      b.root.addChildAt(turnSprite, 0);
    }
    b.turn = turnSprite;
    const raf = b.newRafale();
    raf.addShot(1, [3, 0.6], 100, 1);
    b.shootTimer = 150 + Math.random() * 500;
    b.turnSpeed = 2 + Math.random() * 6;
    return b;
  }

  newBlackron(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(2.5);
    b.setScore(C_BLACKRON);
    b.hp = 2;
    b.setSkin(2);
    return b;
  }

  newFuria(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(2);
    b.setScore(C_FURIA);
    b.hp = 1;
    b.setSkin(3);
    const raf = b.newRafale();
    raf.addShot(0, [4.5, 13], 0, 1);
    b.shootTimer = 70 + Math.random() * 30;
    return b;
  }

  newGromph(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(7);
    b.setScore(C_GROMPH);
    b.hp = 5;
    b.setSkin(4);
    const raf = b.newRafale();
    raf.addShot(2, [6, 21], 4, 3);
    raf.dy = 0;
    raf.orientRay = 26;
    b.shootTimer = 80;
    // Source: `b.fire = b.root.smc; b.follow = b.root.smc` — the turret
    // sub-clip rotates to face the hero (and plays a fire animation on each
    // shot). The port lacks a separate sub-clip; pointing `follow` at the
    // skin sprite rotates the entire body. The atlas frame is south-facing
    // while source's smc was east-facing, so apply -π/2 follow offset to
    // align "atan2 toward hero" with the south-drawn turret.
    if (b.skinView) {
      b.follow = b.skinView;
      b.followAngleOffset = -Math.PI / 2;
    }
    return b;
  }

  newSurGromph(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(20);
    b.setScore(C_SURGROMPH);
    b.hp = 16;
    b.setSkin(5);
    const raf = b.newRafale();
    raf.addShot(2, [6, 21], 4, 3);
    raf.cooldown = 60;
    raf.dy = 0;
    raf.orientRay = 26;
    b.shootTimer = 40;
    // Same wiring as Gromph (`b.fire = b.root.smc; b.follow = b.root.smc`).
    if (b.skinView) {
      b.follow = b.skinView;
      b.followAngleOffset = -Math.PI / 2;
    }
    return b;
  }

  newBlock(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(6);
    b.setScore(C_BLOCK);
    b.hp = 30;
    b.setRect(45, 66);
    b.setSkin(20);
    if (b.rect) b.y = -b.rect.rh;
    return b;
  }

  newBriaros(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(6);
    b.setScore(C_BRIAROS);
    b.hp = 6;
    b.setSkin(6);
    b.vy = -Math.random() * 5;
    const raf = b.newRafale();
    raf.addShot(1, [3, 0.6], 100, 1);
    b.shootTimer = 150 + Math.random() * 15;
    b.bList = [6, 7];
    b.frict = 0.9;
    const m = 20;
    b.beeRange = [
      { w: 6, xMin: m, xMax: STAGE_WIDTH - m, yMin: m, yMax: 120 },
      { w: 1, xMin: m, xMax: STAGE_WIDTH - m, yMin: STAGE_HEIGHT * 0.5, yMax: STAGE_HEIGHT - 76 },
    ];
    b.acc = { c: 0.1, lim: 1 };
    return b;
  }

  newCutty(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(7);
    b.setScore(C_CUTTY_CLOSE);
    b.score2 = C_CUTTY_OPEN;
    b.vr = (randInt(2) * 2 - 1) * (5 + Math.random() * 10);
    b.hp = 14;
    b.setSkin(8);
    b.va = 0.07;
    b.turnCoef = 0.1;
    b.bounceId = 0;
    b.speed = 4.5;
    b.bList = [8];
    return b;
  }

  newNes(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(40);
    b.setScore(C_NES);
    b.hp = 60;
    b.setSkin(9);
    let raf = b.newRafale();
    raf.addShot(0, [10, 23, 16], 150, 1);
    raf.cooldown = 40;
    raf.dx = -5;
    raf.dy = 20;
    raf = b.newRafale();
    raf.addShot(0, [10, 23, 16], 6, 3);
    raf.cooldown = 100;
    raf.dx = -5;
    raf.dy = 24;
    b.shootTimer = 50 + Math.random() * 50;
    b.rect = { rw: 30, rh: 25 };
    return b;
  }

  newOrb(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(18);
    b.setScore(C_ORB);
    b.setSkin(10);
    b.ray = 25;
    b.y = -(b.ray + 5);
    b.hp = 16;
    b.bounceId = 1;
    b.bList = [9];
    b.trg = { x: 0, y: 70 + Math.random() * 30 };
    b.waitTimer = 100;
    const raf = b.newRafale();
    for (let i = 0; i < 2; i += 1) {
      raf.addShot(3, [3, 13, 4, 0.7], 14, 1);
      raf.addShot(3, [3, 13, 3, 0.5], 14, 1);
    }
    raf.cooldown = 800;
    b.shootTimer = 2000;
    return b;
  }

  newCarrier(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(10);
    b.setScore(C0);
    b.setSkin(17);
    b.hp = 3;
    b.ray = 20;
    b.waitTimer = 300;
    b.speed = 6;
    b.a = 1.57;
    b.va = 0.5;
    b.turnCoef = 0.15;
    b.flOrient = true;
    b.bList = [3];
    b.onTargetReach = () => b.chooseNewTarget(20, STAGE_WIDTH - 20, 30, 190);
    b.onTargetReach();
    b.onDeath = () => b.dropBonus();
    return b;
  }

  newGergin(): Bads | null {
    this.FL_CREATE_LOCK = true;
    let last: Bads | null = null;
    for (let i = 0; i < 2; i += 1) {
      const b = this.newBad();
      if (!b) continue;
      b.setLevel(22);
      b.setScore(C_GERGIN);
      b.setSkin(14 + i * 2);
      b.hp = 30;
      b.rect = { rw: 20, rh: 26 };
      if (last === null) {
        last = b;
        // Source: `b.follow = b.root.smc` — the head's barrel rotates to face
        // hero. Wire the skin sprite directly with the south-facing offset.
        if (b.skinView) {
          b.follow = b.skinView;
          b.followAngleOffset = -Math.PI / 2;
        }
        b.bList = [6];
        b.acc = { c: 0.1, lim: 1 };
        b.frict = 0.9;
        const m = 40;
        b.beeRange = [{ w: 6, xMin: m, xMax: STAGE_WIDTH - m * 2, yMin: m, yMax: 90 }];
      } else {
        last.setPart(b, 40, 0);
        const raf = b.newRafale();
        raf.addShot(1, [3, 0.15], 7, 12);
        raf.cooldown = 48;
        raf.dy = 25;

        const lastRef = last;
        b.onDeath = () => {
          lastRef.bList = [3];
          lastRef.turnCoef = 0.1;
          lastRef.va = 0.1;
          lastRef.trg = this.game.hero;
          lastRef.flOrient = true;
        };
        last.onDeath = () => {
          b.bList = [3];
          b.turnCoef = 0.2;
          b.va = 1;
          b.trg = { x: STAGE_WIDTH * 0.5, y: 40 };
          b.weapons = [];
          const r = b.newRafale();
          r.addShot(4, [3, 0.9], 5, 12);
          r.cooldown = 48;
          r.dy = 25;
        };
      }
    }
    this.FL_CREATE_LOCK = false;
    return last;
  }

  newMine(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(4);
    b.setScore(C_MINE);
    b.setSkin(18);
    b.hp = 3;
    b.ray = 16;
    b.vy = 1 + Math.random() * 1;
    b.bounceId = 2;
    // Source: `b.turn = b.root.smc` so the mine body spins via Bads.update's turn-rotation
    // path. The port lacks a separate sub-movieclip, so we point `turn` at the skin sprite
    // — the whole visual rotates, matching the source's spinning mine.
    if (b.skinView) b.turn = b.skinView;
    b.onDeath = () => {
      const raf = b.newRafale();
      raf.shot(3, [3, 13, 12, 3.14]);
    };
    return b;
  }

  newShield(): Bads | null {
    const b = this.newBad();
    if (!b) return null;
    b.setLevel(13);
    b.setScore(C_SHIELD);
    b.setSkin(19);
    b.hp = 10;
    b.ray = 27;
    b.shieldLim = 120;
    const m = 20;
    b.bList = [6, 10];
    b.acc = { c: 0.1, lim: 1 };
    b.frict = 0.92;
    b.beeRange = [{ w: 6, xMin: m, xMax: STAGE_WIDTH - m, yMin: m, yMax: 170 }];
    return b;
  }

  newStorm(lvl: number): Bads | null {
    this.FL_CREATE_LOCK = true;
    const b = this.newBad();
    if (!b) {
      this.FL_CREATE_LOCK = false;
      return null;
    }
    b.setLevel((lvl + 1) * 32);
    b.setScore(C_STORM[lvl]);
    b.setSkin(11);
    b.setSubSkin(lvl + 1);
    b.hp = 28 + lvl * 20;
    b.ray = 25;
    b.bList.push(5);
    b.waitTimer = 500 + lvl * 150;

    for (let i = 0; i < 2; i += 1) {
      const side = this.newBad();
      if (!side) continue;
      const sens = i * 2 - 1;
      side.setLevel(2 + lvl);
      side.flSide = true;
      side.setSkin(12);
      side.setSubSkin(lvl + 1);
      // Source: `side.root._xscale = sens*100` — mirror left/right gunner.
      side.root.scale.x = sens;
      side.hp = 8 + lvl * 6;
      side.ray = 20;
      b.setPart(side, 25 * sens, 0);
      const raf = side.newRafale();
      raf.addShot(0, [12, 19], 12, 1 + lvl);
      raf.cooldown = 150;
      side.shootTimer = 150;
    }

    const raf = b.newRafale();
    raf.addShot(1, [3, 0.4], 5, 5 + 4 * lvl);
    b.shootTimer = 10;

    this.FL_CREATE_LOCK = false;
    return b;
  }
}
