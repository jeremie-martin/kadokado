import { ColorMatrixFilter, type Container } from 'pixi.js';
import { Sprite } from './sprite';
import { TMOD } from './constants';
import type { IronChouquetteGame } from './game';

// Phys.mt — gravity, friction, angular velocity, plasma draw call,
// flash decay (damage feedback). Concrete subclasses tend to override `update()`.

export class Phys extends Sprite {
  ray = 0;

  weight: number | null = null;
  frict: number | null = null;
  vx = 0;
  vy = 0;
  vr: number | null = null;

  // Damage flash percent — when set, decays exponentially each frame.
  flash: number | null = null;
  // Plasma render channel: 0 = additive, 1 = normal; see Game.plasmaDraw().
  plasmaId: number | null = null;
  // Lazily created white-flash filter; shared across damage hits so we don't
  // allocate per frame. Cleared (filters=[]) when the flash decays out.
  private flashFilter: ColorMatrixFilter | null = null;

  constructor(game: IronChouquetteGame, root: Container) {
    super(game, root);
  }

  update(): void {
    super.update();

    if (this.weight !== null) this.vy += this.weight * TMOD;

    if (this.frict !== null) {
      const f = Math.pow(this.frict, TMOD);
      this.vx *= f;
      this.vy *= f;
    }
    if (this.vr !== null) {
      if (this.frict !== null) this.vr *= this.frict;
      this.rotationDeg += this.vr * TMOD;
      this.root.rotation = (this.rotationDeg * Math.PI) / 180;
    }

    this.x += this.vx * TMOD;
    this.y += this.vy * TMOD;

    if (this.plasmaId !== null) {
      this.game.plasmaDraw(this.root, this.plasmaId);
    }
  }

  updateFlash(): void {
    if (this.flash !== null) {
      let prc = Math.min(this.flash, 100);
      this.flash *= 0.6;
      if (this.flash < 2) {
        this.flash = null;
        prc = 0;
      }
      // Cs.setPercentColor: tint root toward white by `prc` percent. We do a simple tint approximation.
      // The Pixi 8 Container has no tint; we apply on the first child Sprite if available.
      this.applyFlashTint(prc);
    }
  }

  // Replicates Cs.setPercentColor(root, prc, 0xFFFFFF) with a ColorMatrixFilter.
  // Source lerps each channel toward 0xFF by `prc`%: out = px*(1-c) + 1.0*c. Pixi
  // ColorMatrixFilter offsets are 0..1 normalised, so set diag = 1-c and per-channel
  // offset = c. This produces a true bright damage flash (the multiplicative tint
  // approach used in earlier passes could not brighten beyond texture white).
  protected applyFlashTint(prc: number): void {
    const c = Math.min(Math.max(prc, 0), 100) / 100;
    if (c <= 0) {
      if (this.flashFilter) {
        this.root.filters = [];
        this.flashFilter = null;
      }
      return;
    }
    const k = 1 - c;
    const fl = this.flashFilter ?? new ColorMatrixFilter();
    // 4x5 row-major matrix: diag=k, alpha=1, RGB offsets=c (normalised).
    fl.matrix = [
      k, 0, 0, 0, c,
      0, k, 0, 0, c,
      0, 0, k, 0, c,
      0, 0, 0, 1, 0,
    ];
    if (!this.flashFilter) {
      this.flashFilter = fl;
      this.root.filters = [fl];
    }
  }

  speedToward(o: { x: number; y: number }, c: number, lim: number): void {
    const dx = o.x - this.x;
    const dy = o.y - this.y;
    const cl = (v: number) => Math.min(Math.max(v, -lim), lim);
    this.vx += cl(dx * c);
    this.vy += cl(dy * c);
  }

  collide(sp: { x: number; y: number; ray: number }): boolean {
    const d = this.getDist(sp);
    return d < this.ray + sp.ray;
  }
}
