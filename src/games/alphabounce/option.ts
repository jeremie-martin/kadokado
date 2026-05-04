// Option — port of Option.hx.
//
// 26 letter power-ups (A–Z), each with a unique effect dispatched by
// Game.getOption(id). PROB array drives weighted random; isBad() filters
// hazardous options on lvl 0.

import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { GameContext } from './game-context';
import { BH, BW } from './constants';
import { makeSprite } from '../_shared/frames';
import { makePart, setColor, spawnMovieClip } from './fx';

const FALL_SPEED = 3;
const OPTION_PIVOT_X = 14.5;
const OPTION_PIVOT_Y = 6;
const SCROLL_X = -8;
const SCROLL_MIN_Y = -5;
const SCROLL_PERIOD = 26;
const SCROLL_MASK_X = -10;
const SCROLL_MASK_Y = -5;
const SCROLL_MASK_W = 20;
const SCROLL_MASK_H = 10;
const SCROLL_FIELD_X = 8;
const SCROLL_FIELD_Y = 17;

// PROB array (Option.PROB) — 26 weights. Verbatim from Option.hx.
const PROB: number[] = [
  4, // A IMANT
  1, // B LINDAGE
  12, // C OLLE
  10, // D IMINUTION
  30, // E XTENSION
  10, // F LAMME
  7, // G LACE
  5, // H ALO
  3, // I NVERSION
  10, // J AVELOT
  0.5, // K AMIKAZE
  5, // L ASER
  36, // M ULTI-BALL
  6, // N ERVEUX
  4, // O UVRE
  3, // P ROTECTION
  2, // Q UASAR
  5, // R ALLENTISSEMENT
  5, // S AUVETAGE
  10, // T EMPORALITE
  0.5, // U NIFICATION
  2, // V AGUE
  2, // W HISKY
  1, // X ENOPHOBIE
  1, // Y OYO
  5, // Z ELE
];

export const OPTION_NAMES = [
  'AIMANT',
  'BLINDAGE',
  'COLLE',
  'DIMINUTION',
  'EXTENSION',
  'FLAMME',
  'GLACE',
  'HALO',
  'INVERSION',
  'JAVELOT',
  'KAMIKAZE',
  'LASER',
  'MULTI-BALL',
  'NERVEUX',
  'OUVRE',
  'PROTECTION',
  'QUASAR',
  'RALLENTISSEMENT',
  'SAUVETAGE ACTIF',
  'TEMPORALITE',
  'UNIFICATION',
  'VAGUE',
  'WHISKY',
  'XENOPHOBIE',
  'YOYO',
  'ZELE',
];

function isBad(id: number): boolean {
  return id === 1 || id === 3 || id === 6 || id === 8 || id === 13 || id === 22 || id === 23 || id === 25;
}

function getRandomId(): number {
  let sum = 0;
  for (const n of PROB) sum += Math.floor(n * 10);
  const rnd = Math.floor(Math.random() * sum);
  let acc = 0;
  for (let i = 0; i < PROB.length; i += 1) {
    acc += Math.floor(PROB[i] * 10);
    if (acc > rnd) return i;
  }
  return PROB.length - 1;
}

function hMod(a: number, m: number): number {
  const t = ((a % (m * 2)) + m * 2) % (m * 2);
  return t > m ? t - m * 2 : t;
}

function darkenColor(col: number, amount: number): number {
  const r = Math.max(((col >> 16) & 0xff) - amount, 0);
  const g = Math.max(((col >> 8) & 0xff) - amount, 0);
  const b = Math.max((col & 0xff) - amount, 0);
  return (r << 16) | (g << 8) | b;
}

// Col.getRainbow + per-id color shift (matches Option.getCol).
export function getOptionColor(id: number): number {
  const c = id / 26;
  const channels = [0, 0, 0];
  const max = 3;
  const part = (1 / max) * 2;
  for (let i = 0; i < max; i += 1) {
    const med = part + i * 2 * part;
    const dif = hMod(med - c, 0.5);
    channels[i] = Math.min(1.5 - Math.abs(dif) * 3, 1);
  }
  let r = Math.floor(channels[0] * 255);
  let g = Math.floor(channels[1] * 255);
  let b = Math.floor(channels[2] * 255);
  // Per-id darkening (id % 3) * 50.
  const dec = (id % 3) * 50;
  r = Math.max(0, r - dec);
  g = Math.max(0, g - dec);
  b = Math.max(0, b - dec);
  return (r << 16) | (g << 8) | b;
}

