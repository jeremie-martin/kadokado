// Slim interface bag passed to entities so they can mutate game state without
// pulling in the full Game class (which would create a circular import).

import type { Container } from 'pixi.js';
import type { Frame } from '../_shared/frames';

import type { Hero } from './hero';
import type { Monster } from './enemies';
import type { Bonus } from './bonus';
import type { Shoot } from './projectiles';

export type GridCell = { block: boolean; list: Monster[] };

export type Particle = {
  view: import('pixi.js').Sprite | import('pixi.js').Container;
  vx: number;
  vy: number;
  vs: number | null;
  vr: number | null;
  weight: number | null;
  frict: number | null;
  t: number | null;
  ft: number;
  scale: number;
  flQueue: boolean;
  wt: number;
  visible: boolean;
  // For mcScore particles: source has an embedded TextField "field" displaying
  // the localized score number. The Bonus.addScore site writes to it via
  // `downcast(p).field.text = string(KKApi.val(n))`. Optional on all other
  // particle kinds; only newPart('mcScore') populates it.
  field?: import('pixi.js').Text;
};

export type ParallaxLayer = { mc: Container; c: number };

export type Stats = {
  $opt: number[];
  $bads: number[];
  $dif: number;
};

export type KSlashAssets = {
  bg: Frame[]; // 2 frames
  bgBack: Frame; // single
  bgFront: Frame[];
  mapBg: Frame;
  inter: Frame;
  score: Frame;
  partCircle: Frame;
  kunai: Frame;
  hero: Frame[];
  monster: Frame[];
  tanker: Frame[];
  flyer: Frame[];
  bonus: Frame[];
  shade: Frame[];
  fall: Frame[];
  ninjaShot: Frame[];
  icon: Frame[];
  plat: Frame[];
  // R23: 3-piece plat composition extracted from gfx.swf DefineSprite 402.
  // platBody[0]=day (DefineSprite 390, 1019×20px), [1]=night (397).
  // platCorner[0]=day (DefineSprite 394, 24×21px), [1]=night (401).
  // The runtime tiles body across (w*SIZE)-2*c and places a mirrored corner
  // at x=c plus a non-mirrored corner at x=(w*SIZE)-c, matching `Game.setPlat`.
  platBody: Frame[];
  platCorner: Frame[];
  partDust: Frame[];
  partLight: Frame[];
  partSpark: Frame[];
  partSmoke: Frame[];
  // R20: bfx slash flash, 3 frames from DefineSprite 29 (gfx.swf). Source
  // plays via `bfx.gotoAndPlay("2")` from `Hero.mt:slash`.
  bfx: Frame[];
};

// What entities need from the Game.
export type GameContext = {
  // World state.
  grid: GridCell[][];
  mList: Monster[];
  sList: Shoot[]; // enemy projectiles (Kunai)
  nsList: Shoot[]; // hero projectiles (Star)
  bList: Bonus[];
  optList: boolean[];
  pList: Particle[];
  hero: Hero;
  flNight: boolean;
  dif: number;
  monsterLevel: number;
  monsterLevelMax: number;
  stats: Stats;
  // Layers.
  monsterLayer: Container;
  shootLayer: Container;
  bonusLayer: Container;
  partsLayer: Container;
  shadeLayer: Container;
  // Asset bag for spawn helpers.
  assets: KSlashAssets;
  // Helpers (implemented on Game).
  checkFree(x: number, y: number): boolean;
  getClosestMonsters(): Array<{ m: Monster; d: number }>;
  spawnBonus(px: number, py: number, id: number): void;
  newPart(link: ParticleLink): Particle;
  updateIcons(): void;
  newMonster(id: number): Monster | null;
  setStarText(value: number): void;
  addScore(value: number): void;
  scheduleCorpseRemoval(view: Container, frames: number, tick?: () => void): void;
  showGameOver(): void;
};

export type ParticleLink =
  | 'partDust'
  | 'partSmoke'
  | 'partLight'
  | 'partSpark'
  | 'partCircle'
  | 'mcScore'
  | 'mcNinjaShot'
  | 'partQueue';
