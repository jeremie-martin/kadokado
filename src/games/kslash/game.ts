// Game — port of Game.mt. Owns the world map, grid, entity lists,
// scrolling, particle system, monster spawning, and difficulty ramp.

import { Application, ColorMatrixFilter, Container, Sprite, Text, TilingSprite } from 'pixi.js';
import type { GameHost } from '../types';
import { makeSprite, setFrame } from '../_shared/frames';

import {
  ASSET_ROOT,
  BG_FRAMES,
  BFX_FRAMES,
  BG_FRONT_FRAMES,
  BONUS_FRAMES,
  DIF_RAMP,
  NIGHT_CODE,
  DP_BACK,
  DP_BG,
  DP_BONUS,
  DP_DECOR,
  DP_FRONT,
  DP_HERO,
  DP_INTER,
  DP_MAP,
  DP_MONSTER,
  DP_PARTS,
  DP_SHADE,
  DP_SHOOT,
  FALL_FRAMES,
  FLYER_FRAMES,
  HERO_FRAMES,
  ICON_FRAMES,
  MCH,
  MCW,
  MONSTER_FRAMES,
  MONSTER_LEVEL_MAX_INIT,
  MONSTER_LEVEL_RAMP,
  NINJA_SHOT_FRAMES,
  PART_DUST_FRAMES,
  PART_LIGHT_FRAMES,
  PART_SMOKE_FRAMES,
  PART_SPARK_FRAMES,
  PLAT_CORNER_INSET,
  PLAT_FRAMES,
  PLAT_ECART,
  SHADE_FRAMES,
  SIZE,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  TANKER_FRAMES,
  TMOD,
  XMAX,
  YMAX,
} from './constants';
import type { GameContext, GridCell, KSlashAssets, ParallaxLayer, Particle, ParticleLink, Stats } from './game-context';
import { Bonus } from './bonus';
import { Hero } from './hero';
import { Flyer, Soldier, Tanker, type Monster } from './enemies';
import type { Shoot } from './projectiles';
import { loadFrame, loadSeries } from '../_shared/frames';

export type Plat = { x: number; y: number; w: number; mc: Container | null };

export async function loadAssets(): Promise<KSlashAssets> {
  const [
    bg,
    bgBack,
    bgFront,
    mapBg,
    inter,
    score,
    partCircle,
    kunai,
    hero,
    monster,
    tanker,
    flyer,
    bonus,
    shade,
    fall,
    ninjaShot,
    icon,
    plat,
    platBodyDay,
    platBodyNight,
    platCornerDay,
    platCornerNight,
    partDust,
    partLight,
    partSpark,
    partSmoke,
    bfx,
  ] = await Promise.all([
    loadSeries(`${ASSET_ROOT}/bg`, BG_FRAMES, 0, 0),
    loadFrame(`${ASSET_ROOT}/bg-back.png`, 0, 0),
    loadSeries(`${ASSET_ROOT}/bg-front`, BG_FRONT_FRAMES, 0, 0),
    loadFrame(`${ASSET_ROOT}/map-bg.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/inter.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/score.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/part-circle.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/kunai.png`, 0, 0),
    loadSeries(`${ASSET_ROOT}/hero`, HERO_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/monster`, MONSTER_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/tanker`, TANKER_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/flyer`, FLYER_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/bonus`, BONUS_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/shade`, SHADE_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/fall`, FALL_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/ninja-shot`, NINJA_SHOT_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/icon`, ICON_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/plat`, PLAT_FRAMES, 0, 0),
    loadFrame(`${ASSET_ROOT}/plat/body-day.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/plat/body-night.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/plat/corner-day.png`, 0, 0),
    loadFrame(`${ASSET_ROOT}/plat/corner-night.png`, 0, 0),
    loadSeries(`${ASSET_ROOT}/part-dust`, PART_DUST_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/part-light`, PART_LIGHT_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/part-spark`, PART_SPARK_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/part-smoke`, PART_SMOKE_FRAMES, 0, 0),
    loadSeries(`${ASSET_ROOT}/bfx`, BFX_FRAMES, 0, 0),
  ]);

  return {
    bg,
    bgBack,
    bgFront,
    mapBg,
    inter,
    score,
    partCircle,
    kunai,
    hero,
    monster,
    tanker,
    flyer,
    bonus,
    shade,
    fall,
    ninjaShot,
    icon,
    plat,
    platBody: [platBodyDay, platBodyNight],
    platCorner: [platCornerDay, platCornerNight],
    partDust,
    partLight,
    partSpark,
    partSmoke,
    bfx,
  };
}