export class Option {
  ctx: GameContext;
  view: Container;
  body: Sprite;
  scrollClip: Container;
  scrollBg: Sprite;
  scrollMask: Graphics;
  letterText: Text;
  id = 0;
  color = 0xffffff;
  vy = FALL_SPEED;
  alive = true;
  // Position fields.
  x = 0;
  y = 0;
  // Source scroll MovieClip y-offset: -30..-5, clipped by mcOption's mask.
  scrollY = SCROLL_MIN_Y;

  constructor(ctx: GameContext) {
    this.ctx = ctx;
    this.view = new Container();
    this.body = makeSprite(ctx.assets.option);
    // Source mcOption registration is centered on the 28x12 top body; the
    // flattened export is 30x31 because it preserves the masked scroll bounds.
    this.body.pivot.set(OPTION_PIVOT_X, OPTION_PIVOT_Y);
    this.view.addChild(this.body);
    this.scrollMask = new Graphics();
    this.scrollMask.rect(SCROLL_MASK_X, SCROLL_MASK_Y, SCROLL_MASK_W, SCROLL_MASK_H).fill({ color: 0xffffff });
    this.view.addChild(this.scrollMask);
    this.scrollClip = new Container();
    this.scrollClip.x = SCROLL_X;
    this.scrollClip.y = this.scrollY;
    this.view.addChild(this.scrollClip);
    this.scrollClip.mask = this.scrollMask;
    this.scrollBg = makeSprite(ctx.assets.scrollBg);
    this.scrollClip.addChild(this.scrollBg);
    this.letterText = new Text({
      text: 'A',
      style: { fontFamily: 'Alphabounce Verdana', fontSize: 16, fill: 0x000000, stroke: { color: 0xffffff, width: 2 } },
    });
    this.letterText.anchor.set(0.5);
    this.letterText.x = SCROLL_FIELD_X;
    this.letterText.y = SCROLL_FIELD_Y;
    this.scrollClip.addChild(this.letterText);
    ctx.optionLayer.addChild(this.view);
    ctx.options.push(this);
  }

  setType(n: number | null): void {
    let id = n;
    if (id === null) {
      id = getRandomId();
      while (isBad(id) && this.ctx.lvl === 0) id = getRandomId();
    }
    this.id = id;
    this.letterText.text = String.fromCharCode(65 + id);
    const col = getOptionColor(id);
    setColor(this.body, col);
    setColor(this.scrollBg, col);
    this.letterText.style.fill = darkenColor(col, 200);
    this.color = col;
  }

  update(): void {
    this.y += this.vy * this.ctx.tmod;
    this.view.x = this.x;
    this.view.y = this.y;
    // Scroll letter (cosmetic). Source: skin.scroll._y += 1; if(_y > -5) _y -= 26.
    this.scrollY += 1;
    if (this.scrollY > SCROLL_MIN_Y) this.scrollY -= SCROLL_PERIOD;
    this.scrollClip.y = this.scrollY;

    // Pad collision.
    const padY = this.ctx.pad.y + BH * 0.5;
    if (Math.abs(this.y - padY) < BH && Math.abs(this.x - this.ctx.pad.x) < this.ctx.pad.ray + BW * 0.5) {
      this.apply();
    }
  }

  private apply(): void {
    // FX: 16 LineUp particles + an mcOnde wave aura.
    for (let i = 0; i < 16; i += 1) {
      const sp = makeSprite(this.ctx.assets.partLineUp);
      sp.anchor.set(0.5, 1);
      this.ctx.partsLayer.addChild(sp);
      makePart(this.ctx, {
        kind: 'lineUp',
        view: sp,
        x: this.x + (Math.random() * 2 - 1) * BW * 0.5,
        y: this.y + (Math.random() * 2 - 1) * BH * 0.5,
        vx: (Math.random() * 2 - 1) * 5,
        factor: 8,
        timer: 10 + Math.random() * 10,
        life: 20,
        frict: 0.9,
      });
    }

    // mcOnde aura — 11-frame self-playing MovieClip (round 11 fix).
    // Source plays the full timeline at 40 Hz; the previous port wrapped a
    // single frame[0] with alpha-fade for 11 ticks. spawnMovieClip walks
    // all 11 frames at engine rate (tmod-aware), killing on overflow.
    spawnMovieClip(
      this.ctx,
      this.ctx.underPartsLayer,
      this.ctx.assets.onde,
      this.x,
      this.y,
      { anchor: { x: 0.5, y: 0.5 } },
    );

    this.ctx.getOption(this.id);
    this.kill();
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    const i = this.ctx.options.indexOf(this);
    if (i >= 0) this.ctx.options.splice(i, 1);
    this.view.removeFromParent();
  }
}
