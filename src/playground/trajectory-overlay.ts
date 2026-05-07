import { Container, Graphics } from 'pixi.js';
import type { Segment } from './interwheel-planner';

export type OverlayMode = 'on' | 'off';

const SEGMENT_COLOR = 0x9be8ff;
const SEGMENT_WIDTH = 1;

// 'value' = alpha derived from value gap to best (sensitive to score landscape
// shape — many near-tied edges all look similarly bright). 'rank' = alpha
// derived from each edge's rank position among all edges (forces a spread
// regardless of value distribution; better when scores cluster).
type AlphaMode = 'value' | 'rank';
const ALPHA_MODE: AlphaMode = 'rank';

// Gamma applied to the alpha basis before drawing. Higher = sharper falloff,
// fewer bright lines.
//   value-mode: alpha = exp(-(gap/scale)^γ); 2 quadratic, 3 cubic, 4 quartic.
//   rank-mode:  alpha = rank^γ where rank ∈ [0,1]; 3 cubes, 4 quartics.
const ALPHA_GAMMA = 3;

// Value-mode only. Pivot percentile for the scale denominator. 0.5 = median-gap
// (median edge ≈ alpha 0.37). Lower (e.g. 0.25) tightens scale further.
const SCALE_PIVOT = 0.5;

// Below this alpha, skip drawing entirely. Avoids a "carpet" of near-invisible
// lines accumulating into visible noise. Lower → more long-tail visibility.
const MIN_DRAW_ALPHA = 0.05;

const SCALE_EPS = 1;

export type OverlayStats = {
  segments: number;
  edges: number;
  bestValue: number;
  pivotValue: number;
  medianValue: number;
  worstValue: number;
  alphaBuckets: { hi: number; mid: number; lo: number };
};

const EMPTY_STATS: OverlayStats = {
  segments: 0,
  edges: 0,
  bestValue: 0,
  pivotValue: 0,
  medianValue: 0,
  worstValue: 0,
  alphaBuckets: { hi: 0, mid: 0, lo: 0 },
};

export class TrajectoryOverlay {
  private readonly graphics = new Graphics();
  private mode: OverlayMode = 'on';
  private stats: OverlayStats = { ...EMPTY_STATS };

  constructor(parent: Container) {
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
    // shouldn't bias the value distribution.
    const edgeValues = new Map<number, number>();
    for (const s of segments) {
      if (!edgeValues.has(s.edgeId)) edgeValues.set(s.edgeId, s.value);
    }
    const sortedValues = [...edgeValues.values()].sort((a, b) => a - b);
    const bestValue = sortedValues[sortedValues.length - 1];
    const pivotIdx = Math.max(0, Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * SCALE_PIVOT)));
    const pivotValue = sortedValues[pivotIdx];
    const scale = Math.max(bestValue - pivotValue, SCALE_EPS);

    const alphaForEdge = this.buildEdgeAlpha(edgeValues, bestValue, scale);

    let hi = 0;
    let mid = 0;
    let lo = 0;
    const seenEdges = new Set<number>();
    let drawnSegments = 0;

    for (const s of segments) {
      const alpha = s.onChosenChain ? 1 : alphaForEdge(s.edgeId);
      seenEdges.add(s.edgeId);
      if (alpha >= 0.5) hi++;
      else if (alpha >= 0.15) mid++;
      else lo++;
      if (alpha < MIN_DRAW_ALPHA) continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: SEGMENT_COLOR, width: SEGMENT_WIDTH, alpha });
      drawnSegments++;
    }

    this.stats = {
      segments: drawnSegments,
      edges: seenEdges.size,
      bestValue,
      pivotValue,
      medianValue: sortedValues[sortedValues.length >> 1],
      worstValue: sortedValues[0],
      alphaBuckets: { hi, mid, lo },
    };
  }

  private buildEdgeAlpha(
    edgeValues: Map<number, number>,
    bestValue: number,
    scale: number,
  ): (edgeId: number) => number {
    if (ALPHA_MODE === 'rank') {
      const ranked = [...edgeValues.entries()].sort((a, b) => a[1] - b[1]);
      const N = ranked.length;
      const rankByEdge = new Map<number, number>();
      for (let i = 0; i < N; i += 1) {
        rankByEdge.set(ranked[i][0], N <= 1 ? 1 : i / (N - 1));
      }
      return (id) => Math.pow(rankByEdge.get(id) ?? 0, ALPHA_GAMMA);
    }
    // Value-mode is currently unselected; kept as a comparison baseline so we
    // can A/B against rank-mode without git-archaeology if the score landscape
    // changes shape. If it stays unused after a few iterations, drop it along
    // with SCALE_PIVOT, SCALE_EPS, and the AlphaMode union.
    return (id) => {
      const v = edgeValues.get(id) ?? bestValue;
      const norm = (bestValue - v) / scale;
      return Math.exp(-Math.pow(norm, ALPHA_GAMMA));
    };
  }
}