export class KSlashGame implements GameContext {
  app: Application;
  assets: KSlashAssets;
  host: GameHost;

  // Layers (DepthManager equivalents).
  bgLayer = new Container(); // DP_BG
  worldLayer = new Container();
  bgBackLayer = new Container(); // DP_BACK (parallax)
  mapLayer = new Container(); // DP_MAP — game map root
  bgFrontLayer = new Container(); // DP_FRONT (parallax)
  hudLayer = new Container(); // DP_INTER

  // Sub-layers within mapLayer (per Game.DP_*).
  decorLayer = new Container(); // DP_DECOR
  shadeLayer = new Container(); // DP_SHADE
  bonusLayer = new Container(); // DP_BONUS
  monsterLayer = new Container(); // DP_MONSTER
  heroLayer = new Container(); // DP_HERO
  shootLayer = new Container(); // DP_SHOOT
  partsLayer = new Container(); // DP_PARTS

  grid: GridCell[][] = [];
  platList: Plat[] = [];
  mList: Monster[] = [];
  sList: Shoot[] = [];
  nsList: Shoot[] = [];
  bList: Bonus[] = [];
  pList: Particle[] = [];
  iconList: Sprite[] = [];
  planList: ParallaxLayer[] = [];
  optList = [false, false, false];
  // Source's death() leaves the MovieClip on stage so the death anim can
  // play (a memory leak in the original). We defer removal via this list.
  // The optional `tick` callback advances the corpse's animation frame so
  // the death anim actually plays (since update() no longer runs after the
  // monster is removed from mList).
  corpseList: { view: Container; t: number; tick?: () => void }[] = [];

  hero!: Hero;
  flNight = false;
  // Night-mode ColorMatrixFilters allocated per parallax layer in setNight().
  // Tracked so destroy() can release them without leaking GPU programs.
  private nightFilters: ColorMatrixFilter[] = [];
  monsterLevel = 0;
  monsterLevelMax = MONSTER_LEVEL_MAX_INIT;
  dif = 0;
  cheatTimer = 0;

