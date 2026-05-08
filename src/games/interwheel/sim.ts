// Gameplay-pure simulator for Interwheel. No Pixi or DOM dependency — every
// function in this file is pure JS. The visual InterwheelGame in index.ts
// owns an InterwheelSim instance, advances it once per real tick via
// `sim.step(press, Math.random)`, and synchronises Pixi views to the
// simulator's logical state. The headless AI tooling uses the same `sim.step` directly,
// passing its own RNG; this guarantees analytics runs follow the production
// gameplay code path bit-for-bit.

// ============================================================================
// Constants
// ============================================================================

// Layout / world
export const STAGE_WIDTH = 300;
export const STAGE_HEIGHT = 300;
export const FPS = 40;
export const STEP_SECONDS = 1 / FPS;
export const SIDE = 10;
export const SPACE = 8;
export const VIEW_WHEEL = 50;
export const START_WHEEL_ID = 10;
export const WMAX = 1200;

// Wheel generation
export const WHEEL_SPEED_MIN = 0.05;
export const WHEEL_SPEED_MAX = 0.25;
export const WHEEL_SPEED_RANDOM = 0.05;
export const WHEEL_DIST_MIN = 60;
export const WHEEL_DIST_MAX = 120;
export const WHEEL_RAY_MIN = 8;
export const WHEEL_RAY_MAX = 32;
export const WHEEL_RAY_RANDOM = 50;
export const DIF_RANDOMIZER = 0.1;
export const DIFFICULTY_FULL_HEIGHT_METERS = 20_000;
export const WHEEL_DIST_HARD_FACTOR = 0.75;
export const WHEEL_RAY_RANDOM_HARD_FACTOR = 0.9;
export const WHEEL_SPEED_RANDOM_HARD_FACTOR = 0.35;
export const INTER_WHEEL_CHANCE_EASY = 0.7;
export const INTER_WHEEL_CHANCE_HARD = 0.25;

// Water / scoring
export const WATER_SPEED = 1;
export const WATER_SPEED_INC = 0.0003;
export const SCORE_PASTILLE = [250, 1000, 5000];
export const PASTILLE_RATE_FULL_HEIGHT_METERS = 1_600;

// Blob physics
export const BLOB_RAY = 8;
export const BLOB_WEIGHT = 0.5;
export const BLOB_JUMP = 12;
export const JUMP_SIDE_ANGLE = 0.77;
export const BLOB_BLOP_START = 0.6;
export const BLOB_BLOP_MIN = 0.07;
export const BLOB_BLOP_FRICT = 0.94;
export const MINE_SPACE = 36;
export const MINE_SAFE_SPACE_FACTOR = 2.2;
export const MINE_MAX_PLACEMENT_ATTEMPTS = 12;
export const ENDGAME_DELAY = 30;

// Blob state values (numeric — avoid TS const-enum so external code can use
// them without type magic).
export const BLOB_STATE_FLY = 1;
export const BLOB_STATE_GRAB = 2;
export const BLOB_STATE_WALL = 3;
export const BLOB_STATE_DEAD = 4;

// ============================================================================
// Math helpers
// ============================================================================

