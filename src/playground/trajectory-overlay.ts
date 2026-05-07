import { Container, Graphics } from 'pixi.js';
import type { Segment, SegmentKind } from './interwheel-planner';

export type OverlayMode = 'cinematic' | 'debug' | 'off';

const FULL_WAIT_PREFIX_TICKS = 24;
const WAIT_TAIL_TICKS = 16;
const LAUNCH_BUCKET_TICKS = 6;
const CLOSE_LAUNCH_TICKS = 8;
const CLOSE_ENDPOINT_TICKS = 24;
const CLOSE_LAUNCH_DISTANCE = 42;
const CLOSE_ENDPOINT_DISTANCE = 70;

type EdgeGroup = {
  edgeId: number;
  kind: SegmentKind;
  segments: Segment[];
  value: number;
  scoreGain: number;
  launchLocalTick: number;
  launchDepth: number;
  launchX: number;
  launchY: number;
  endX: number;
  endY: number;
};

export class TrajectoryOverlay {
  private readonly graphics = new Graphics();
  private mode: OverlayMode = 'cinematic';
  private drawnSegments = 0;
  private drawnEdges = 0;

  constructor(parent: Container) {
    parent.addChild(this.graphics);
  }

  setMode(mode: OverlayMode): void {
    this.mode = mode;
    this.graphics.visible = mode !== 'off';
    if (mode === 'off') {
      this.graphics.clear();
      this.drawnSegments = 0;
      this.drawnEdges = 0;
    }
  }

  getMode(): OverlayMode {
    return this.mode;
  }

  setVisible(v: boolean): void {
    this.setMode(v ? 'cinematic' : 'off');
  }

  toggle(): OverlayMode {
    const next: OverlayMode =
      this.mode === 'cinematic' ? 'debug' :
        this.mode === 'debug' ? 'off' :
          'cinematic';
    this.setMode(next);
    return next;
  }

  isVisible(): boolean {
    return this.mode !== 'off';
  }

  lastDrawnStats(): { edges: number; segments: number } {
    return { edges: this.drawnEdges, segments: this.drawnSegments };
  }

