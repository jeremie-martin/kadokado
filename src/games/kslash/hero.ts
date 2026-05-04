// Hero — port of Hero.mt. Extends Ent (cell-based position, recal physics).
//
// State machine:
//   ST_NORMAL  walking/idle on ground
//   ST_FLY     airborne (jump, double-jump, falling)
//   ST_DEATH   bouncing-off-screen death animation

import { ColorMatrixFilter, Container, Sprite } from 'pixi.js';
import { setFrame } from '../_shared/frames';
import {
  HERO_FRAMES,
  HERO_JUMP_EXTEND,
  HERO_JUMP_START,
  HERO_QUEUE_SPACE,
  HERO_SPEED,
  HERO_SPEED_SUPER,
  HERO_STAR_SPEED,
  MCH,
  OPT_FLAMES,
  OPT_KATANA,
  OPT_SCROLL,
  SIZE,
  ST_DEATH,
  ST_FLY,
  ST_NORMAL,
  TMOD,
  XMAX,
  YMAX,
} from './constants';
import type { GameContext } from './game-context';
import { Ent } from './enemies';
import { Star } from './projectiles';
import type { Kunai } from './projectiles';

export type HeroInput = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  shoot: boolean; // SPACE/CTRL pressed (held)
};

// Hero animation slices over the 150-frame mcHero sheet. Frame ranges are
// pulled from the SWF timeline labels via FFDec (R19). Atlas is 1-indexed in
// `public/assets/kslash/hero/` (1.png..150.png) loaded into a 0-indexed
// array, so each `start` here is `(SWF frame label) - 1`. Counts run up to
// the next label. `walk` (frame 128, single transition frame) and `run`
// (frame 29..32, four-frame intro) are folded into their `_loop` ranges
// because the port has no chained next-anim mechanism: source plays
// walk → `gotoAndStop("walk_loop")` and run → `gotoAndStop("run_loop")` on
// the immediately-following frame, so using the loop range gives the same
// continuous gait.
const HERO_ANIMS: { name: string; start: number; count: number; loop: boolean }[] = [
  { name: 'wait', start: 0, count: 28, loop: true },
  { name: 'run', start: 32, count: 27, loop: true },
  { name: 'fly_up', start: 59, count: 11, loop: false },
  { name: 'fly_down', start: 70, count: 5, loop: false },
  { name: 'fall', start: 75, count: 16, loop: false },
  { name: 'land', start: 91, count: 12, loop: false },
  { name: 'death', start: 103, count: 13, loop: false },
  { name: 'ball', start: 116, count: 11, loop: true },
  { name: 'walk', start: 128, count: 13, loop: true },
  { name: 'tronc', start: 141, count: 9, loop: false },
];

export class Hero extends Ent {
  // Movement / state flags.
  flMoving = false;
  flCheckGroundSafe = false;
  flDoubleJump = false;
  flDoubleJumpReady = false;
  flUp = false;
  flGameOver = false;
  flInvicible = false;
  flControl = true;
  flShootReady = true;

  cooldown = 0;
  boost: number | null = null;

  // Wood / scroll-power-up countdown.
  woodTimer: number | null = null;

  // Super-mode.
  sTimer: number | null = null;
  qTimer = 0;
  blink = 0;
  speedBase = HERO_SPEED;
  // Super-mode white-pulse filter (ColorMatrixFilter; replicates source's
  // Cs.setPercentColor(view, prc, 0xFFFFFF) with prc=(cos(blink/100)+1)*40).
  // Allocated lazily when super-mode starts; destroyed when sTimer ends.
  private superFilter: ColorMatrixFilter | null = null;

  // Star pool.
  star = 0;

  input: HeroInput = { left: false, right: false, up: false, down: false, shoot: false };

  // Animation state.
  private animName: string = 'wait';
  private animFrame = 0;
  private animElapsed = 0;
  private heroSprite: Sprite;

