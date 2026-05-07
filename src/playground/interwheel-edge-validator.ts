import {
  angleTo,
  BLOB_JUMP,
  BLOB_RAY,
  BLOB_WEIGHT,
  hMod,
  InterwheelSim,
  JUMP_SIDE_ANGLE,
  MINE_SPACE,
  SIDE,
  START_WHEEL_ID,
  STAGE_WIDTH,
  type Wheel,
} from '../games/interwheel/sim';

type EdgeKind = 'direct' | 'wall';

export type EdgeValidatorConfig = {
  maxHeightMeters?: number | null;
  bandMeters?: number;
  launchSamples?: number;
  maxFlightTicks?: number;
  maxTargetDeltaY?: number;
  minGainMeters?: number;
  allowedDropMeters?: number;
  wallDriftStep?: number;
  maxWallDriftTicks?: number;
};

export type AnalyticalEdge = {
  from: number;
  to: number;
  kind: EdgeKind;
  launchAngle: number;
  flightTicks: number;
  landingAngle: number;
  heightMeters: number;
  wall?: {
    side: -1 | 1;
    y: number;
    driftTicks: number;
  };
};

export type AnalyticalEdgeValidatorResult = {
  seed: number;
  config: Required<Omit<EdgeValidatorConfig, 'maxHeightMeters'>> & { maxHeightMeters: number | null };
  generated: {
    wheels: number;
    topMeters: number;
    minedWheels: number;
    maxMinesOnWheel: number;
  };
  targetMeters: number;
  reachable: boolean;
  maxReachableMeters: number;
  firstFailedBand: { fromMeters: number; toMeters: number } | null;
  reachableWheels: number;
  edges: AnalyticalEdge[];
  farthestRoute: AnalyticalEdge[];
};

type Point = { x: number; y: number };
type FlightHit =
  | { kind: 'wheel'; wheelIdx: number; tick: number; x: number; y: number; landingAngle: number }
  | { kind: 'wall'; side: -1 | 1; tick: number; x: number; y: number };

const DEFAULT_CONFIG = {
  maxHeightMeters: 4_000,
  bandMeters: 250,
  launchSamples: 144,
  maxFlightTicks: 280,
  maxTargetDeltaY: 760,
  minGainMeters: 4,
  allowedDropMeters: 80,
  wallDriftStep: 2,
  maxWallDriftTicks: 34,
} satisfies Required<EdgeValidatorConfig>;

export function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function validateInterwheelAnalyticalEdges(seed: number, cfg: EdgeValidatorConfig = {}): AnalyticalEdgeValidatorResult {
  const config = resolveConfig(cfg);
  const sim = new InterwheelSim();
  sim.reset(makeSeededRng(seed));
  const wheels = sim.wheels;
  const topMeters = Math.floor(-sim.roof * 0.2);
  const targetMeters = Math.min(topMeters, config.maxHeightMeters ?? topMeters);
  const reachable = new Set<number>([START_WHEEL_ID]);
  const expanded = new Set<number>();
  const parentEdge = new Map<number, AnalyticalEdge>();
  const edges: AnalyticalEdge[] = [];

  let changed = true;
  while (changed) {
    changed = false;
    const sources = [...reachable]
      .filter((idx) => !expanded.has(idx))
      .sort((a, b) => wheelHeightMeters(wheels[b]) - wheelHeightMeters(wheels[a]));
    if (sources.length === 0) break;

    for (const sourceIdx of sources) {
      expanded.add(sourceIdx);
      const found = edgesFromWheel(wheels, sourceIdx, config);
      for (const edge of found) {
        edges.push(edge);
        if (!reachable.has(edge.to)) {
          reachable.add(edge.to);
          parentEdge.set(edge.to, edge);
          changed = true;
        }
      }
    }
  }

  const maxReachableMeters = [...reachable].reduce((max, idx) => Math.max(max, wheelHeightMeters(wheels[idx])), 0);
  const firstFailedBand = firstFailedBandFor(targetMeters, config.bandMeters, maxReachableMeters);
  const farthestIdx = [...reachable].sort((a, b) => wheelHeightMeters(wheels[b]) - wheelHeightMeters(wheels[a]))[0] ?? START_WHEEL_ID;
  return {
    seed,
    config,
    generated: {
      wheels: wheels.length,
      topMeters,
      minedWheels: wheels.filter((wheel) => wheel.mines.length > 0).length,
      maxMinesOnWheel: wheels.reduce((max, wheel) => Math.max(max, wheel.mines.length), 0),
    },
    targetMeters,
    reachable: maxReachableMeters >= targetMeters,
    maxReachableMeters,
    firstFailedBand,
    reachableWheels: reachable.size,
    edges,
    farthestRoute: routeFor(parentEdge, farthestIdx),
  };
}

