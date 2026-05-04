// Slim interface used by ball/pad/block/event/shot/option/fx modules so they
// can reach into the game without circularly importing the Game class.
// Mirrors the kslash/game-context.ts pattern.

import type { Container, Sprite } from 'pixi.js';
import type { Frame } from '../_shared/frames';

import type { Ball } from './ball';
import type { Pad } from './pad';
import type { Block } from './block';
import type { Option } from './option';
import type { Event } from './events';
import type { Shot } from './shots';

export type AlphabounceAssets = {
  // Single-frame sprites.
  brush: Frame;
  greenBar: Frame;
  iceStone: Frame;
  javelot: Frame;
  laser: Frame;
  ondeRay: Frame;
  option: Frame;
  pad: Frame; // flattened whole-pad fallback / provenance frame.
  padSide: Frame[]; // DefineSprite_119: side0/side1 type frames.
  padMid: Frame[]; // DefineSprite_127: mid type frames.
  padMidPowerBase: Frame; // DefineShape_122 reconstructed without the nested smc bar.
  padPower: Frame; // DefineSprite_124: scalable coloured power bar.
  partBubble: Frame;
  partGlue: Frame;
  partIceShard: Frame;
  partLight: Frame;
  partLine: Frame;
  partLineUp: Frame;
  part: Frame;
  pinkBar: Frame;
  quasar: Frame;
  score: Frame;
  scroll: Frame;
  scrollBg: Frame;
  title: Frame;
  titleLevel: Frame;
  wave: Frame;
  // Multi-frame folders.
  ball: Frame[]; // 8: types 0-7
  bg: Frame[]; // 6: per-level backgrounds (cycled with mod)
  blink: Frame[]; // 9
  block: Frame[]; // 6: root mcBlock frames.
  blockLife: Frame[]; // DefineSprite_164: nested normal-block life frames.
  ice: Frame[]; // 2
  onde: Frame[]; // 11
  partExplode: Frame[]; // 23 visible frames; source timeline stops before exported reset tail.
  partGlass: Frame[]; // 2
  partSpark: Frame[]; // 2
  partTwinkle: Frame[]; // 6
  protection: Frame[]; // 14
  shape: Frame[]; // 8
  side: Frame[]; // 10
};

// Generic per-particle physics record (mt.bumdum.Phys equivalent).
// Many fx classes wrap this with extra behaviour (Part/Spark/LineUp/Attract).
//
// `movie` is a port-specific kind that drives a Pixi Sprite through a list of
// extracted SWF MovieClip frames at engine rate (1 frame per `tmod` tick at
// 40 Hz). Used to approximate self-playing clips like `mcBlink` (9 frames),
// `mcOnde` (11 frames), and `partExplode` (visible run). The clip plays once
// and the particle is killed when the timeline ends — no alpha fade, matching
// SWF MovieClip's "play to last frame and remove" semantics.
export type FxKind =
  | 'phys'
  | 'spark'
  | 'lineUp'
  | 'attract'
  | 'part'
  | 'twinkle'
  | 'score'
  | 'movie';

export type FxParticle = {
  kind: FxKind;
  view: Container;
  x: number;
  y: number;
  vx: number;
  vy: number;
  vr: number;
  weight: number;
  frict: number; // 1 ⇒ no air friction
  timer: number;
  life: number;
  sleep: number;
  fadeType: number; // 0 = scale-fade, otherwise alpha-fade
  fadeLimit: number; // extra falloff parameter
  scale: number; // current 0..N scale applied to view (percent units; 100 = 1.0)
  // Type-specific extras.
  factor: number; // LineUp scale factor
  dx: number; // Attract destination offset relative to pad
  bounce: { px: number; py: number; ox: number; oy: number } | null; // Part bouncer
  rotateToVel: boolean; // Spark
  plasma: boolean; // draw to plasma each tick
  // Movie-clip stepper: when present, advances through `frames` at engine rate.
  // `frameSprite` is the Sprite child that gets its texture swapped each step.
  // `frameAcc` accumulates fractional frame progress from tmod each tick.
  // `frameSize` (optional) re-applies width/height after each swap so the
  // sprite stays sized to the original block/onde/etc. dimensions instead of
  // jumping to each frame's native pixel size.
  // `frameScale` mirrors Flash callers that copy `_xscale/_yscale` from
  // another clip instead of forcing an absolute rectangle.
  frames: Frame[] | null;
  frameSprite: Sprite | null;
  frameAcc: number;
  frameSize: { w: number; h: number } | null;
  frameScale: { x: number; y: number } | null;
  // For score popups: text node lives inside `view` — we just fade & move.
  // Cleanup callback (e.g., remove from layer once dead).
  onKill?: () => void;
};

// What entities need from the Game.
export type GameContext = {
  app: import('pixi.js').Application;
  assets: AlphabounceAssets;

  // World state.
  grid: Array<Array<Block | null>>;
  blocks: Block[];
  balls: Ball[];
  options: Option[];
  events: Event[];
  shots: Shot[];
  particles: FxParticle[];
  pad: Pad;

  lvl: number;
  block: number; // remaining block count
  blockTotal: number;
  levelTimer: number;
  autoLaunchTimer: number;
  flSafe: boolean;
  flDoor: boolean;
  flPress: boolean;
  flClick: boolean;

  // Timing.
  tmod: number; // current time-modifier (1.0 default; <1 during pad.flStop)

  // Layers.
  bgLayer: Container;
  plasmaLayer: Container;
  underPartsLayer: Container;
  blockLayer: Container;
  blockOverlayLayer: Container;
  padLayer: Container;
  optionLayer: Container;
  ballLayer: Container;
  partsLayer: Container;
  interLayer: Container;

  // Helpers.
  isFree(px: number, py: number): boolean;
  hit(px: number, py: number, ball: Ball): void;
  newBall(): Ball;
  newOption(t: number | null, x?: number, y?: number): void;
  getOption(id: number): void;
  removeBlock(): void;
  initGameOver(): void;
  leaveLevel(): void;
  newTitle(str: string, col: number, blink?: boolean): void;
  displayScore(x: number, y: number, score: number, color?: number, size?: number): void;
  plasmaDraw(view: Container): void;
  addScore(value: number): void;
  newPart(opts: Partial<FxParticle> & Pick<FxParticle, 'kind' | 'view'>): FxParticle;
  killPart(p: FxParticle): void;
  bmpPaintGetPixel(x: number, y: number): number;
  getLowestBall(): Ball | null;
  spriteCount(): number;
  // Pad helper: spawn a single laser shot at world (x, y).
  spawnLaser(x: number, y: number): void;
};