  // R19/R20 SWF-derived overlays. Source's mcHero has two named child clips:
  //   bfx   (DefineSprite 29): 4-frame slash flash; gotoAndPlay("2") on slash
  //   kunai (DefineSprite 72): single-frame kunai shape; rotated to match the
  //                            incoming Kunai during tronc/Scroll recovery
  // R20: bfx now uses the actual 3 painted crescent frames extracted from
  // gfx.swf (assets.bfx) instead of the kunai.png stand-in used in R19. The
  // `blade` child (DefineSprite 28) of source's bfx is rendered via the same
  // crescent at two scales: source's `blade.gotoAndStop(katana ? 2 : 1)` —
  // frame 1 places the painted shape at scaleX=0.63,scaleY=0.70 (small
  // crescent) and frame 2 strips the placement (only the parent bfx tweens
  // the alpha-fading bigger crescent). We approximate frame 2 by scaling the
  // bfx sprite up when Katana is equipped, matching the source's longer reach.
  private bfxSprite: Sprite | null = null;
  private bfxTimer = 0; // counts down while the slash flash is visible
  private kunaiSprite: Sprite | null = null;

  constructor(view: Container, game: GameContext, heroSprite: Sprite) {
    super(view, game);
    this.heroSprite = heroSprite;
    this.x = Math.floor(XMAX * 0.5);
    this.y = 1;
    this.weight = 0.7;
    this.cooldown = 0;
    this.sens = 1;
    this.flControl = true;
    this.incStar(40);
    this.fall();
  }

  // ---- state transitions ----

  initStep(n: number): void {
    this.step = n;
    switch (n) {
      case ST_NORMAL:
        this.flMoving = false;
        break;
      case ST_FLY:
        this.flUp = true;
        this.flGround = false;
        break;
      case ST_DEATH:
        this.nextAnim = 'death';
        this.vy = -8;
        this.vx *= 0.5;
        this.flCol = false;
        this.flInvicible = true;
        this.flGround = false;
        break;
    }
  }

  // ---- main update ----

  override update(): void {
    const jvx = this.vx;
    super.update();
    if (!this.flGround) this.vx = jvx; // no air friction (PATCH from source)

    switch (this.step) {
      case ST_NORMAL:
        this.control();
        break;
      case ST_FLY:
        this.control();
        if (this.flUp && this.vy > 0 && this.flDoubleJump) {
          this.flUp = false;
          if (this.nextAnim === null) this.nextAnim = 'fly_down';
        }
        break;
      case ST_DEATH: {
        const yLim = MCH * 2 - 18;
        if (this.view.y > yLim) {
          this.vy *= -1.25;
          if (!this.flGameOver) {
            this.game.stats.$dif = Math.floor(this.game.dif);
            this.flGameOver = true;
            // Source calls KKApi.gameOver(stats) here — platform-side hook
            // we cannot replicate. Surface the end-of-run feedback as a
            // local HUD overlay so the player sees the run terminated and
            // their final score / dif (R4 flagged this as never-updated).
            this.game.showGameOver();
          }
          this.view.y = yLim;
        }
        break;
      }
    }

    if (this.woodTimer !== null) {
      this.woodTimer -= TMOD;
      if (this.woodTimer < 0) {
        this.woodTimer = null;
        this.flControl = true;
        this.flInvicible = false;
        this.detachKunaiOverlay();
        this.teleport();
      }
    } else {
      if (this.view.rotation !== 0) this.view.rotation = 0;
    }

    this.updateBfxFlash();

    if (this.boost !== null) {
      this.boost *= Math.pow(0.8, TMOD * 0.5 + 0.5);
      if (this.boost < 0.1) this.boost = null;
    }

    if (this.sTimer !== null) this.updateSupa();

    if (this.flCol && !this.flInvicible) {
      this.checkDeath();
      this.checkBonus();
    }

    this.advanceAnim();
  }

  // ---- input/control ----

