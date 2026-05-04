// Alphabounce constants — direct port of `Cs.hx`. Values preserved verbatim.
// KKApi.const(N) and KKApi.aconst([...]) are pass-throughs in the stripped
// runtime (see Linea precedent); we inline the raw numbers.

export const STAGE_WIDTH = 300;
export const STAGE_HEIGHT = 320;

// SWF binary header (verified 2026-05-02): 40 FPS. The `@90D*` in project.hxml
// is a Haxe SWF target option string, not engine FPS — earlier reading was wrong.
export const FPS = 40;
export const STEP_SECONDS = 1 / FPS;

// Cs.hx grid metrics.
export const BW = 28; // block width (px per grid col)
export const BH = 12; // block height (px per grid row)

// Cs.hx canvas dimensions for grid-space (the playfield, not the window).
export const MCW = 300;
export const MCH = 300;

// Computed in Cs.init(): XMAX = (mcw-10)/BW = 10, YMAX = (mch-30)/BH = 22,
// SIDE = (mcw - XMAX*BW) * 0.5 = 10.
export const XMAX = haxeInt((MCW - 10) / BW); // 10
export const YMAX = haxeInt((MCH - 30) / BH); // 22
export const SIDE = (MCW - XMAX * BW) * 0.5; // 10

// 4-cardinal direction vectors (R, D, L, U) — for procedural map gen.
export const DIR: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

// Scoring (KKApi.const passthrough).
export const SCORE_BONUS = [250, 1000, 5000];
export const SCORE_BLOCK = 50;
export const SCORE_BOUNCE = 5;
export const SCORE_ICE = 120;
export const SCORE_0 = 0;

export const MAX_BALL = 32;
export const MAX_OPTION = 6;

// Ball type indices.
export const BALL_STANDARD = 0;
export const BALL_FIRE = 1;
export const BALL_ICE = 2;
export const BALL_DRUNK = 3;
export const BALL_KAMIKAZE = 4;
export const BALL_YOYO = 5;
export const BALL_HALO = 6;
export const BALL_SHADE = 7;

// Pad type indices.
export const PAD_STANDARD = 0;
export const PAD_GLUE = 1;
export const PAD_TIME = 2;
export const PAD_LASER = 3;
export const PAD_PROTECTION = 4;
export const PAD_AIMANT = 5;
export const PAD_SHAKE = 6;

// Gameplay constants.
export const TEMPO = 100; // frames between ball-speed accelerations
export const DOOR_COEF = 0.25; // 25% of blocks remaining ⇒ exit door opens
export const OPTION_COEF = 0.2; // probability factor for power-up drop on block death

// Plasma downsampling quality.
export const PQ = 0.3;

// Cs.SKIN palette — used by genPalette() to colour blocks.
export type Skin = { back: number; br: number; rr: number; bg: number; rg: number; bb: number; rb: number };
export const SKIN: Skin[] = [
  { back: 0x888888, br: 55, rr: 200, bg: 55, rg: 200, bb: 55, rb: 200 },
  { back: 0xaaaa22, br: 90, rr: 140, bg: 155, rg: 100, bb: 0, rb: 50 },
];

// Depth indices (Game.DP_*). Used as z-order tiers via layered Containers.
export const DP_BG = 0;
export const DP_PLASMA = 2;
export const DP_UNDERPARTS = 3;
export const DP_BLOCK = 4;
export const DP_PAD = 5;
export const DP_OPTION = 6;
export const DP_BALL = 7;
export const DP_PARTS = 8;
export const DP_INTER = 10;

// Pad geometry.
export const PAD_SIDE = 14;
export const PAD_SPEED = 10;
export const PAD_DY = 1;

// Cs.getX / Cs.getY.
export function haxeInt(n: number): number {
  return n < 0 ? Math.ceil(n) : Math.floor(n);
}
export function getX(px: number): number {
  return SIDE + px * BW;
}
export function getY(py: number): number {
  return py * BH;
}
export function getPX(x: number): number {
  return haxeInt((x - SIDE) / BW);
}
export function getPY(y: number): number {
  // Source bug: uses BW divisor on Y axis. Preserve verbatim — Cs.hx line 71.
  return haxeInt(y / BW);
}

export const ASSET_ROOT = '/assets/alphabounce';