function resolveConfig(cfg: EdgeValidatorConfig): Required<Omit<EdgeValidatorConfig, 'maxHeightMeters'>> & { maxHeightMeters: number | null } {
  return {
    maxHeightMeters: cfg.maxHeightMeters === undefined ? DEFAULT_CONFIG.maxHeightMeters : cfg.maxHeightMeters,
    bandMeters: positiveNumber(cfg.bandMeters, DEFAULT_CONFIG.bandMeters),
    launchSamples: positiveInteger(cfg.launchSamples, DEFAULT_CONFIG.launchSamples),
    maxFlightTicks: positiveInteger(cfg.maxFlightTicks, DEFAULT_CONFIG.maxFlightTicks),
    maxTargetDeltaY: positiveNumber(cfg.maxTargetDeltaY, DEFAULT_CONFIG.maxTargetDeltaY),
    minGainMeters: positiveNumber(cfg.minGainMeters, DEFAULT_CONFIG.minGainMeters),
    allowedDropMeters: positiveNumber(cfg.allowedDropMeters, DEFAULT_CONFIG.allowedDropMeters),
    wallDriftStep: positiveInteger(cfg.wallDriftStep, DEFAULT_CONFIG.wallDriftStep),
    maxWallDriftTicks: positiveInteger(cfg.maxWallDriftTicks, DEFAULT_CONFIG.maxWallDriftTicks),
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function edgesFromWheel(
  wheels: Wheel[],
  sourceIdx: number,
  config: Required<Omit<EdgeValidatorConfig, 'maxHeightMeters'>> & { maxHeightMeters: number | null },
): AnalyticalEdge[] {
  const source = wheels[sourceIdx];
  const out: AnalyticalEdge[] = [];
  const seenTargets = new Set<string>();
  const candidates = candidateWheels(wheels, sourceIdx, config);

  for (let sample = 0; sample < config.launchSamples; sample += 1) {
    const launchAngle = (sample / config.launchSamples) * Math.PI * 2;
    const hit = traceFlight(
      wheels,
      sourceIdx,
      candidates,
      launchPoint(source, launchAngle),
      Math.cos(launchAngle) * BLOB_JUMP,
      Math.sin(launchAngle) * BLOB_JUMP,
      config.maxFlightTicks,
    );
    if (!hit) continue;
    if (hit.kind === 'wheel') {
      const edge = edgeForWheelHit(wheels, sourceIdx, hit, launchAngle, 'direct', config);
      if (edge && !seenTargets.has(edgeKey(edge))) {
        seenTargets.add(edgeKey(edge));
        out.push(edge);
      }
      continue;
    }
    for (let driftTicks = 0; driftTicks <= config.maxWallDriftTicks; driftTicks += config.wallDriftStep) {
      const wallJump = traceWallJump(wheels, sourceIdx, candidates, hit, driftTicks, config.maxFlightTicks);
      if (!wallJump) continue;
      const edge = edgeForWheelHit(wheels, sourceIdx, wallJump, launchAngle, 'wall', config, {
        side: hit.side,
        y: Math.round(hit.y * 10) / 10,
        driftTicks,
      });
      if (edge && !seenTargets.has(edgeKey(edge))) {
        seenTargets.add(edgeKey(edge));
        out.push(edge);
      }
    }
  }

  return out;
}

function candidateWheels(
  wheels: Wheel[],
  sourceIdx: number,
  config: Required<Omit<EdgeValidatorConfig, 'maxHeightMeters'>> & { maxHeightMeters: number | null },
): number[] {
  const source = wheels[sourceIdx];
  const minGainPx = config.minGainMeters / 0.2;
  const allowedDropPx = config.allowedDropMeters / 0.2;
  return wheels
    .map((wheel, idx) => ({ wheel, idx }))
    .filter(({ wheel, idx }) => {
      if (idx === sourceIdx) return false;
      const upwardDelta = source.y - wheel.y;
      return upwardDelta >= -allowedDropPx && upwardDelta <= config.maxTargetDeltaY && (upwardDelta >= minGainPx || Math.abs(wheel.x - source.x) > 25);
    })
    .sort((a, b) => distance(source, a.wheel) - distance(source, b.wheel))
    .slice(0, 24)
    .map(({ idx }) => idx);
}

function launchPoint(wheel: Wheel, angle: number): Point {
  return {
    x: wheel.x + Math.cos(angle) * wheel.ray,
    y: wheel.y + Math.sin(angle) * wheel.ray,
  };
}

function traceFlight(
  wheels: Wheel[],
  sourceIdx: number,
  candidates: number[],
  start: Point,
  startVx: number,
  startVy: number,
  maxTicks: number,
): FlightHit | null {
  let x = start.x;
  let y = start.y;
  let vx = startVx;
  let vy = startVy;

  for (let tick = 1; tick <= maxTicks; tick += 1) {
    vy += BLOB_WEIGHT;
    vx *= 0.98;
    vy *= 0.98;
    x += vx;
    y += vy;

    if (x < SIDE || x > STAGE_WIDTH - SIDE) {
      return { kind: 'wall', side: x < SIDE ? -1 : 1, tick, x: x < SIDE ? SIDE : STAGE_WIDTH - SIDE, y };
    }

    for (const wheelIdx of candidates) {
      if (wheelIdx === sourceIdx && tick < 10) continue;
      const wheel = wheels[wheelIdx];
      if (distance({ x, y }, wheel) >= wheel.ray + BLOB_RAY) continue;
      return {
        kind: 'wheel',
        wheelIdx,
        tick,
        x,
        y,
        landingAngle: angleTo({ x, y }, wheel) + Math.PI,
      };
    }
  }

  return null;
}

function traceWallJump(
  wheels: Wheel[],
  sourceIdx: number,
  candidates: number[],
  wall: Extract<FlightHit, { kind: 'wall' }>,
  driftTicks: number,
  maxTicks: number,
): Extract<FlightHit, { kind: 'wheel' }> | null {
  let y = wall.y;
  let vy = 0;
  for (let i = 0; i < driftTicks; i += 1) {
    vy += 0.6;
    vy *= 0.92;
    y += vy;
  }

  const sens = -wall.side;
  const angle = -Math.PI * 0.5 + JUMP_SIDE_ANGLE * sens;
  const hit = traceFlight(
    wheels,
    sourceIdx,
    candidates,
    { x: wall.side < 0 ? SIDE : STAGE_WIDTH - SIDE, y },
    Math.cos(angle) * BLOB_JUMP,
    Math.sin(angle) * BLOB_JUMP,
    maxTicks,
  );
  return hit?.kind === 'wheel' ? hit : null;
}

function edgeForWheelHit(
  wheels: Wheel[],
  sourceIdx: number,
  hit: Extract<FlightHit, { kind: 'wheel' }>,
  launchAngle: number,
  kind: EdgeKind,
  config: Required<Omit<EdgeValidatorConfig, 'maxHeightMeters'>> & { maxHeightMeters: number | null },
  wall?: AnalyticalEdge['wall'],
): AnalyticalEdge | null {
  const source = wheels[sourceIdx];
  const target = wheels[hit.wheelIdx];
  if (wheelHeightMeters(target) < wheelHeightMeters(source) - config.allowedDropMeters) return null;
  if (!safeLanding(target, hit.landingAngle, hit.tick)) return null;
  return {
    from: sourceIdx,
    to: hit.wheelIdx,
    kind,
    launchAngle: round(launchAngle, 4),
    flightTicks: hit.tick,
    landingAngle: round(hit.landingAngle, 4),
    heightMeters: wheelHeightMeters(target),
    wall,
  };
}

function safeLanding(wheel: Wheel, landingAngle: number, _flightTicks: number): boolean {
  if (wheel.mines.length === 0) return true;
  const phaseSamples = 96;
  for (let sample = 0; sample < phaseSamples; sample += 1) {
    const phase = (sample / phaseSamples) * Math.PI * 2;
    const safe = wheel.mines.every((mineAngle) => {
      const da = hMod(mineAngle + phase - landingAngle, Math.PI);
      return Math.abs(da) * wheel.ray >= MINE_SPACE;
    });
    if (safe) return true;
  }
  return false;
}

function firstFailedBandFor(targetMeters: number, bandMeters: number, maxReachableMeters: number): { fromMeters: number; toMeters: number } | null {
  for (let fromMeters = 0; fromMeters < targetMeters; fromMeters += bandMeters) {
    const toMeters = Math.min(targetMeters, fromMeters + bandMeters);
    if (maxReachableMeters < toMeters) return { fromMeters, toMeters };
  }
  return null;
}

function routeFor(parentEdge: Map<number, AnalyticalEdge>, targetIdx: number): AnalyticalEdge[] {
  const out: AnalyticalEdge[] = [];
  let current = targetIdx;
  while (parentEdge.has(current)) {
    const edge = parentEdge.get(current);
    if (!edge) break;
    out.push(edge);
    current = edge.from;
  }
  out.reverse();
  return out;
}

function edgeKey(edge: AnalyticalEdge): string {
  return `${edge.kind}:${edge.to}`;
}

function wheelHeightMeters(wheel: Wheel): number {
  return Math.floor(Math.max(0, -wheel.y) * 0.2);
}

function distance(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