  draw(segments: Segment[]): void {
    const g = this.graphics;
    g.clear();
    if (this.mode === 'off' || segments.length === 0) {
      this.drawnSegments = 0;
      this.drawnEdges = 0;
      return;
    }

    const visibleSegments = this.mode === 'debug' ? segments : this.cinematicSegments(segments);
    this.drawnSegments = visibleSegments.length;
    this.drawnEdges = this.countEdges(visibleSegments);

    // Cinematic mode keeps all launched alternatives, but trims long non-best
    // wheel waits to the visible decision moment.
    for (const s of visibleSegments) {
      if (s.kind !== 'branch') continue;
      const hasScore = this.mode === 'debug' && (s.scoreGain ?? 0) > 0;
      const alpha = Math.max(hasScore ? 0.35 : 0.18, (hasScore ? 0.85 : 0.75) - s.depth * 0.006);
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: hasScore ? 0x7dffbf : 0x9be8ff, width: hasScore ? 1.55 : 1.15, alpha });
    }
    for (const s of visibleSegments) {
      if (s.kind !== 'dead') continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: 0xff6e5c, width: 1.15, alpha: 0.6 });
    }
    for (const s of visibleSegments) {
      if (s.kind !== 'best') continue;
      g.moveTo(s.x0, s.y0);
      g.lineTo(s.x1, s.y1);
      g.stroke({ color: 0xfff1a8, width: 2.4, alpha: 1.0 });
    }
  }

  private countEdges(segments: Segment[]): number {
    const edgeIds = new Set<number>();
    for (const segment of segments) edgeIds.add(segment.edgeId);
    return edgeIds.size;
  }

  private cinematicSegments(segments: Segment[]): Segment[] {
    const groups = this.groupSegments(segments);
    const bestGroups = groups.filter((group) => group.kind === 'best');
    const selected = new Set<number>();
    const selectedGroups: EdgeGroup[] = [];
    const add = (group: EdgeGroup): void => {
      if (selected.has(group.edgeId)) return;
      selected.add(group.edgeId);
      selectedGroups.push(group);
    };

    for (const group of groups) {
      if (
        group.kind === 'best' ||
        group.kind === 'dead' ||
        group.scoreGain > 0 ||
        this.isCloseToBest(group, bestGroups)
      ) {
        add(group);
      }
    }

    const bucketBest = new Map<number, EdgeGroup>();
    for (const group of groups) {
      if (selected.has(group.edgeId) || group.kind !== 'branch') continue;
      const bucket = Math.floor(group.launchDepth / LAUNCH_BUCKET_TICKS);
      const current = bucketBest.get(bucket);
      if (!current || group.value > current.value) bucketBest.set(bucket, group);
    }
    for (const group of [...bucketBest.values()].sort((a, b) => a.launchDepth - b.launchDepth)) {
      add(group);
    }

    return selectedGroups.flatMap((group) => this.visibleGroupSegments(group));
  }

  private groupSegments(segments: Segment[]): EdgeGroup[] {
    const groups = new Map<number, EdgeGroup>();
    for (const segment of segments) {
      let group = groups.get(segment.edgeId);
      if (!group) {
        group = {
          edgeId: segment.edgeId,
          kind: segment.kind,
          segments: [],
          value: segment.value ?? 0,
          scoreGain: segment.scoreGain ?? 0,
          launchLocalTick: Number.POSITIVE_INFINITY,
          launchDepth: Number.POSITIVE_INFINITY,
          launchX: segment.x1,
          launchY: segment.y1,
          endX: segment.x1,
          endY: segment.y1,
        };
        groups.set(segment.edgeId, group);
      }

      group.kind = this.mergeKind(group.kind, segment.kind);
      group.segments.push(segment);
      group.value = Math.max(group.value, segment.value ?? group.value);
      group.scoreGain = Math.max(group.scoreGain, segment.scoreGain ?? 0);
      group.endX = segment.x1;
      group.endY = segment.y1;

      if (segment.phase !== 'wait' && segment.depth < group.launchDepth) {
        group.launchLocalTick = segment.localTick;
        group.launchDepth = segment.depth;
        group.launchX = segment.x1;
        group.launchY = segment.y1;
      }
    }

    for (const group of groups.values()) {
      if (Number.isFinite(group.launchDepth)) continue;
      const first = group.segments[0];
      group.launchLocalTick = first.localTick;
      group.launchDepth = first.depth;
      group.launchX = first.x1;
      group.launchY = first.y1;
    }
    return [...groups.values()];
  }

  private visibleGroupSegments(group: EdgeGroup): Segment[] {
    if (group.kind === 'best') return group.segments;
    return group.segments.filter((segment) => {
      if (segment.phase !== 'wait') return true;
      return group.launchLocalTick <= FULL_WAIT_PREFIX_TICKS || segment.localTick >= group.launchLocalTick - WAIT_TAIL_TICKS;
    });
  }

  private isCloseToBest(group: EdgeGroup, bestGroups: EdgeGroup[]): boolean {
    if (group.kind !== 'branch') return false;
    for (const best of bestGroups) {
      const launchDt = Math.abs(group.launchDepth - best.launchDepth);
      if (
        launchDt <= CLOSE_LAUNCH_TICKS &&
        this.distanceSq(group.launchX, group.launchY, best.launchX, best.launchY) <= CLOSE_LAUNCH_DISTANCE * CLOSE_LAUNCH_DISTANCE
      ) {
        return true;
      }
      if (
        launchDt <= CLOSE_ENDPOINT_TICKS &&
        this.distanceSq(group.endX, group.endY, best.endX, best.endY) <= CLOSE_ENDPOINT_DISTANCE * CLOSE_ENDPOINT_DISTANCE
      ) {
        return true;
      }
    }
    return false;
  }

  private mergeKind(a: SegmentKind, b: SegmentKind): SegmentKind {
    if (a === 'best' || b === 'best') return 'best';
    if (a === 'dead' || b === 'dead') return 'dead';
    return 'branch';
  }

  private distanceSq(x0: number, y0: number, x1: number, y1: number): number {
    const dx = x0 - x1;
    const dy = y0 - y1;
    return dx * dx + dy * dy;
  }
}
