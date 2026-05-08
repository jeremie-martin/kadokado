import { Container, Graphics } from 'pixi.js';
import type { Segment } from './interwheel-planner';

export type OverlayMode = 'on' | 'off';


// Visual defaults. The instance fields below mirror these and can be
// overridden at runtime via the playground sliders.
//
// alphaGamma: curve applied to each edge's rank-of-support. The planner's
//   lineage pass produces support that grows roughly exponentially with depth
//   on the principal prefix (recurrence factor branching × decay > 1), so
//   support magnitude is dominated by a single outlier and not useful for
//   direct normalization. Rank-mapping discards magnitude but preserves the
//   ordering lineage support imposed: a good prefix earns top rank because
//   of its descendants. γ=4 is the current default after playtesting.
//
// minDrawAlpha: below this alpha, skip drawing entirely. Avoids a "carpet"
//   of near-invisible lines accumulating into visible noise.
//
// widthMin / widthMax: stroke width is interpolated by *support magnitude*
//   (not alpha) — width = lerp(min, max, clamp(support / p95Support, 0, 1)).
//   Alpha answers "is this edge competitive enough to show?"; width answers
//   "how much search mass flowed through this edge?" Equal min/max gives
//   uniform width.
export const OVERLAY_DEFAULTS: {
  alphaGamma: number;
  minDrawAlpha: number;
  widthMin: number;
  widthMax: number;
  color: number;
} = {
  alphaGamma: 4,
  minDrawAlpha: 0.05,
  widthMin: 1,
  widthMax: 3,
  color: 0x9be8ff,
};

// Saturation percentile for the support → width mapping. p95 makes the top
// 5% of edges (= chosen-prefix root and a handful of near-top expanded
// prefixes) saturate at widthMax, while the rest scale linearly. p100 (max)
// would let the chosen-prefix outlier dominate and crush everything else
// to widthMin.
const WIDTH_NORM_PERCENTILE = 0.95;

// Debug palette for "color by generation" mode. Each search-tree depth gets
// a distinct rainbow color so the user can see which generations contribute
// which edges. Cycles modulo length for very deep trees.
const GENERATION_COLORS: number[] = [
  0xff5555, // gen 1 — red
  0xff9933, // gen 2 — orange
  0xffee44, // gen 3 — yellow
  0x66ff66, // gen 4 — green
  0x4488ff, // gen 5 — blue
  0x9966ff, // gen 6 — indigo
  0xff66cc, // gen 7 — violet
];

export type OverlayStats = {
  segments: number;
  edges: number;
  bestSupport: number;
  medianSupport: number;
  worstSupport: number;
  alphaBuckets: { hi: number; mid: number; lo: number };
};

const EMPTY_STATS: OverlayStats = {
  segments: 0,
  edges: 0,
  bestSupport: 0,
  medianSupport: 0,
  worstSupport: 0,
  alphaBuckets: { hi: 0, mid: 0, lo: 0 },
};

type DrawRun = {
  edgeId: number;
  width: number;
  alpha: number;
  color: number;
  segments: Segment[];
};

export class TrajectoryOverlay {
  private readonly graphics = new Graphics();
  private mode: OverlayMode = 'on';
  private stats: OverlayStats = { ...EMPTY_STATS };
  private alphaGamma = OVERLAY_DEFAULTS.alphaGamma;
  private minDrawAlpha = OVERLAY_DEFAULTS.minDrawAlpha;
  private widthMin = OVERLAY_DEFAULTS.widthMin;
  private widthMax = OVERLAY_DEFAULTS.widthMax;
  private color = OVERLAY_DEFAULTS.color;
  private colorByGeneration = false;

  constructor(parent: Container) {
    this.graphics.roundPixels = true;
    parent.addChild(this.graphics);
  }

  setMode(mode: OverlayMode): void {
    this.mode = mode;
    this.graphics.visible = mode !== 'off';
    if (mode === 'off') {
      this.graphics.clear();
      this.stats = { ...EMPTY_STATS };
    }
  }

