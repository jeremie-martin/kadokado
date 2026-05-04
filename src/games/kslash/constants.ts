// K-Slash constants — direct translation of `Cs.mt` and the depth/grid
// constants from `Game.mt`. Numbers preserved verbatim from the source.

export const STAGE_WIDTH = 300;
export const STAGE_HEIGHT = 300;

// Brief: 40 FPS is tentative (not source-confirmed). Brief authorizes
// Ruffle calibration; we keep STEP_SECONDS = 1/40 until verified.
export const FPS = 40;
export const STEP_SECONDS = 1 / FPS;
// Each fixed step counts as one frame at the target FPS — physics constants
// from the source are scaled by Timer.tmod which is 1.0 per step.
export const TMOD = 1;

export const SIZE = 24;
export const PLAT_ECART = 4;

// State enum (used by hero, monsters, projectiles via state machines).
export const ST_NORMAL = 0;
export const ST_CLIMB = 1;
export const ST_FLY = 2;
export const ST_DEATH = 3;
export const ST_SHOOT = 4;

// Power-up option indices.
export const OPT_KATANA = 0;
export const OPT_FLAMES = 1;
export const OPT_SCROLL = 2;

// Cs.mcw / Cs.mch.
export const MCW = STAGE_WIDTH;
export const MCH = STAGE_HEIGHT;

// World/grid dimensions (Game.XMAX / Game.YMAX).
export const XMAX = 25;
export const YMAX = 25;

// Score constants. Source uses KKApi.const(N) which is a pass-through.
export const C0 = 0;
export const C10 = 10;
export const C30 = 30;
export const C50 = 50;
export const C100 = 100;
export const C120 = 120;
export const C200 = 200;
export const C300 = 300;
export const C1000 = 1000;
export const C5000 = 5000;
export const C8000 = 8000;

// Depth-plane constants (Game.DP_*). Used as z-order tiers in our composite.
export const DP_BG = 1;
export const DP_BACK = 2;
export const DP_MAP = 3;
export const DP_FRONT = 4;
export const DP_INTER = 5;

export const DP_MAPBG = 1;
export const DP_DECOR = 2;
export const DP_SHADE = 3;
export const DP_BONUS = 4;
export const DP_MONSTER = 5;
export const DP_HERO = 7;
export const DP_SHOOT = 10;
export const DP_PARTS = 12;

// Asset frame counts (verified in public/assets/kslash/*).
export const HERO_FRAMES = 150;
export const MONSTER_FRAMES = 161;
export const TANKER_FRAMES = 89;
export const FLYER_FRAMES = 50;
export const BONUS_FRAMES = 10;
export const SHADE_FRAMES = 30;
export const FALL_FRAMES = 14;
export const NINJA_SHOT_FRAMES = 2;
export const ICON_FRAMES = 3;
export const PLAT_FRAMES = 2;
// R23: source's mcPlat is a 3-piece composition (DefineSprite 402 in gfx.swf).
// `Game.setPlat` writes `mc.mask._xscale = (o.w*SIZE)-2*c` and `mc.corner._x =
// mask._xscale + c` with c = 19. Body sprite (390 day / 397 night) is masked
// from x=c to x=(w*SIZE)-c; mirrored left corner (394 day / 401 night) sits
// at x=c flipped; right corner (also 394/401) is at x=(w*SIZE)-c. We extract
// the inset constant verbatim — it controls how much of the corner overhangs
// the platform body and is used by the runtime body width math.
export const PLAT_CORNER_INSET = 19;
export const BG_FRAMES = 2;
export const BG_FRONT_FRAMES = 3;
export const PART_LIGHT_FRAMES = 2;
export const PART_DUST_FRAMES = 2;
export const PART_SPARK_FRAMES = 6;
export const PART_SMOKE_FRAMES = 19;
// R20: bfx slash flash sprite — 3 frames extracted from DefineSprite 29 of
// gfx.swf (frames 2..4 of the source MovieClip; source's `gotoAndPlay("2")`
// plays exactly those three frames before the clip loops back to the empty
// frame 1). Each frame is 50×45 px white crescent at decreasing alpha.
export const BFX_FRAMES = 3;

export const ASSET_ROOT = '/assets/kslash';

// Hero-specific tunables (Hero.mt).
export const HERO_SPEED = 5;
export const HERO_SPEED_SUPER = 9;
export const HERO_JUMP_EXTEND = 3;
export const HERO_JUMP_START = 8;
export const HERO_STAR_SPEED = 14;
export const HERO_QUEUE_SPACE = 5;

// Game-loop tunables (Game.mt).
export const MONSTER_LEVEL_RAMP = 0.0025;
export const DIF_RAMP = 1.5;
export const MONSTER_LEVEL_MAX_INIT = 2;

// NIGHT_CODE: ASCII codes for "NIGHT". Source listens for these keys via
// Key.getCode() and toggles night mode if the sequence is entered.
export const NIGHT_CODE = [78, 73, 71, 72, 84];

// Bonus pickup IDs.
export const BONUS_ID_NONE = 0;
export const BONUS_ID_SCORE_COMMON = 1;
export const BONUS_ID_SCORE_RARE = 2;
export const BONUS_ID_SCORE_ULTRA = 3;
export const BONUS_ID_STAR_SMALL = 4;
export const BONUS_ID_STAR_LARGE = 5;
export const BONUS_ID_OPT_KATANA = 6;
export const BONUS_ID_OPT_FLAMES = 7;
export const BONUS_ID_OPT_SCROLL = 8;
export const BONUS_ID_FLYER_BURST = 9;
export const BONUS_ID_SUPER = 10;