  control(): void {
    if (!this.flControl) return;
    let flMove = false;

    if (this.input.left) {
      this.setSens(-1);
      flMove = true;
    }
    if (this.input.right) {
      this.setSens(1);
      flMove = true;
    }

    if (flMove) {
      if (this.flGround) {
        this.vx = this.speedBase * this.sens;
      } else if (this.flDoubleJump) {
        const dvx = this.speedBase * this.sens - this.vx;
        const lim = 0.25;
        this.vx += Math.min(Math.max(-lim, dvx * 0.1), lim);
      }
      if (!this.flMoving) {
        this.flMoving = true;
        if (this.flGround) {
          this.nextAnim = 'walk';
          for (let i = 0; i < 3; i += 1) {
            const cellX = this.x - i * this.sens;
            if (cellX >= 0 && cellX < XMAX && this.game.grid[cellX][this.y].list.length > 0) {
              this.nextAnim = 'run';
              break;
            }
          }
        }
      }
    } else {
      if (this.flMoving) {
        this.flMoving = false;
        if (this.flGround) this.nextAnim = 'wait';
      }
    }

    if (this.flGround) {
      this.vx *= Math.pow(0.8, TMOD);
    }

    // JUMP
    if (this.input.up) {
      if (this.flGround) {
        this.flDoubleJump = true;
        this.flDoubleJumpReady = false;
        this.jump();
      } else if (this.flDoubleJump && this.flDoubleJumpReady) {
        this.flDoubleJump = false;
        this.jump();
        this.nextAnim = 'ball';
        if (flMove) this.vx = this.speedBase * this.sens;
      } else {
        if (this.boost !== null) {
          this.vy -= HERO_JUMP_EXTEND * this.boost * TMOD;
        }
      }
    } else {
      this.flDoubleJumpReady = true;
    }

    // DOWN
    if (this.flGround && this.input.down && this.y + 2 < YMAX) {
      this.jump();
      this.boost = 0;
      this.vy *= 0.65;
      this.flCheckGroundSafe = true;
    }

    // SHOOT
    this.cooldown -= TMOD;
    if (this.input.shoot) {
      if (this.cooldown < 0 && this.flShootReady) this.shoot();
    } else {
      this.flShootReady = true;
    }
  }

  jump(): void {
    this.initStep(ST_FLY);
    this.boost = 1;
    this.vy = -HERO_JUMP_START;
    this.nextAnim = 'fly_up';
  }

  override land(): void {
    if (this.woodTimer !== null) {
      if (this.vy > 4) {
        this.vr = (Math.random() * 2 - 1) * Math.abs(this.vy) * 3;
      }
      this.vx *= 0.8;
      this.vy *= -1;
      return;
    }
    super.land();
    this.initStep(ST_NORMAL);
    if (this.nextAnim === null) this.nextAnim = 'land';
    this.flDoubleJump = true;

    for (let i = 0; i < 3; i += 1) {
      const p = this.game.newPart('partDust');
      p.view.x = this.view.x + (Math.random() * 2 - 1) * 14;
      p.view.y = this.view.y + 12 + Math.random() * 24;
      p.weight = 0.1 + Math.random() * 0.3;
      p.scale = 50 + Math.random() * 70;
      p.view.scale.set(p.scale / 100);
      p.t = 20 + Math.random() * 10;
      p.ft = 0;
    }
  }

  override checkGround(): boolean {
    if (this.flCheckGroundSafe) {
      this.flCheckGroundSafe = false;
      return false;
    }
    return super.checkGround();
  }

  override fall(): void {
    this.initStep(ST_FLY);
    super.fall();
    this.nextAnim = 'fall';
    this.flUp = false;
  }

  // ---- attacks ----

  shoot(): void {
    const list = this.game.getClosestMonsters();
    this.flShootReady = false;
    if (list.length === 0) {
      // No targets — quick slash anim cooldown to prevent spam.
      this.cooldown = 5;
      return;
    }

    const trg = list[0].m;
    const dxt = trg.view.x - this.view.x;
    const dyt = (trg.view.y - this.view.y) * 1.5;
    const dist = Math.sqrt(dxt * dxt + dyt * dyt);
    const flNear = dist < (this.game.optList[OPT_KATANA] ? 72 : 48);
    if (flNear || this.star === 0) {
      this.slash(trg, flNear);
      return;
    }

    let max = 1;
    if (this.step === ST_FLY && !this.flDoubleJump) {
      max = Math.min(this.star, list.length);
    }

    for (let i = 0; i < max; i += 1) {
      const o = list[i];
      if (o.d > 8) break;
      this.throwStar(o.m);
    }
  }

  private slash(trg: import('./enemies').Monster, flNear: boolean): void {
    this.cooldown = 10;
    // R19: source plays `bfx.gotoAndPlay("2")` (3-frame flash) and
    // `bfx.blade.gotoAndStop(katana ? "2" : "1")`. We don't have the
    // nested-MC composition; approximate as a transient white flash sprite
    // pointing in the hero's facing direction. Larger when Katana is
    // equipped (matches source's blade-frame-2 reach).
    this.spawnBfxFlash(this.game.optList[OPT_KATANA]);
    if (flNear) {
      if ((trg.x - this.x) * this.sens < 0) this.setSens((-this.sens) as 1 | -1);
      trg.cut(21);
      if (trg.hp > 0) {
        this.vx = -5 * this.sens;
      }
    }
  }

