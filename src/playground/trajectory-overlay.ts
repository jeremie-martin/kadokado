import { Container, Graphics } from 'pixi.js';
import type { Segment } from './interwheel-planner';
import {
  DEFAULT_TRAJECTORY_GENERATION_WIDTH_WEIGHTS,
  normalizeTrajectoryGenerationWidthWeights,
  trajectoryGenerationWidthWeight,
  type TrajectoryGenerationWidthWeights,
} from './trajectory-rendering';

export type OverlayMode = 'on' | 'off';

export const OVERLAY_DEFAULTS: {
  minSupportRank: number;
  widthMin: number;
  widthMax: number;
  shareWidthScale: number;
  alphaMin: number;
  alphaMax: number;
  alphaGamma: number;
  generationWidthWeights: TrajectoryGenerationWidthWeights;
  color: number;
} = {
  minSupportRank: 0.7,
  widthMin: 0.3,
  widthMax: 7,
  shareWidthScale: 18,
  alphaMin: 0.07,
  alphaMax: 0.9,
  alphaGamma: 4,
  generationWidthWeights: DEFAULT_TRAJECTORY_GENERATION_WIDTH_WEIGHTS,
  color: 0xff3333,
};

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
  culledEdges: number;
  bestSupport: number;
  medianSupport: number;
  worstSupport: number;
  maxGeneration: number;
};

const EMPTY_STATS: OverlayStats = {
  segments: 0,
  edges: 0,
  culledEdges: 0,
  bestSupport: 0,
  medianSupport: 0,
  worstSupport: 0,
  maxGeneration: 0,
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
  private minSupportRank = OVERLAY_DEFAULTS.minSupportRank;
  private widthMin = OVERLAY_DEFAULTS.widthMin;
  private widthMax = OVERLAY_DEFAULTS.widthMax;
  private shareWidthScale = OVERLAY_DEFAULTS.shareWidthScale;
  private alphaMin = OVERLAY_DEFAULTS.alphaMin;
  private alphaMax = OVERLAY_DEFAULTS.alphaMax;
  private alphaGamma = OVERLAY_DEFAULTS.alphaGamma;
  private generationWidthWeights = normalizeTrajectoryGenerationWidthWeights(OVERLAY_DEFAULTS.generationWidthWeights);
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

  setMinSupportRank(rank: number): void {
    this.minSupportRank = Math.min(1, Math.max(0, rank));
  }

  setWidthMin(w: number): void {
    this.widthMin = Math.max(0.1, w);
  }

  setWidthMax(w: number): void {
    this.widthMax = Math.max(0.1, w);
  }

  setShareWidthScale(scale: number): void {
    this.shareWidthScale = Math.max(0, scale);
  }

  setAlphaMin(alpha: number): void {
    this.alphaMin = Math.min(1, Math.max(0, alpha));
  }

  setAlphaMax(alpha: number): void {
    this.alphaMax = Math.min(1, Math.max(0, alpha));
  }

  setAlphaGamma(gamma: number): void {
    this.alphaGamma = Math.max(0.1, gamma);
  }

  setGenerationWidthWeights(weights: TrajectoryGenerationWidthWeights): void {
    this.generationWidthWeights = normalizeTrajectoryGenerationWidthWeights(weights);
  }

  getGenerationWidthWeights(): number[] {
    return [...this.generationWidthWeights];
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
    const maxVisibleGeneration = segments.reduce((max, s) => {
      return this.generationWidthWeight(s.generation) > 0 ? Math.max(max, s.generation) : max;
    }, 0);
    const edgeSupport = new Map<number, number>();
    const leafEdges = new Set<number>();
    for (const s of segments) {
      if (this.generationWidthWeight(s.generation) <= 0) continue;
      if (!edgeSupport.has(s.edgeId)) edgeSupport.set(s.edgeId, s.support);
      if (s.isLeaf || s.generation >= maxVisibleGeneration) leafEdges.add(s.edgeId);
    }
    if (edgeSupport.size === 0) {
      this.stats = { ...EMPTY_STATS };
      return;
    }
    const sorted = [...edgeSupport.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    const supportMax = Math.max(sorted[sorted.length - 1][1], Number.EPSILON);
    const rankByEdge = new Map<number, number>();
    const denom = Math.max(1, sorted.length - 1);
    for (let i = 0; i < sorted.length; i += 1) {
      rankByEdge.set(sorted[i][0], sorted.length <= 1 ? 1 : i / denom);
    }
    const widthLow = Math.min(this.widthMin, this.widthMax);
    const widthHigh = Math.max(this.widthMin, this.widthMax);
    const leafSupportTotal = Math.max(
      [...edgeSupport.entries()].reduce((sum, [edgeId, support]) => leafEdges.has(edgeId) ? sum + support : sum, 0),
      Number.EPSILON,
    );

    let culledEdges = 0;
    for (const [edgeId] of sorted) {
      if ((rankByEdge.get(edgeId) ?? 0) < this.minSupportRank) culledEdges++;
    }
    const drawnEdges = new Set<number>();
    let drawnSegments = 0;
    let maxGeneration = 0;
    const runs: DrawRun[] = [];

    for (const s of segments) {
      const generationWidthWeight = this.generationWidthWeight(s.generation);
      if (generationWidthWeight <= 0) continue;
      const supportRank = rankByEdge.get(s.edgeId) ?? 0;
      if (supportRank < this.minSupportRank) continue;
      const width = this.widthForSupport(s.support, widthLow, widthHigh, leafSupportTotal) * generationWidthWeight;
      const alpha = this.alphaForRank(supportRank);
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
      maxGeneration = Math.max(maxGeneration, s.generation);
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
      culledEdges,
      bestSupport: supportMax,
      medianSupport: sorted[sorted.length >> 1][1],
      worstSupport: sorted[0][1],
      maxGeneration,
    };
  }

  private generationWidthWeight(generation: number): number {
    return trajectoryGenerationWidthWeight(generation, this.generationWidthWeights);
  }

  private widthForSupport(
    support: number,
    widthLow: number,
    widthHigh: number,
    leafSupportTotal: number,
  ): number {
    const capped = (w: number) => Math.min(widthHigh, Math.max(widthLow, w));
    const share = Math.max(0, support / leafSupportTotal);
    return capped(widthLow + share * this.shareWidthScale);
  }

  private alphaForRank(rank: number): number {
    const low = Math.min(this.alphaMin, this.alphaMax);
    const high = Math.max(this.alphaMin, this.alphaMax);
    return low + (high - low) * Math.pow(Math.min(1, Math.max(0, rank)), this.alphaGamma);
  }
}
