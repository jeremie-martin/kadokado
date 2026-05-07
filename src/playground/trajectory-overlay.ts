import { Container, Graphics } from 'pixi.js';
import type { Segment } from './interwheel-planner';

export type OverlayMode = 'on' | 'off';

const SEGMENT_COLOR = 0x9be8ff;

// Visual defaults. The instance fields below mirror these and can be
// overridden at runtime via the playground sliders.
//
// alphaGamma: curve applied to each edge's rank-of-support. The planner's
//   lineage pass produces support that grows roughly exponentially with depth
//   on the principal prefix (recurrence factor branching × decay > 1), so
//   support magnitude is dominated by a single outlier and not useful for
//   direct normalization. Rank-mapping discards magnitude but preserves the
//   ordering lineage support imposed: a good prefix earns top rank because
//   of its descendants. γ=3 matches the previous rank-of-value calibration.
//
// minDrawAlpha: below this alpha, skip drawing entirely. Avoids a "carpet"
//   of near-invisible lines accumulating into visible noise.
//
// segmentWidth: stroke width in world pixels.
export const OVERLAY_DEFAULTS: { alphaGamma: number; minDrawAlpha: number; segmentWidth: number } = {
  alphaGamma: 4,
  minDrawAlpha: 0.05,
  segmentWidth: 1,
};

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
  private alphaGamma = OVERLAY_DEFAULTS.alphaGamma;
  private minDrawAlpha = OVERLAY_DEFAULTS.minDrawAlpha;
  private segmentWidth = OVERLAY_DEFAULTS.segmentWidth;

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

  setAlphaGamma(g: number): void {
    this.alphaGamma = Math.max(0.1, g);
  }

  setMinDrawAlpha(a: number): void {
    this.minDrawAlpha = Math.max(0, Math.min(1, a));
  }

  setSegmentWidth(w: number): void {
    this.segmentWidth = Math.max(0.1, w);
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
      const alpha = s.onChosenChain ? 1 : Math.pow(rankByEdge.get(s.edgeId) ?? 0, this.alphaGamma);
      if (alpha >= 0.5) hi++;
      else if (alpha >= 0.15) mid++;
      else lo++;
      if (alpha < this.minDrawAlpha) continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: SEGMENT_COLOR, width: this.segmentWidth, alpha });
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