  getMode(): OverlayMode {
    return this.mode;
  }

  toggle(): OverlayMode {
    this.setMode(this.mode === 'on' ? 'off' : 'on');
    return this.mode;
  }

  setAlphaGamma(g: number): void {
    this.alphaGamma = Math.max(0.1, g);
  }

  setMinDrawAlpha(a: number): void {
    this.minDrawAlpha = Math.max(0, Math.min(1, a));
  }

  setWidthMin(w: number): void {
    this.widthMin = Math.max(0.1, w);
  }

  setWidthMax(w: number): void {
    this.widthMax = Math.max(0.1, w);
  }

  setColor(c: number): void {
    this.color = c & 0xffffff;
  }

  setColorByGeneration(on: boolean): void {
    this.colorByGeneration = on;
  }

  lastDrawnStats(): OverlayStats {
    return this.stats;
  }

  draw(segments: Segment[]): void {
    const g = this.graphics;
    g.clear();
    if (this.mode === 'off' || segments.length === 0) {
      this.stats = { ...EMPTY_STATS };
      return;
    }

    // One observation per edge regardless of segment count — long flights
    // shouldn't bias the support distribution.
    const edgeSupport = new Map<number, number>();
    for (const s of segments) {
      if (!edgeSupport.has(s.edgeId)) edgeSupport.set(s.edgeId, s.support);
    }
    const sorted = [...edgeSupport.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const supportMax = Math.max(sorted[sorted.length - 1][1], Number.EPSILON);
    const rankByEdge = new Map<number, number>();
    const denom = Math.max(1, sorted.length - 1);
    for (let i = 0; i < sorted.length; i += 1) {
      rankByEdge.set(sorted[i][0], sorted.length <= 1 ? 1 : i / denom);
    }
    const pivotIdx = Math.min(sorted.length - 1, Math.floor(sorted.length * WIDTH_NORM_PERCENTILE));
    const widthPivot = Math.max(sorted[pivotIdx][1], Number.EPSILON);
    const widthLow = Math.min(this.widthMin, this.widthMax);
    const widthHigh = Math.max(this.widthMin, this.widthMax);
    const widthSpan = widthHigh - widthLow;

    let hi = 0;
    let mid = 0;
    let lo = 0;
    const drawnEdges = new Set<number>();
    let drawnSegments = 0;
    const runs: DrawRun[] = [];

    for (const s of segments) {
      const alpha = s.onChosenChain ? 1 : Math.pow(rankByEdge.get(s.edgeId) ?? 0, this.alphaGamma);
      if (alpha >= 0.5) hi++;
      else if (alpha >= 0.15) mid++;
      else lo++;
      if (alpha < this.minDrawAlpha) continue;
      const widthFactor = Math.min(1, s.support / widthPivot);
      const width = widthLow + widthSpan * widthFactor;
      const color = this.colorByGeneration
        ? GENERATION_COLORS[(Math.max(1, s.generation) - 1) % GENERATION_COLORS.length]
        : this.color;
      const lastRun = runs[runs.length - 1];
      if (lastRun?.edgeId === s.edgeId) {
        lastRun.segments.push(s);
      } else {
        runs.push({ edgeId: s.edgeId, width, alpha, color, segments: [s] });
      }
      drawnEdges.add(s.edgeId);
      drawnSegments++;
    }

    for (const run of runs) {
      let px = Number.NaN;
      let py = Number.NaN;
      for (const s of run.segments) {
        if (s.x0 !== px || s.y0 !== py) g.moveTo(s.x0, s.y0);
        g.lineTo(s.x1, s.y1);
        px = s.x1;
        py = s.y1;
      }
      g.stroke({ color: run.color, width: run.width, alpha: run.alpha, cap: 'round', join: 'round' });
    }

    this.stats = {
      segments: drawnSegments,
      edges: drawnEdges.size,
      bestSupport: supportMax,
      medianSupport: sorted[sorted.length >> 1][1],
      worstSupport: sorted[0][1],
      alphaBuckets: { hi, mid, lo },
    };
  }
}
