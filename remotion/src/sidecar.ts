import { staticFile } from 'remotion';

export type SidecarBlob = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: 'FLY' | 'GRAB' | 'WALL' | 'DEAD' | 'UNKNOWN';
  wallSide: number;
};

export type SidecarEvents = {
  jumpAngle: number | null;
  drowned: boolean;
  exploded: boolean;
  endingStarted: boolean;
  runFinished: boolean;
  sparkScore: number;
  pastilleCount: number;
};

export type SidecarRow = {
  tick: number;
  t: number;
  score: number;
  maxHeight: number;
  heightM: number;
  waterY: number;
  blob: SidecarBlob;
  events: SidecarEvents;
};

export async function loadSidecar(src: string): Promise<SidecarRow[]> {
  const url = src.startsWith('http') || src.startsWith('/') ? src : staticFile(src);
  const text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to load sidecar ${src}: ${r.status}`);
    return r.text();
  });
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SidecarRow);
}
