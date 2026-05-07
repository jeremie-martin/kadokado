import { Container, Graphics } from 'pixi.js';
import type { Segment } from './interwheel-planner';

export type OverlayMode = 'on' | 'off';

const SEGMENT_COLOR = 0x9be8ff;
const SEGMENT_WIDTH = 1;

// Curve applied to each edge's rank-of-support. The planner's lineage pass
// produces support that grows exponentially with depth on the principal
// prefix (recurrence factor branching×decay > 1), so support *magnitude* is
// dominated by a single outlier and not useful for direct normalization.
// Rank-mapping discards magnitude but preserves the *ordering* lineage
// support imposed: a good prefix earns top rank because of its descendants.
// γ=3 matches the previous rank-of-value calibration; raise to thin the
// long tail, lower to brighten it.
const ALPHA_GAMMA = 3;

// Below this alpha, skip drawing entirely. Avoids a "carpet" of near-invisible
// lines accumulating into visible noise. Lower → more long-tail visibility.
const MIN_DRAW_ALPHA = 0.05;

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

    let hi = 0;
    let mid = 0;
    let lo = 0;
    const drawnEdges = new Set<number>();
    let drawnSegments = 0;

    for (const s of segments) {
      const alpha = s.onChosenChain ? 1 : Math.pow(rankByEdge.get(s.edgeId) ?? 0, ALPHA_GAMMA);
      if (alpha >= 0.5) hi++;
      else if (alpha >= 0.15) mid++;
      else lo++;
      if (alpha < MIN_DRAW_ALPHA) continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: SEGMENT_COLOR, width: SEGMENT_WIDTH, alpha });
      drawnEdges.add(s.edgeId);
      drawnSegments++;
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