  private spawnBfxFlash(katana: boolean): void {
    if (this.bfxSprite === null) {
      // Lazy allocate: use the FFDec-extracted bfx atlas (3 frames of the
      // painted white crescent at decreasing alpha). Frame 0 = full-alpha
      // big crescent, frame 1 = mid-alpha (CXFORM alphaMult 205/256≈0.80),
      // frame 2 = low-alpha (alphaMult 51/256≈0.20). Source's
      // `gotoAndPlay("2")` plays the same three frames.
      const sp = new Sprite(this.game.assets.bfx[0].texture);
      // Bbox of the painted crescent inside the 50×45 atlas is roughly
      // (8,6)..(37,39) on frame 1 — i.e., centred near (22,22). Anchor at
      // that point so the crescent rotates around the blade-strike pivot.
      sp.anchor.set(22 / 50, 22 / 45);
      sp.visible = false;
      this.view.addChild(sp);
      this.bfxSprite = sp;
    }
    const sp = this.bfxSprite;
    setFrame(sp, this.game.assets.bfx[0]);
    sp.visible = true;
    // Source's `blade.gotoAndStop(katana ? 2 : 1)` swaps the painted shape
    // between scaleX=0.63,scaleY=0.70 (frame 1, small) and scale 1.0
    // (frame 2, big sword reach). Mirror that here as a uniform scale on
    // the parent bfx sprite — Katana branch keeps the painted geometry
    // larger, matching the slash range threshold (72 vs 48 px).
    const s = katana ? 1.0 : 0.65;
    // The hero view's `scale.x = sens` (Ent.setSens) inverts when hero
    // faces left, so the child bfx sprite is auto-mirrored. We only need
    // to position the bfx in front of the hero in local hero coords (the
    // local +x is always the hero's facing direction once view.scale.x
    // is applied).
    sp.scale.set(s);
    sp.x = 8;
    sp.y = -1;
    sp.rotation = 0;
    // 3 frames at ~40 fps ≈ 75 ms — matches Flash's 3-frame `gotoAndPlay("2")`.
    this.bfxTimer = 3;
  }

  private updateBfxFlash(): void {
    if (this.bfxSprite === null || !this.bfxSprite.visible) return;
    this.bfxTimer -= TMOD;
    if (this.bfxTimer <= 0) {
      this.bfxSprite.visible = false;
      return;
    }
    // Step the bfx atlas frame by elapsed-frame index. timer=3 → frame 0,
    // timer=2 → frame 1, timer=1 → frame 2. Matches Flash's per-tick
    // playhead advance through the 3-frame `gotoAndPlay("2")` window.
    const idx = Math.min(2, Math.max(0, 3 - Math.ceil(this.bfxTimer)));
    setFrame(this.bfxSprite, this.game.assets.bfx[idx]);
  }

  private attachKunaiOverlay(rotation: number): void {
    if (this.kunaiSprite === null) {
      const sp = new Sprite(this.game.assets.kunai.texture);
      sp.anchor.set(0.5);
      this.view.addChild(sp);
      this.kunaiSprite = sp;
    }
    this.kunaiSprite.visible = true;
    this.kunaiSprite.rotation = rotation;
    this.kunaiSprite.x = 0;
    this.kunaiSprite.y = -2;
  }

  private detachKunaiOverlay(): void {
    if (this.kunaiSprite !== null) this.kunaiSprite.visible = false;
  }

  private throwStar(trg: import('./enemies').Monster): void {
    this.incStar(-1);
    this.cooldown = 2;
    const a = this.getAng(trg);
    const sp = new Sprite(this.game.assets.ninjaShot[0].texture);
    sp.anchor.set(0.5);
    this.game.shootLayer.addChild(sp);
    const s = new Star(sp, this.game, this.game.assets.ninjaShot);
    s.x = this.x;
    s.y = this.y;
    s.dx = this.dx + (this.cx - 1) * SIZE * 0.5;
    s.dy = this.dy + (this.cy - 1) * SIZE * 0.5;
    s.vx = Math.cos(a) * HERO_STAR_SPEED;
    s.vy = Math.sin(a) * HERO_STAR_SPEED;
    s.setFlames(this.game.optList[OPT_FLAMES]);
  }