export type RNG = () => number;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function hMod(value: number, mod: number): number {
  let v = value;
  while (v > mod) v -= mod * 2;
  while (v < -mod) v += mod * 2;
  return v;
}

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function angleTo(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

function randomInt(rng: RNG, max: number): number {
  if (max <= 1) return 0;
  return Math.floor(rng() * max);
}

export function heightMetersFromY(y: number): number {
  return Math.max(0, Math.floor(-y * 0.2));
}

export function generationDifficultyAtHeight(heightMeters: number): number {
  const t = clamp(heightMeters / DIFFICULTY_FULL_HEIGHT_METERS, 0, 1);
  return t * t * (3 - 2 * t);
}

export function pastilleSpawnChanceAtY(y: number): number {
  return clamp(heightMetersFromY(y) / PASTILLE_RATE_FULL_HEIGHT_METERS, 0, 1);
}

// ============================================================================
// Logical entity types (no Pixi)
// ============================================================================

export type Blob = {
  x: number; y: number; vx: number; vy: number;
  state: number;
  wallSide: -1 | 0 | 1;
  stateTick: number;
  cw: Wheel | null;
  wa: number; angle: number; wet: number;
  wasInWater: boolean; blop: number;
  ox: number; oy: number; vvx: number; vvy: number;
  deathTick: number;
};

export type Wheel = {
  x: number; y: number; ray: number; speed: number; a: number; fr: number;
  mines: number[];
  destroyed: boolean; boomAngle: number | null;
  active: boolean; dustTick: number;
};

export type Pastille = {
  x: number; y: number; ray: number; type: number; phase: number; active: boolean;
};

export type Spark = {
  x: number; y: number; vx: number; vy: number;
  type: number; score: number;
  distLimit: number; coefLimit: number; coef: number;
};

// ============================================================================
// Per-tick events
// ============================================================================

// Sim emits these so the renderer can spawn particles/animations matching
// the gameplay state changes that happened during a step. Cleared at the
// start of every step().
export type SimEvents = {
  /** Angle (radians) the blob just jumped at, if a jump fired this tick. */
  blobJumpAngle: number | null;
  /** Mine explosions that fired this tick. */
  mineExplosions: Array<{
    wheelIdx: number;
    mineIdx: number;
    mineAngle: number;
    x: number; y: number;
    ba: number;
  }>;
  /** Blob died this tick from a mine; the bounce angle for splatter. */
  blobExploded: { ba: number; x: number; y: number } | null;
  /** Blob started drowning this tick. */
  blobDrowned: boolean;
  /** ending=true was set this tick. */
  endingStarted: boolean;
  /** ended=true was set this tick. */
  runFinished: boolean;
  /** Pastilles collected this tick — pre-removal (x,y,type) for renderer. */
  collectedPastilles: Array<{ x: number; y: number; type: number }>;
  /** Sparks collected this tick — pre-removal (x,y,type,score). */
  collectedSparks: Array<{ x: number; y: number; type: number; score: number }>;
};

function freshEvents(): SimEvents {
  return {
    blobJumpAngle: null,
    mineExplosions: [],
    blobExploded: null,
    blobDrowned: false,
    endingStarted: false,
    runFinished: false,
    collectedPastilles: [],
    collectedSparks: [],
  };
}

// ============================================================================
// Snapshots (clone / restore)
// ============================================================================

export type SimSnapshot = {
  blob: Omit<Blob, 'cw'> & { cwIdx: number };
  wheels: Wheel[];
  pastilles: Pastille[];
  sparks: Spark[];
  tick: number;
  mapY: number;
  svy: number;
  roof: number;
  waterY: number;
  waterBoost: number;
  maxHeight: number;
  score: number;
  ending: boolean;
  endTimer: number;
  endFocusY: number;
  ended: boolean;
  spaceHeld: boolean;
  spacePressed: boolean;
  pointerPressed: boolean;
};

function freshBlob(): Blob {
  return {
    x: STAGE_WIDTH * 0.5,
    y: 0, vx: 0, vy: 0,
    state: BLOB_STATE_GRAB,
    wallSide: 0, stateTick: 0,
    cw: null,
    wa: 0, angle: 0, wet: 0,
    wasInWater: false, blop: 0,
    ox: STAGE_WIDTH * 0.5, oy: 0,
    vvx: 0, vvy: 0,
    deathTick: 0,
  };
}

// ============================================================================
// The simulator
// ============================================================================

export class InterwheelSim {
  blob: Blob = freshBlob();
  wheels: Wheel[] = [];
  pastilles: Pastille[] = [];
  sparks: Spark[] = [];

  tick = 0;
  mapY = 0;
  svy = 0;
  roof = 0;
  waterY = -300;
  waterBoost = 0;
  maxHeight = 0;
  score = 0;
  ending = false;
  endTimer = 0;
  endFocusY = 0;
  ended = false;
  spaceHeld = false;
  spacePressed = false;
  pointerPressed = false;

  events: SimEvents = freshEvents();

  reset(rng: RNG): void {
    this.events = freshEvents();
    this.tick = 0;
    this.mapY = 0;
    this.svy = 0;
    this.waterY = -300;
    this.waterBoost = 0;
    this.maxHeight = 0;
    this.score = 0;
    this.ending = false;
    this.endTimer = 0;
    this.endFocusY = 0;
    this.ended = false;
    this.spaceHeld = false;
    this.spacePressed = false;
    this.pointerPressed = false;
    this.sparks = [];
    this.pastilles = [];
    this.wheels = [];
    this.initWheels(rng);
    this.initPastilles(rng);
    this.blob = freshBlob();
    this.grabWheel(this.wheels[START_WHEEL_ID]);
    this.scrollMap(true);
  }

  /**
   * Drive one game tick. `press` is true if the player tapped this tick.
   * `rng` is consumed for cosmetic-but-stateful calls (e.g. the destroyed-
   * wheel dust check). Pass a constant RNG for deterministic search; pass
   * `Math.random` for live play.
   */
  step(press: boolean, rng: RNG): void {
    this.events = freshEvents();
    this.tick += 1;
    if (this.ended) return;
    if (this.ending) {
      this.updateWheels(rng);
      this.updateBlobDeath();
      this.separateSparks();
      this.updateSparks();
      this.updateBlobWaterEffects();
      this.scrollMap(false);
      this.endTimer -= 1;
      if (this.endTimer < 0) {
        this.ended = true;
        this.events.runFinished = true;
      }
      return;
    }
    if (press) this.spacePressed = true;
    this.updateWheels(rng);
    this.checkWheelCollision();
    this.updatePastilles();
    this.updateBlob();
    this.separateSparks();
    this.updateSparks();
    this.updateWaterAndScore();
    this.scrollMap(false);
  }

  clone(): SimSnapshot {
    const blob = this.blob;
    const cwIdx = blob.cw ? this.wheels.indexOf(blob.cw) : -1;
    return {
      blob: {
        x: blob.x, y: blob.y, vx: blob.vx, vy: blob.vy,
        state: blob.state, wallSide: blob.wallSide, stateTick: blob.stateTick,
        cwIdx, wa: blob.wa, angle: blob.angle, wet: blob.wet,
        wasInWater: blob.wasInWater, blop: blob.blop,
        ox: blob.ox, oy: blob.oy, vvx: blob.vvx, vvy: blob.vvy,
        deathTick: blob.deathTick,
      },
      wheels: this.wheels.map((w) => ({
        x: w.x, y: w.y, ray: w.ray, speed: w.speed, a: w.a, fr: w.fr,
        mines: w.mines.slice(),
        destroyed: w.destroyed, boomAngle: w.boomAngle,
        active: w.active, dustTick: w.dustTick,
      })),
      pastilles: this.pastilles.map((p) => ({ ...p })),
      sparks: this.sparks.map((s) => ({ ...s })),
      tick: this.tick,
      mapY: this.mapY, svy: this.svy, roof: this.roof,
      waterY: this.waterY, waterBoost: this.waterBoost,
      maxHeight: this.maxHeight, score: this.score,
      ending: this.ending, endTimer: this.endTimer, endFocusY: this.endFocusY,
      ended: this.ended,
      spaceHeld: this.spaceHeld, spacePressed: this.spacePressed,
      pointerPressed: this.pointerPressed,
    };
  }

  restore(s: SimSnapshot): void {
    // Rebuild the wheels array entirely — wheels in the live game are never
    // added/removed after init, so length always matches; we keep object
    // identity stable so blob.cw can be re-resolved.
    if (this.wheels.length !== s.wheels.length) {
      this.wheels = s.wheels.map((w) => ({ ...w, mines: w.mines.slice() }));
    } else {
      for (let i = 0; i < this.wheels.length; i += 1) {
        const w = this.wheels[i];
        const ws = s.wheels[i];
        w.x = ws.x; w.y = ws.y; w.ray = ws.ray; w.speed = ws.speed;
        w.a = ws.a; w.fr = ws.fr;
        w.mines = ws.mines.slice();
        w.destroyed = ws.destroyed; w.boomAngle = ws.boomAngle;
        w.active = ws.active; w.dustTick = ws.dustTick;
      }
    }
    // Pastilles can be removed by collection; restore exact length + values.
    this.pastilles = s.pastilles.map((p) => ({ ...p }));
    // Sparks similarly.
    this.sparks = s.sparks.map((sp) => ({ ...sp }));

    const b = this.blob;
    const bs = s.blob;
    b.x = bs.x; b.y = bs.y; b.vx = bs.vx; b.vy = bs.vy;
    b.state = bs.state;
    b.wallSide = bs.wallSide; b.stateTick = bs.stateTick;
    b.cw = bs.cwIdx >= 0 ? this.wheels[bs.cwIdx] : null;
    b.wa = bs.wa; b.angle = bs.angle; b.wet = bs.wet;
    b.wasInWater = bs.wasInWater; b.blop = bs.blop;
    b.ox = bs.ox; b.oy = bs.oy; b.vvx = bs.vvx; b.vvy = bs.vvy;
    b.deathTick = bs.deathTick;

    this.tick = s.tick;
    this.mapY = s.mapY; this.svy = s.svy; this.roof = s.roof;
    this.waterY = s.waterY; this.waterBoost = s.waterBoost;
    this.maxHeight = s.maxHeight; this.score = s.score;
    this.ending = s.ending; this.endTimer = s.endTimer; this.endFocusY = s.endFocusY;
    this.ended = s.ended;
    this.spaceHeld = s.spaceHeld; this.spacePressed = s.spacePressed;
    this.pointerPressed = s.pointerPressed;
    this.events = freshEvents();
  }

  // ---------------------------------------------------------------- helpers

  isElementActive(element: { y: number; ray: number }): boolean {
    const viewTop = -this.mapY;
    const viewBottom = viewTop + STAGE_HEIGHT;
    return element.y - element.ray < viewBottom && element.y + element.ray > viewTop;
  }

  private checkPress(): boolean {
    if (this.spacePressed) {
      this.spacePressed = false;
      return true;
    }
    if (this.pointerPressed) {
      this.pointerPressed = false;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- init

  private createWheelData(rng: RNG): Wheel {
    return {
      x: 0, y: 0, ray: 20, speed: 0.1, a: 0,
      fr: randomInt(rng, 5) + 1,
      mines: [],
      destroyed: false, boomAngle: null,
      active: false, dustTick: 0,
    };
  }

  private addMine(wheel: Wheel, rng: RNG): boolean {
    const perim = Math.PI * 2 * wheel.ray;
    if (perim / (wheel.mines.length + 1) < MINE_SPACE * MINE_SAFE_SPACE_FACTOR) return false;
    let tries = 0;
    while (tries <= 20) {
      const a = rng() * Math.PI * 2;
      const valid = wheel.mines.every((mine) => Math.abs(hMod(mine - a, Math.PI)) * wheel.ray >= MINE_SPACE);
      if (valid) {
        wheel.mines.push(a);
        return true;
      }
      tries += 1;
    }
    return false;
  }

  private difficultyAtY(y: number): number {
    return generationDifficultyAtHeight(heightMetersFromY(y));
  }

  private noisyDifficulty(base: number, rng: RNG): number {
    return clamp(base + (rng() * 2 - 1) * DIF_RANDOMIZER, 0, 1);
  }

  private wheelRay(difficulty: number, rng: RNG): number {
    const randomSpan = WHEEL_RAY_RANDOM * (1 - difficulty * (1 - WHEEL_RAY_RANDOM_HARD_FACTOR));
    return WHEEL_RAY_MIN + (1 - difficulty) * (WHEEL_RAY_MAX - WHEEL_RAY_MIN) + rng() * randomSpan;
  }

  private wheelSpeed(difficulty: number, rng: RNG): number {
    const randomSpan = WHEEL_SPEED_RANDOM * (1 - difficulty * (1 - WHEEL_SPEED_RANDOM_HARD_FACTOR));
    return WHEEL_SPEED_MIN + difficulty * (WHEEL_SPEED_MAX - WHEEL_SPEED_MIN) + rng() * randomSpan;
  }

  private interWheelChance(difficulty: number): number {
    return INTER_WHEEL_CHANCE_HARD + (1 - difficulty) * (INTER_WHEEL_CHANCE_EASY - INTER_WHEEL_CHANCE_HARD);
  }

  private addDifficultyMines(wheel: Wheel, difficulty: number, rng: RNG): void {
    const rollBias = 0.35 - difficulty * 0.25;
    let placed = 0;
    while (placed < MINE_MAX_PLACEMENT_ATTEMPTS && rng() + rollBias < difficulty) {
      if (!this.addMine(wheel, rng)) break;
      placed += 1;
    }
  }

  private initWheels(rng: RNG): void {
    const list: Wheel[] = [];
    let oldWheel = this.createWheelData(rng);
    oldWheel.ray = (STAGE_WIDTH - 2 * (SIDE + SPACE)) * 0.5;
    oldWheel.x = STAGE_WIDTH * 0.5;
    oldWheel.y = 0;
    oldWheel.speed = 0.1;
    list.push(oldWheel);

    for (let i = 0; i < WMAX; i += 1) {
      const baseDifficulty = this.difficultyAtY(oldWheel.y);
      const c = this.noisyDifficulty(baseDifficulty, rng);
      const c2 = this.noisyDifficulty(baseDifficulty, rng);
      const c3 = this.noisyDifficulty(baseDifficulty, rng);
      const wheel = this.createWheelData(rng);
      wheel.ray = this.wheelRay(c2, rng);
      wheel.speed = this.wheelSpeed(c3, rng);

      const spacingDifficulty = c * WHEEL_DIST_HARD_FACTOR;
      const dist = WHEEL_DIST_MIN + spacingDifficulty * (WHEEL_DIST_MAX - WHEEL_DIST_MIN) + oldWheel.ray + wheel.ray;
      const lim = SIDE + SPACE + wheel.ray;
      let tries = 0;
      while (tries < 200) {
        const a = -1.57 + (rng() * 2 - 1) * 1.4;
        wheel.x = oldWheel.x + Math.cos(a) * dist;
        wheel.y = oldWheel.y + Math.sin(a) * dist;
        let valid = wheel.x > lim && wheel.x < STAGE_WIDTH - lim;
        const prevPrev = list[list.length - 2];
        if (valid && prevPrev && distance(wheel, prevPrev) < wheel.ray + prevPrev.ray) valid = false;
        if (valid) break;
        tries += 1;
      }

      this.addDifficultyMines(wheel, this.noisyDifficulty(this.difficultyAtY(wheel.y), rng), rng);

      if (rng() < this.interWheelChance(c)) {
        const interWheel = this.createWheelData(rng);
        interWheel.y = (wheel.y + oldWheel.y) * 0.5;
        let tr = 0;
        while (tr <= 30) {
          const interDifficulty = this.noisyDifficulty(this.difficultyAtY(interWheel.y), rng);
          interWheel.ray = this.wheelRay(interDifficulty * 0.75, rng);
          interWheel.speed = this.wheelSpeed(interDifficulty, rng);
          const m = SIDE + SPACE + interWheel.ray;
          interWheel.x = STAGE_WIDTH - m;
          const valid =
            distance(interWheel, wheel) >= interWheel.ray + wheel.ray + SPACE &&
            distance(interWheel, oldWheel) >= interWheel.ray + oldWheel.ray + SPACE;
          if (valid) {
            list.push(interWheel);
            break;
          }
          tr += 1;
        }
      }
      oldWheel = wheel;
      list.push(wheel);
    }
    this.roof = oldWheel.y - oldWheel.ray;
    this.wheels = list;
  }

  private initPastilles(rng: RNG): void {
    for (let y = -100; y > this.roof; y -= 20) {
      if (rng() >= pastilleSpawnChanceAtY(y)) continue;
      let type = 0;
      if (randomInt(rng, 30) === 0) type = 1;
      if (randomInt(rng, 200) === 0) type = 2;
      const ray = 20;
      const m = SIDE + ray;
      const pastille: Pastille = {
        x: m + rng() * (STAGE_WIDTH - 2 * m),
        y, ray, type,
        phase: rng() * Math.PI * 2,
        active: false,
      };
      const overlapsWheel = this.wheels.some((wheel) => distance(pastille, wheel) < wheel.ray + ray);
      if (overlapsWheel) continue;
      this.pastilles.push(pastille);
    }
  }

  // ---------------------------------------------------------------- gameplay

  private updateWheels(rng: RNG): void {
    for (const wheel of this.wheels) {
      if (!this.isElementActive(wheel)) {
        wheel.active = false;
        continue;
      }
      if (!wheel.active) {
        wheel.active = true;
        wheel.dustTick = 0;
        continue;
      }
      wheel.dustTick += 1;
      wheel.a += wheel.speed;
      if (wheel.destroyed) {
        wheel.speed *= 0.97;
        // Cosmetic-only RNG draw kept here so the LIVE RNG advances at the
        // same cadence whether a search clone runs or not — the renderer
        // uses a SEPARATE RNG for the visual splatter, so the random value
        // is still consumed even though we don't act on it. This keeps
        // headless parity exact.
        if (wheel.boomAngle !== null) rng();
      }
    }
  }

  private updateBlob(): void {
    const blob = this.blob;
    if (blob.state === BLOB_STATE_GRAB && blob.cw) {
      blob.stateTick += 1;
      const a = blob.cw.a - blob.wa;
      blob.x = blob.cw.x + Math.cos(a) * blob.cw.ray;
      blob.y = blob.cw.y + Math.sin(a) * blob.cw.ray;
      blob.angle = a;
      blob.vx = 0;
      blob.vy = 0;
      if (this.checkPress()) {
        this.jump(a);
        const oldX = blob.x;
        const oldY = blob.y;
        this.integrateBlobFlight(false);
        blob.vvx = oldX - blob.x;
        blob.vvy = oldY - blob.y;
        blob.ox = blob.x;
        blob.oy = blob.y;
        this.checkSideCollision();
      }
      return;
    }
    if (blob.state === BLOB_STATE_WALL) {
      blob.stateTick += 1;
      blob.wallSide = blob.wallSide || (blob.x < STAGE_WIDTH * 0.5 ? -1 : 1);
      blob.x = blob.wallSide < 0 ? SIDE : STAGE_WIDTH - SIDE;
      blob.vx = 0;
      blob.vy += 0.6;
      blob.vy *= 0.92;
      if (this.checkPress()) {
        const sens = -blob.wallSide;
        this.jump(-Math.PI * 0.5 + JUMP_SIDE_ANGLE * sens);
        this.integrateBlobFlight(false);
      } else {
        blob.y += blob.vy;
      }
      return;
    }
    if (blob.state === BLOB_STATE_FLY) {
      blob.stateTick += 1;
      // Fly-trail is purely cosmetic (handled by renderer); but the blop
      // damping is gameplay state.
      blob.blop = Math.max(BLOB_BLOP_MIN, blob.blop * BLOB_BLOP_FRICT);
      const oldX = blob.x;
      const oldY = blob.y;
      this.integrateBlobFlight();
      blob.vvx = oldX - blob.x;
      blob.vvy = oldY - blob.y;
      blob.ox = blob.x;
      blob.oy = blob.y;
    }
    this.checkSideCollision();
  }

  private integrateBlobFlight(applyWaterDrag = true): void {
    const blob = this.blob;
    if (applyWaterDrag && blob.state === BLOB_STATE_FLY && blob.wasInWater) {
      blob.vx *= 0.95;
      blob.vy *= 0.95;
    }
    blob.vy += BLOB_WEIGHT;
    blob.vx *= 0.98;
    blob.vy *= 0.98;
    blob.x += blob.vx;
    blob.y += blob.vy;
  }

  private checkSideCollision(): void {
    const blob = this.blob;
    if (blob.state === BLOB_STATE_FLY && (blob.x < SIDE || blob.x > STAGE_WIDTH - SIDE)) {
      this.enterWall(blob.x < SIDE ? -1 : 1);
    }
  }

  private enterWall(side: -1 | 1): void {
    const blob = this.blob;
    blob.state = BLOB_STATE_WALL;
    blob.wallSide = side;
    blob.stateTick = 0;
    blob.x = side < 0 ? SIDE : STAGE_WIDTH - SIDE;
    blob.vx = 0;
    blob.vy = 0;
  }

  private jump(a: number): void {
    const blob = this.blob;
    this.events.blobJumpAngle = a;
    blob.vx = Math.cos(a) * BLOB_JUMP;
    blob.vy = Math.sin(a) * BLOB_JUMP;
    blob.blop = BLOB_BLOP_START;
    blob.ox = blob.x;
    blob.oy = blob.y;
    blob.vvx = 0;
    blob.vvy = 0;
    blob.state = BLOB_STATE_FLY;
    blob.wallSide = 0;
    blob.stateTick = 0;
    blob.cw = null;
  }

  private grabWheel(wheel: Wheel): void {
    const blob = this.blob;
    const ba = angleTo(blob, wheel) + Math.PI;
    blob.cw = wheel;
    blob.wa = hMod(wheel.a - ba, Math.PI);
    blob.state = BLOB_STATE_GRAB;
    blob.wallSide = 0;
    blob.stateTick = 0;
    blob.vx = 0;
    blob.vy = 0;
    const a = wheel.a - blob.wa;
    blob.x = wheel.x + Math.cos(a) * wheel.ray;
    blob.y = wheel.y + Math.sin(a) * wheel.ray;
    blob.angle = a;
  }

  private checkWheelCollision(): void {
    const blob = this.blob;
    if (blob.state !== BLOB_STATE_FLY) return;
    for (let wi = 0; wi < this.wheels.length; wi += 1) {
      const wheel = this.wheels[wi];
      if (!wheel.active) continue;
      if (distance(blob, wheel) >= wheel.ray + BLOB_RAY) continue;

      const ba = angleTo(blob, wheel) + Math.PI;
      for (let i = 0; i < wheel.mines.length; i += 1) {
        const mineAngle = wheel.mines[i];
        const da = hMod(mineAngle + wheel.a - ba, Math.PI);
        if (Math.abs(da) * wheel.ray < MINE_SPACE) {
          const x = wheel.x + Math.cos(wheel.a + mineAngle) * wheel.ray;
          const y = wheel.y + Math.sin(wheel.a + mineAngle) * wheel.ray;
          wheel.destroyed = true;
          wheel.boomAngle = mineAngle;
          this.events.mineExplosions.push({ wheelIdx: wi, mineIdx: i, mineAngle, x, y, ba });
          this.explodeBlob(ba);
          return;
        }
      }
      this.grabWheel(wheel);
      return;
    }
  }

  private explodeBlob(ba: number): void {
    const blob = this.blob;
    blob.state = BLOB_STATE_DEAD;
    blob.deathTick = 0;
    blob.stateTick = 0;
    this.events.blobExploded = { ba, x: blob.x, y: blob.y };
    this.endGame();
  }

  private startBlobDrowningDeath(): void {
    const blob = this.blob;
    if (blob.state === BLOB_STATE_DEAD) return;
    blob.state = BLOB_STATE_DEAD;
    blob.deathTick = 0;
    blob.stateTick = 0;
    blob.wallSide = 0;
    this.events.blobDrowned = true;
  }

  private updateBlobDeath(): void {
    const blob = this.blob;
    if (blob.state !== BLOB_STATE_DEAD) return;
    blob.wet -= 0.02;
    blob.vy += BLOB_WEIGHT;
    blob.vx *= 0.8;
    blob.vy *= 0.8;
    blob.x += blob.vx;
    blob.y += blob.vy;
    blob.deathTick += 1;
  }

  private updatePastilles(): void {
    const blob = this.blob;
    for (let i = 0; i < this.pastilles.length; i += 1) {
      const pastille = this.pastilles[i];
      if (!this.isElementActive(pastille)) {
        pastille.active = false;
        continue;
      }
      if (!pastille.active) {
        pastille.active = true;
        continue;
      }
      if (distance(blob, pastille) < 70) {
        this.events.collectedPastilles.push({ x: pastille.x, y: pastille.y, type: pastille.type });
        // Pastille becomes a chasing spark (gameplay: it credits score
        // when it reaches the blob).
        this.sparks.push({
          x: pastille.x, y: pastille.y, vx: 0, vy: 0,
          type: pastille.type, score: SCORE_PASTILLE[pastille.type],
          distLimit: 5, coefLimit: 0.1, coef: 0.01,
        });
        this.pastilles.splice(i, 1);
        i -= 1;
      }
    }
  }

  private updateSparks(): void {
    const blob = this.blob;
    for (let i = 0; i < this.sparks.length; i += 1) {
      const spark = this.sparks[i];
      spark.vx *= 0.9;
      spark.vy *= 0.9;
      spark.x += spark.vx;
      spark.y += spark.vy;
      spark.distLimit += 0.05;
      spark.coefLimit += 0.001;
      spark.coef = Math.min(spark.coef + 0.005, spark.coefLimit);
      spark.vx += clamp((blob.x - spark.x) * spark.coef, -spark.distLimit, spark.distLimit);
      spark.vy += clamp((blob.y - spark.y) * spark.coef, -spark.distLimit, spark.distLimit);
      if (distance(blob, spark) < BLOB_RAY + 8) {
        this.score += spark.score;
        this.events.collectedSparks.push({ x: spark.x, y: spark.y, type: spark.type, score: spark.score });
        this.sparks.splice(i, 1);
        i -= 1;
      }
    }
  }

  private separateSparks(): void {
    for (let i = 0; i < this.sparks.length; i += 1) {
      const p0 = this.sparks[i];
      for (let n = i + 1; n < this.sparks.length; n += 1) {
        const p1 = this.sparks[n];
        const dif = 16 - distance(p0, p1);
        if (dif <= 0) continue;
        const a = angleTo(p0, p1);
        const cx = Math.cos(a) * dif * 0.5;
        const cy = Math.sin(a) * dif * 0.5;
        p0.x -= cx;
        p0.y -= cy;
        p1.x += cx;
        p1.y += cy;
      }
    }
  }

  private updateBlobWaterEffects(): void {
    const blob = this.blob;
    if (blob.state === BLOB_STATE_DEAD) return;
    const inWater = blob.y - BLOB_RAY > this.waterY;
    if (inWater) {
      blob.wet += 0.015;
      if (blob.vy > 0) blob.vy *= 0.9;
    } else if (blob.wet > 0) {
      blob.wet = Math.max(0, blob.wet - 0.02);
    }
    blob.wasInWater = inWater;
  }

  private updateWaterAndScore(): void {
    const blob = this.blob;
    this.waterBoost += WATER_SPEED_INC;
    this.waterY -= WATER_SPEED + this.waterBoost;
    this.updateBlobWaterEffects();
    if (blob.wet > 1) {
      this.startBlobDrowningDeath();
      this.endGame();
    }
    const runHeight = Math.max(0, -blob.y);
    const heightGain = runHeight - this.maxHeight;
    if (heightGain > 0) {
      const scoreGain = Math.floor(heightGain);
      if (scoreGain > 0) this.score += scoreGain;
    }
    this.maxHeight = Math.max(runHeight, this.maxHeight);
  }

  private scrollMap(force: boolean): void {
    const blob = this.blob;
    const focusY = this.ending
      ? this.endFocusY
      : blob.state === BLOB_STATE_GRAB && blob.cw
        ? blob.cw.y - VIEW_WHEEL
        : blob.y;
    const targetY = STAGE_HEIGHT * 0.5 - focusY;
    if (force) {
      this.mapY = targetY;
      this.svy = 0;
      return;
    }
    this.svy += (targetY - this.mapY) * 0.1;
    this.svy *= 0.6;
    this.mapY += this.svy;
  }

  private endGame(): void {
    if (this.ending || this.ended) return;
    this.ending = true;
    this.endTimer = ENDGAME_DELAY;
    this.endFocusY = this.blob.y;
    this.events.endingStarted = true;
  }
}