  stats: Stats = { $opt: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], $bads: [0, 0, 0, 0, 0], $dif: 0 };

  starText: Text;
  scoreText: Text;
  gameOverText: Text;
  score = 0;

  // HUD HUD background.
  bgSprite: Sprite;
  interSprite: Sprite;

  constructor(app: Application, assets: KSlashAssets, host: GameHost) {
    this.app = app;
    this.assets = assets;
    this.host = host;

    // Compose stage. Order (bottom→top):
    //   bgLayer (decor.bg static at depth DP_BG=1)
    //   bgBackLayer (parallax decorations behind world)
    //   worldLayer with mapLayer scrolling
    //   bgFrontLayer (parallax in front of world)
    //   hudLayer
    app.stage.addChild(this.bgLayer, this.bgBackLayer, this.worldLayer, this.bgFrontLayer, this.hudLayer);
    this.worldLayer.addChild(this.mapLayer);
    this.mapLayer.addChild(
      this.decorLayer,
      this.shadeLayer,
      this.bonusLayer,
      this.monsterLayer,
      this.heroLayer,
      this.shootLayer,
      this.partsLayer,
    );

    this.bgSprite = makeSprite(assets.bg[0]);
    this.bgLayer.addChild(this.bgSprite);

    this.interSprite = makeSprite(assets.inter);
    this.interSprite.x = 0;
    this.interSprite.y = STAGE_HEIGHT - this.interSprite.height;
    this.hudLayer.addChild(this.interSprite);

    // Parallax layers — back: bgBack still + bgFront variant frames.
    this.planList.push({ mc: this.bgLayer, c: 0.13 });
    this.planList.push({ mc: this.mapLayer, c: 1 });

    // Parallax strips. Source `Game.mt:81-94` attaches "bgFront" once per
    // frame of the bgFront sprite (3 frames in `decor.swf`, sprite 14) and
    // "bgBack" once per frame of the bgBack sprite (1 frame, sprite 3),
    // breaking when `i+1 == _totalframes`. Each strip's parallax coefficient
    // is `c = (_width - 300) / 300`, where `_width` is the frame's untransformed
    // bbox width in px (twips ÷ 20). FFDec on `decor.swf` gives:
    //   bgFront frame 1 (shape 7):  Xmax=13002, Xmin=2    → 650 px → c≈1.167
    //   bgFront frame 2 (shape 11): Xmax=14000, Xmin=0    → 700 px → c≈1.333
    //   bgFront frame 3 (shape 13): Xmax=20000, Xmin=0    → 1000 px → c≈2.333
    //   bgBack  frame 1 (shape 2):  Xmax=10000, Xmin=0    → 500 px → c≈0.667
    // Coefficients > 1 mean the strip scrolls faster than the hero (foreground
    // speed-line effect). bgBack at c≈0.667 is mid-distance behind the map.
    // Replaces R1's inferred `0.4 + i*0.15` ramp and the `0.3` bgBack guess.
    const bgFrontCoeffs = [(650 - 300) / 300, (700 - 300) / 300, (1000 - 300) / 300];
    for (let i = 0; i < BG_FRONT_FRAMES; i += 1) {
      const layer = new Container();
      const sp = makeSprite(assets.bgFront[i]);
      layer.addChild(sp);
      this.bgFrontLayer.addChild(layer);
      this.planList.push({ mc: layer, c: bgFrontCoeffs[i] });
    }
    {
      const layer = new Container();
      const sp = makeSprite(assets.bgBack);
      layer.addChild(sp);
      this.bgBackLayer.addChild(layer);
      this.planList.push({ mc: layer, c: (500 - 300) / 300 });
    }

    this.initGrid();
    this.initPlat();

    // HUD text — star count on the inter strip; score top-left.
    // Hero construction grants the initial stars, so the star text must exist first.
    this.starText = new Text({
      text: '40',
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 12,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    this.starText.position.set(STAGE_WIDTH - 30, STAGE_HEIGHT - 16);
    this.hudLayer.addChild(this.starText);

    // Hero.
    const heroContainer = new Container();
    const heroSprite = makeSprite(assets.hero[0]);
    heroSprite.anchor.set(0.5);
    heroContainer.addChild(heroSprite);
    this.heroLayer.addChild(heroContainer);
    this.hero = new Hero(heroContainer, this, heroSprite);

    this.scoreText = new Text({
      text: '0',
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 14,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    this.scoreText.position.set(8, 6);
    this.hudLayer.addChild(this.scoreText);

    this.gameOverText = new Text({
      text: '',
      style: {
        fontFamily: 'Arial, Helvetica, sans-serif',
        fontSize: 24,
        fontWeight: '700',
        fill: 0xffffff,
        stroke: { color: 0x000000, width: 4 },
      },
    });
    this.gameOverText.anchor.set(0.5);
    this.gameOverText.position.set(STAGE_WIDTH / 2, STAGE_HEIGHT / 2);
    this.hudLayer.addChild(this.gameOverText);

    this.updateIcons();

    if (Math.random() * 500 < 1) this.setNight();
    this.host.updateScore(0);
  }

  // NIGHT_CODE input — exposed so index.ts's keydown listener can drive it.
  nightIndex = 0;
  pushKeyCode(code: number): void {
    if (code === NIGHT_CODE[this.nightIndex]) {
      this.nightIndex += 1;
      if (this.nightIndex === NIGHT_CODE.length) this.setNight();
    } else {
      this.nightIndex = 0;
    }
  }

  // Expose for index.ts. setNight is private; provide a public alias.
  triggerNight(): void {
    this.setNight();
  }

  // ---- world setup ----

  private initGrid(): void {
    this.grid = [];
    for (let x = 0; x < XMAX; x += 1) {
      const col: GridCell[] = [];
      for (let y = 0; y < YMAX; y += 1) {
        col.push({ block: false, list: [] });
      }
      this.grid.push(col);
    }
  }

  private initPlat(): void {
    this.platList = [{ x: 0, y: YMAX - 1, w: XMAX, mc: null }];
    let y = YMAX - 1;
    while (y > 8) {
      y -= PLAT_ECART;
      let x = Math.floor(Math.random() * 4);
      while (x < XMAX) {
        const w = 2 + Math.floor(Math.random() * 8);
        this.platList.push({ x, y, w, mc: null });
        x += w + 2 + Math.floor(Math.random() * 8 * (1 - y / YMAX));
      }
    }

    for (const o of this.platList) {
      const mc = new Container();
      this.composePlat(mc, o.w, this.flNight);
      mc.x = SIZE * o.x;
      mc.y = SIZE * o.y;
      o.mc = mc;
      this.decorLayer.addChild(mc);

      for (let n = 0; n < o.w; n += 1) {
        if (o.x + n >= 0 && o.x + n < XMAX) {
          this.grid[o.x + n][o.y].block = true;
        }
      }
    }
  }

  // R23: Build the 3-piece plat composition matching `Game.setPlat`. Source's
  // mcPlat (DefineSprite 402 in gfx.swf) layers a body sprite under a mask
  // scaled to `(w*SIZE)-2*c` plus a mirrored left corner at x=c and a right
  // corner at x=(w*SIZE)-c, where c=PLAT_CORNER_INSET=19. Day/night frames
  // swap body+corner textures; the layout math is unchanged.
  private composePlat(mc: Container, w: number, night: boolean): void {
    while (mc.children.length > 0) {
      const child = mc.removeChildAt(0);
      if (child instanceof Container) child.destroy({ children: true });
    }
    const c = PLAT_CORNER_INSET;
    const idx = night ? 1 : 0;
    const widthPx = w * SIZE;
    const innerWidth = widthPx - 2 * c;
    const bodyFrame = this.assets.platBody[idx];
    const cornerFrame = this.assets.platCorner[idx];

    // Body — TilingSprite reproduces the source's masked-body strip without
    // distorting the rock pattern (single-sprite stretch warps the texture).
    if (innerWidth > 0) {
      const body = new TilingSprite({
        texture: bodyFrame.texture,
        width: innerWidth,
        height: bodyFrame.texture.height,
      });
      body.x = c;
      body.y = 0;
      mc.addChild(body);
    }

    // Left corner — source places character 394 at translateX=c with
    // scaleX=-1 (sprite mirrored). Pixi anchor.x=0 + scale.x=-1 makes the
    // visible bounds go from `x - width` to `x`, so setting x=c places the
    // mirrored corner with its (visual) right edge at the platform inset.
    const leftCorner = makeSprite(cornerFrame);
    leftCorner.scale.x = -1;
    leftCorner.x = c;
    leftCorner.y = 0;
    mc.addChild(leftCorner);

    // Right corner — source's named `corner` field, runtime-positioned at
    // mc.corner._x = mask._xscale + c = (w*SIZE)-c.
    const rightCorner = makeSprite(cornerFrame);
    rightCorner.x = widthPx - c;
    rightCorner.y = 0;
    mc.addChild(rightCorner);
  }

  private setNight(): void {
    if (this.flNight) return;
    this.flNight = true;
    setFrame(this.bgSprite, this.assets.bg[1]);
    // R23: rebuild each plat's 3-piece composition with night-frame body and
    // corner textures. Source `Game.setNight` calls `setPlat(o)` again on
    // every entry which `gotoAndStop("2")`s the mcPlat clip and re-applies
    // the layout math — equivalent to our composePlat rebuild.
    for (const p of this.platList) {
      if (p.mc) this.composePlat(p.mc, p.w, true);
    }
    // Source: `Cs.setPercentColor(o.mc, 40, 0x000044)` per mid-distance
    // parallax layer — linear lerp toward 0x000044 by 40%. Implemented via a
    // ColorMatrixFilter (Pixi v8 multiplicative tint cannot darken-then-shift
    // toward a non-white target without a filter). Formula:
    //   out_ch = in_ch*(1-p) + target_ch*p, with p=0.4.
    // For target 0x000044: R=0, G=0, B=68/255≈0.267 → offsets [0, 0, 0.107].
    const p = 0.4;
    const d = 1 - p;
    const targetB = 0x44 / 0xff;
    const offsetB = targetB * p;
    for (const info of this.planList) {
      if (info.c !== 1 && info.c > 0.5) {
        const f = new ColorMatrixFilter();
        f.matrix = [
          d, 0, 0, 0, 0,
          0, d, 0, 0, 0,
          0, 0, d, 0, offsetB,
          0, 0, 0, 1, 0,
        ];
        info.mc.filters = [f];
        this.nightFilters.push(f);
      }
    }
  }

  // ---- main loop ----

  step(): void {
    this.hero.update();
    for (let i = 0; i < this.mList.length; i += 1) {
      this.mList[i].update();
    }
    for (let i = 0; i < this.sList.length; i += 1) {
      this.sList[i].update();
    }
    for (let i = 0; i < this.nsList.length; i += 1) {
      this.nsList[i].update();
    }
    for (let i = 0; i < this.bList.length; i += 1) {
      this.bList[i].update();
    }

    this.updateScroll();
    this.updateParts();
    this.updateCorpses();

    if (this.monsterLevel < this.monsterLevelMax) {
      this.addMonster();
    }
    this.monsterLevelMax += MONSTER_LEVEL_RAMP * TMOD;
    this.dif += DIF_RAMP * TMOD;
  }

  private updateScroll(): void {
    for (const info of this.planList) {
      const tx = Math.min(Math.max(-(XMAX * SIZE * 0.5), MCW * 0.5 - this.hero.view.x), 0);
      const ty = Math.min(Math.max(-(YMAX * SIZE * 0.5), MCH * 0.5 - this.hero.view.y), 0);
      info.mc.x = tx * info.c;
      info.mc.y = ty * info.c;
    }
  }

  // ---- monster spawning ----

  private addMonster(): void {
    if (this.dif > 4000 && Math.floor(Math.random() * 4) === 0) {
      this.newMonster(4);
    }
    if (this.dif > 1800 && Math.floor(Math.random() * 4) === 0) {
      this.newMonster(3);
    }
    const cap = Math.min(Math.ceil(this.dif / 1300), 3);
    this.newMonster(Math.floor(Math.random() * Math.max(1, cap)));
  }

  newMonster(id: number): Monster | null {
    if (id >= 0 && id < this.stats.$bads.length) {
      this.stats.$bads[id] += 1;
    }
    const sens = this.hero.x < XMAX * 0.5 ? 1 : 0;
    let m: Monster | null = null;

    switch (id) {
      case 0:
      case 1:
      case 2: {
        const view = new Container();
        const sp = makeSprite(this.assets.monster[0]);
        sp.anchor.set(0.5);
        view.addChild(sp);
        this.monsterLayer.addChild(view);
        const sol = new Soldier(view, this);
        sol.x = sens * XMAX;
        sol.y = YMAX - (2 + Math.floor(Math.random() * 6) * PLAT_ECART);
        sol.dx = Math.random() * 10;
        sol.setSens((-(sens * 2 - 1)) as 1 | -1);
        sol.setLevel(id + 1);
        m = sol;
        break;
      }
      case 3: {
        const view = new Container();
        const sp = makeSprite(this.assets.flyer[0]);
        sp.anchor.set(0.5);
        view.addChild(sp);
        this.monsterLayer.addChild(view);
        const fl = new Flyer(view, this);
        fl.x = Math.floor(Math.random() * XMAX);
        fl.y = 0;
        m = fl;
        break;
      }
      case 4: {
        const view = new Container();
        const sp = makeSprite(this.assets.tanker[0]);
        sp.anchor.set(0.5);
        view.addChild(sp);
        this.monsterLayer.addChild(view);
        const tk = new Tanker(view, this);
        tk.x = sens * XMAX;
        tk.y = YMAX - (2 + Math.floor(Math.random() * 6) * PLAT_ECART);
        m = tk;
        break;
      }
    }

    if (m) {
      this.monsterLevel += m.stLevel;
    }
    return m;
  }

  spawnBonus(px: number, py: number, id: number): void {
    if (id === 0) return;
    let actualId = id;
    if (id >= 6 && id < 9) {
      if (this.optList[id - 6]) actualId = 1;
    }
    const sp = makeSprite(this.assets.bonus[Math.max(0, Math.min(actualId - 1, BONUS_FRAMES - 1))]);
    sp.anchor.set(0.5);
    sp.x = px;
    sp.y = py;
    this.bonusLayer.addChild(sp);
    const b = new Bonus(sp, this);
    b.setId(actualId);
  }

  updateIcons(): void {
    while (this.iconList.length > 0) {
      const ic = this.iconList.pop();
      if (ic) ic.removeFromParent();
    }
    let xPos = MCW;
    for (let i = 0; i < this.optList.length; i += 1) {
      if (this.optList[i]) {
        const idx = Math.max(0, Math.min(i, ICON_FRAMES - 1));
        const sp = makeSprite(this.assets.icon[idx]);
        sp.anchor.set(1, 1);
        sp.x = xPos;
        sp.y = STAGE_HEIGHT - 4;
        xPos -= 20;
        this.hudLayer.addChild(sp);
        this.iconList.push(sp);
      }
    }
  }

  // ---- helpers ----

  checkFree(x: number, y: number): boolean {
    if (x < 0 || x >= XMAX || y < 0 || y >= YMAX) return true;
    return !this.grid[x][y].block;
  }

  getClosestMonsters(): Array<{ m: Monster; d: number }> {
    const out: Array<{ m: Monster; d: number }> = [];
    for (const m of this.mList) {
      const d = Math.max(Math.abs(m.x - this.hero.x), Math.abs(m.y - this.hero.y));
      let n = 0;
      while (n < out.length && out[n].d <= d) n += 1;
      out.splice(n, 0, { m, d });
    }
    return out;
  }

  setStarText(value: number): void {
    this.starText.text = String(value);
  }

  addScore(value: number): void {
    this.score += value;
    this.scoreText.text = String(this.score);
    this.host.updateScore(this.score);
  }

  scheduleCorpseRemoval(view: Container, frames: number, tick?: () => void): void {
    this.corpseList.push({ view, t: frames, tick });
  }

  // Source calls KKApi.gameOver(stats) on death — a platform-side hook we
  // cannot replicate. Surface the end-of-run feedback as a HUD overlay
  // showing final score and the run's terminal `dif` value (mirrors what
  // the source submits to the leaderboard). R4 noted gameOverText is added
  // but never updated; this closes that gap.
  showGameOver(): void {
    this.gameOverText.text = `GAME OVER\nSCORE ${this.score}\nDIF ${this.stats.$dif}`;
    this.host.endRun({
      score: this.score,
      secondary: { key: 'difficulty', label: 'Difficulty', value: this.stats.$dif },
    });
  }

  private updateCorpses(): void {
    for (let i = 0; i < this.corpseList.length; i += 1) {
      const c = this.corpseList[i];
      if (c.tick) c.tick();
      c.t -= TMOD;
      if (c.t <= 0) {
        c.view.removeFromParent();
        this.corpseList.splice(i, 1);
        i -= 1;
      }
    }
  }

  // ---- particles ----

  newPart(link: ParticleLink): Particle {
    let view: Sprite | Container;
    let field: Text | undefined;
    switch (link) {
      case 'partDust':
        view = makeSprite(this.assets.partDust[this.flNight ? 1 : 0]);
        (view as Sprite).anchor.set(0.5);
        break;
      case 'partSmoke':
        view = makeSprite(this.assets.partSmoke[0]);
        (view as Sprite).anchor.set(0.5);
        break;
      case 'partLight':
        view = makeSprite(this.assets.partLight[0]);
        (view as Sprite).anchor.set(0.5);
        break;
      case 'partSpark':
        view = makeSprite(this.assets.partSpark[0]);
        (view as Sprite).anchor.set(0.5);
        break;
      case 'partCircle':
        view = makeSprite(this.assets.partCircle);
        (view as Sprite).anchor.set(0.5);
        break;
      case 'mcScore': {
        // Source's mcScore is a MovieClip wrapping a graphic + a TextField
        // named "field" centred on the graphic. Re-create that here so
        // Bonus.addScore can write the localized score number into the field.
        const wrap = new Container();
        const sprite = makeSprite(this.assets.score);
        sprite.anchor.set(0.5);
        wrap.addChild(sprite);
        const text = new Text({
          text: '',
          style: {
            fontFamily: 'Arial, sans-serif',
            fontSize: 10,
            fontWeight: 'bold',
            fill: 0xffffff,
            stroke: { color: 0x000000, width: 2 },
            align: 'center',
          },
        });
        text.anchor.set(0.5);
        // Source's TextField "field" is positioned by the FLA — we centre on
        // the score graphic (close to its native art layout).
        text.position.set(0, 0);
        wrap.addChild(text);
        view = wrap;
        field = text;
        break;
      }
      case 'mcNinjaShot':
        view = makeSprite(this.assets.ninjaShot[0]);
        (view as Sprite).anchor.set(0.5);
        break;
      case 'partQueue':
        // Source references partQueue but no asset exists in the SWF — we
        // substitute partLight as a fallback. See FIDELITY.md.
        view = makeSprite(this.assets.partLight[0]);
        (view as Sprite).anchor.set(0.5);
        break;
    }
    this.partsLayer.addChild(view);
    const p: Particle = {
      view,
      vx: 0,
      vy: 0,
      vs: null,
      vr: null,
      weight: null,
      frict: 0.95,
      t: null,
      ft: 0,
      scale: 100,
      flQueue: false,
      wt: 0,
      visible: true,
      field,
    };
    this.pList.push(p);
    return p;
  }

  private updateParts(): void {
    for (let i = 0; i < this.pList.length; i += 1) {
      const p = this.pList[i];
      if (p.wt > 0) {
        p.wt -= TMOD;
        if (p.wt <= 0) {
          p.view.visible = true;
          p.visible = true;
        }
        continue;
      }
      if (p.weight !== null) p.vy += p.weight * TMOD;
      if (p.frict !== null) {
        p.vx *= p.frict;
        p.vy *= p.frict;
      }
      if (p.vs !== null) {
        const s = p.view.scale.x + (p.vs * TMOD) / 100;
        p.view.scale.set(Math.max(0, s));
      }
      if (p.vr !== null) {
        p.view.rotation += p.vr * TMOD;
      }
      p.view.x += p.vx * TMOD;
      p.view.y += p.vy * TMOD;

      if (p.t !== null) {
        p.t -= TMOD;
        if (p.t < 0) {
          p.view.removeFromParent();
          this.pList.splice(i, 1);
          i -= 1;
          continue;
        } else if (p.t < 10) {
          if (p.ft === 0) {
            const s = (p.scale / 100) * (p.t / 10);
            p.view.scale.set(s);
          } else {
            p.view.alpha = Math.max(0, p.t / 10);
          }
        }
      }
    }
  }

  destroy(): void {
    // Release per-entity GPU filters (white-flash on monsters, super-mode pulse
    // on hero). Pixi v8 doesn't walk filters when destroying a Container, so we
    // must release them explicitly to avoid leaking GPU programs across remounts.
    this.mList.forEach((m) => m.releaseFilters());
    if (this.hero) this.hero.releaseFilters();
    // Detach + destroy night-mode parallax filters.
    for (const info of this.planList) {
      if (info.mc.filters && (info.mc.filters as unknown as unknown[]).length > 0) {
        info.mc.filters = [];
      }
    }
    this.nightFilters.forEach((f) => f.destroy());
    this.nightFilters.length = 0;
    // Remove all children & references.
    this.pList.forEach((p) => p.view.removeFromParent());
    this.pList.length = 0;
    this.iconList.forEach((ic) => ic.removeFromParent());
    this.iconList.length = 0;
    this.bgLayer.removeChildren();
    this.worldLayer.removeChildren();
    this.bgBackLayer.removeChildren();
    this.bgFrontLayer.removeChildren();
    this.hudLayer.removeChildren();
    this.mList.length = 0;
    this.sList.length = 0;
    this.nsList.length = 0;
    this.bList.length = 0;
    this.platList.length = 0;
    this.planList.length = 0;
    this.corpseList.forEach((c) => c.view.removeFromParent());
    this.corpseList.length = 0;
  }
}