  // ---- collision callbacks ----

  private checkDeath(): void {
    for (let tx = 0; tx < 3; tx += 1) {
      for (let ty = 0; ty < 3; ty += 1) {
        const gx = this.x + tx - 1;
        const gy = this.y + ty - 1;
        if (gx < 0 || gx >= XMAX || gy < 0 || gy >= YMAX) continue;
        const list = this.game.grid[gx][gy].list;
        for (let i = 0; i < list.length; i += 1) {
          const m = list[i];
          const d = this.getDist(m);
          if (d < 24) {
            if (this.sTimer === null) {
              if (this.step === ST_FLY && !m.flSpike) {
                const da = Math.abs(1.57 - this.getAng(m));
                if (da < 1.3) {
                  if (this.vy > 0) {
                    this.vy = -8;
                    m.harm(21);
                  }
                  return;
                }
              }
              if (d < 18) {
                this.initStep(ST_DEATH);
              }
            } else {
              this.burst(m);
            }
          }
        }
      }
    }
  }

  private checkBonus(): void {
    // Source iterates without compensating for take()'s splice. We match
    // verbatim — the (rare) effect is that overlapping bonuses pickled in
    // the same frame may skip one and pick it up next frame instead.
    for (let i = 0; i < this.game.bList.length; i += 1) {
      const b = this.game.bList[i];
      if (this.getDist({ view: b.view }) < 24) {
        b.take();
      }
    }
  }

  hit(s: Kunai): void {
    if (this.game.optList[OPT_SCROLL]) {
      this.game.optList[OPT_SCROLL] = false;
      this.game.updateIcons();
      this.setSens(1);
      // Source plays the tronc anim immediately via gotoAndPlay BEFORE
      // setting flFreezeAnim. Using `nextAnim` here would never resolve
      // because the next super.update() sees flFreezeAnim=true and skips
      // the anim swap. Apply directly so the tronc visual actually shows.
      this.playAnim('tronc');
      // R19: source pins a `kunai` child clip to the hero with its rotation
      // copied from the incoming Kunai (`kunai._rotation = s.root._rotation`).
      // Since Star/Kunai don't track view rotation in the port, derive it
      // from the projectile's velocity vector — equivalent geometry.
      this.attachKunaiOverlay(Math.atan2(s.vy, s.vx));
      this.smoke();
      this.flFreezeAnim = true;
      this.flInvicible = true;
      this.flControl = false;
      this.woodTimer = 30;
      const vitx = s.vx * 0.5;
      let vity = s.vy * 0.5 - 3;
      if (this.flGround) {
        vity = Math.min(0, vity);
        if (vity < 0) this.initStep(ST_FLY);
      }
      this.vx += vitx;
      this.vy += vity;
    } else {
      this.initStep(ST_DEATH);
    }
  }

  teleport(): void {
    this.vr = 0;
    this.x = Math.floor(XMAX * 0.5);
    this.y = 1;
    this.vx = 0;
    this.vy = 0;
    this.flFreezeAnim = false;
    this.fall();
    this.smoke();
  }

  smoke(): void {
    const p = this.game.newPart('partSmoke');
    p.view.x = (this.x + 0.25 + this.cx * 0.5) * SIZE + this.dx;
    p.view.y = (this.y + 0.25 + this.cy * 0.5) * SIZE + this.dy;
  }

  // ---- super mode ----

  initSupa(): void {
    this.sTimer = 500;
    this.blink = 0;
    this.speedBase = HERO_SPEED_SUPER;
  }

