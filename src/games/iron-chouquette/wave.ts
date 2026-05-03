import { PATH, STAGE_WIDTH, C500 } from './constants';
import type { Bads } from './bads';

// Wave.mt — groups Bads instances along a single hardcoded path index.
// Computes cumulative distance per segment so Bads.behaviorPath() can interpolate.

export class Wave {
  flLinear: boolean;
  bList: Bads[] = [];
  speed: number;
  ecart = 30;
  score: number = C500;
  path: number[][];
  pl: number[] = [0];

  constructor(id: number, sp: number, fl: boolean) {
    this.flLinear = fl;
    const mp = PATH[id];
    this.path = mp.map((p) => p.slice());

    let dist = 0;
    let x = this.path[0][0];
    let y = this.path[0][1];
    for (let i = 1; i < this.path.length; i += 1) {
      const p = this.path[i];
      const dx = p[0] - x;
      const dy = p[1] - y;
      dist += Math.sqrt(dx * dx + dy * dy);
      this.pl.push(dist);
      x = p[0];
      y = p[1];
    }

    this.speed = sp;
  }

  flipPath(n: number): void {
    for (let i = 0; i < this.path.length; i += 1) {
      const a = this.path[i];
      const w = STAGE_WIDTH * 0.5;
      a[n] = w - (a[n] - w);
    }
  }

  addBad(b: Bads): void {
    b.way = -this.bList.length * this.ecart;
    b.waveIndex = this.bList.length;
    b.pathIndex = 0;
    this.bList.push(b);
    b.wave = this;
    b.bList.push(0);
    b.frict = 1;
    b.x = this.path[0][0];
    b.y = this.path[0][1];
    b.vx = 0;
    b.vy = 0;
  }

  addBads(f: () => Bads | null, max: number): void {
    for (let i = 0; i < max; i += 1) {
      const b = f();
      if (b) this.addBad(b);
    }
  }
}