  private updateSupa(): void {
    if (this.sTimer === null) return;
    this.sTimer -= TMOD;
    this.qTimer -= TMOD;
    if (this.qTimer < 0) {
      this.qTimer = HERO_QUEUE_SPACE;
      // Spawn a shade copy on the shade layer.
      const idx = Math.max(0, Math.min(this.animFrame, this.game.assets.shade.length - 1));
      const ssprite = new Sprite(this.game.assets.shade[idx].texture);
      ssprite.anchor.set(0.5);
      ssprite.x = this.view.x;
      ssprite.y = this.view.y;
      ssprite.scale.x = this.view.scale.x;
      ssprite.scale.y = this.view.scale.y;
      ssprite.alpha = 0.5;
      this.game.shadeLayer.addChild(ssprite);
      // Auto-remove on a short timer via the particle system.
      const part = this.game.newPart('partLight');
      part.view.removeFromParent();
      part.view = ssprite;
      part.t = 12;
      part.ft = 1;
      part.weight = 0;
      part.frict = 1;
    }

    let blinkSpeed = 67;
    if (this.sTimer < 100) blinkSpeed = 127;
    this.blink = (this.blink + blinkSpeed * TMOD) % 628;
    if (this.sTimer < 0) {
      this.sTimer = null;
      this.speedBase = HERO_SPEED;
      this.releaseSuperFilter();
      return;
    }
    // Source: prc = (cos(blink/100)+1)*40 ∈ [0, 80] (percentage toward white).
    // Apply via ColorMatrixFilter so the hero actually brightens (Pixi tint is
    // multiplicative, can't lighten). Matrix: out = in*(1-p) + 1*p.
    const prc = (Math.cos(this.blink / 100) + 1) * 40;
    const p = Math.max(0, Math.min(1, prc / 100));
    const d = 1 - p;
    if (this.superFilter === null) {
      this.superFilter = new ColorMatrixFilter();
      this.heroSprite.filters = [this.superFilter];
    }
    this.superFilter.matrix = [
      d, 0, 0, 0, p,
      0, d, 0, 0, p,
      0, 0, d, 0, p,
      0, 0, 0, 1, 0,
    ];
  }

  private releaseSuperFilter(): void {
    if (this.superFilter !== null) {
      this.heroSprite.filters = [];
      this.superFilter.destroy();
      this.superFilter = null;
    }
  }

  // Public cleanup — called by Game.destroy() to release the filter when the
  // game is torn down mid-super-mode.
  releaseFilters(): void {
    this.releaseSuperFilter();
  }

  burst(m: import('./enemies').Monster): void {
    m.harm(100);
    const max = 8;
    for (let v = 0; v < max; v += 1) {
      for (let n = 0; n < 2; n += 1) {
        const p = this.game.newPart('partLight');
        p.view.x = m.view.x;
        p.view.y = m.view.y;
        const a = ((v + 0.5 * n) / max) * 6.28;
        const speed = 3 + n * 2;
        p.vx += Math.cos(a) * speed;
        p.vy += Math.sin(a) * speed;
        p.t = 26 + Math.random() * 4 - n * 10;
        p.frict = 0.9;
      }
    }
  }

  // ---- star pool ----

  incStar(n: number): void {
    this.star = Math.floor(Math.min(Math.max(0, this.star + n), 200));
    this.game.setStarText(this.star);
  }

  // ---- animation ----

  private advanceAnim(): void {
    if (this.flFreezeAnim) return;
    const def = HERO_ANIMS.find((a) => a.name === this.animName);
    if (!def) return;
    this.animElapsed += TMOD;
    if (this.animElapsed >= 1) {
      this.animElapsed -= 1;
      this.animFrame += 1;
      if (this.animFrame >= def.count) {
        this.animFrame = def.loop ? 0 : def.count - 1;
      }
      const idx = Math.max(0, Math.min(def.start + this.animFrame, HERO_FRAMES - 1));
      setFrame(this.heroSprite, this.game.assets.hero[idx]);
    }
  }

  protected override playAnim(name: string): void {
    const def = HERO_ANIMS.find((a) => a.name === name);
    if (!def) return;
    this.animName = name;
    this.animFrame = 0;
    // Source's Flash MovieClip holds the gotoAndPlay target frame for one
    // tick BEFORE advancing. The port's advanceAnim() runs in the same tick
    // as playAnim() (called from Ent.update via nextAnim, or directly from
    // Hero.hit), so without this offset the first frame of every animation
    // is overwritten before render — the death/land/hit/tronc poses are
    // never visible. Initializing animElapsed to `-TMOD` makes the in-tick
    // advanceAnim land at 0 (< 1) so frame 0 holds for one tick, matching
    // Flash's gotoAndPlay → enterFrame cadence.
    this.animElapsed = -TMOD;
    setFrame(this.heroSprite, this.game.assets.hero[def.start]);
  }
}
