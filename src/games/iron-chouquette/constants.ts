// Cs.mt translation: stage, scoring, helpers, hardcoded boss data.

// Stage geometry / timing.
export const STAGE_WIDTH = 300;
export const STAGE_HEIGHT = 300;
export const FPS = 40; // Source-confirmed from the SWF headers.
export const STEP_SECONDS = 1 / FPS;
// TMOD is the per-frame timestep multiplier. The original sets `Timer.tmod = bt.val`
// during bullet-time so every `*Timer.tmod` operation slows down. We mirror that by
// mutating this `let` from `IronChouquetteGame.main` before the per-tick work.
export let TMOD = 1; // each fixed step counts as one frame at the chosen FPS.
export function setTmod(v: number): void {
  TMOD = v;
}

// Cs.mt — gameplay tunings.
export const CDIF = 0.7;

// Cs.mt — score multipliers (KKApi.const passes through).
export const C5 = 5;
export const C0 = 0;
export const C500 = 500;
export const C_OMEGA = 65;
export const C_BLACKRON = 80;
export const C_FURIA = 120;
export const C_CUTTY_OPEN = 200;
export const C_MINE = 300;
export const C_BRIAROS = 350;
export const C_GROMPH = 450;
export const C_SHIELD = 500;
export const C_CUTTY_CLOSE = 600;
export const C_ORB = 800;
export const C_BLOCK = 1000;
export const C_SURGROMPH = 1500;
export const C_GERGIN = 2400;
export const C_NES = 5000;
export const C_STORM: number[] = [2000, 3500, 8000];

// Game.mt — depth planes (Pixi z-index per layer).
export const DP_INTER = 12;
export const DP_PARTS = 10;
export const DP_SHOTS = 8;
export const DP_HERO = 9;
export const DP_BADS = 7;
export const DP_DRAW = 5;
export const DP_UNDERPARTS = 3;
export const DP_BG = 2;

// Game.mt scrolling.
export const SCROLL_SPEED_INITIAL = 0.0001;
export const SCROLL_SPEED_MAX = 6;
export const PLASMA_CACHE = 100;

// Hero.mt — weapon ids.
export const WP_PLASMA = 0;
export const WP_SIDER = 1;
export const WP_LASER = 2;
export const WP_SPEED = 3;
export const WP_VOID = 4;
export const WP_MISSILE = 5;
export const HERO_RAY = 8;
export const HERO_INVINCIBLE_RAY = 32;

// Bonus probabilities (Bonus.mt STATS, IDs 0..17).
export const BONUS_STATS = [
  100, 60, 50, 70, 70, 70, 30,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

// Stykades.mt — 30 hardcoded bullet-curve paths copied verbatim.
// Each entry is a node array: [x, y] or [x, y, marker].
// markers: 0 => spawn shot at this segment for *each* enemy; 1 => spawn shot for *all* enemies once.
export const PATH: number[][][] = [
  [[-14, 16], [217, 17], [256, 24], [279, 48], [286, 82], [273, 121], [240, 144], [187, 146], [141, 122], [89, 65], [-1, -36]],
  [[89, -20], [91, 45], [114, 92], [149, 115], [168, 139], [165, 163], [145, 179], [113, 180], [72, 163], [39, 132], [22, 96], [19, 60], [35, 28], [70, 12], [141, 16], [211, 46], [270, 94], [344, 197]],
  [[114, -14], [57, 8], [28, 29], [15, 56], [11, 84], [14, 111], [30, 140], [59, 167], [96, 190], [143, 206], [194, 207], [248, 192], [284, 162], [302, 130], [313, 79], [299, 45], [259, 28], [209, 31], [156, 54], [111, 84], [77, 120], [30, 160], [-5, 178], [-50, 174]],
  [[9, -16], [12, 21], [27, 49], [58, 82], [97, 98], [150, 104], [203, 96], [243, 74], [273, 43], [288, 16], [300, -19]],
  [[315, 45], [271, 32], [232, 33], [192, 48], [166, 78], [152, 107], [156, 151], [174, 173], [209, 187], [248, 176], [269, 147], [268, 107], [238, 79], [190, 66], [134, 62], [87, 77], [49, 104], [26, 143], [22, 177], [34, 209], [70, 231], [119, 230], [159, 205], [181, 155], [182, 109], [148, 41], [106, 16], [43, 3], [-39, 4]],
  [[92, -24], [95, 17], [108, 44], [149, 78], [187, 110], [193, 143], [181, 174], [151, 198], [110, 197], [78, 179], [65, 148], [76, 112], [105, 83], [236, -30]],
  [[177, -14], [178, 39], [192, 91], [210, 113], [245, 120], [276, 105], [290, 68], [274, 33], [240, 17], [204, 33], [-15, 238]],
  [[324, 160], [291, 113], [256, 82], [212, 72], [166, 74], [123, 93], [95, 126], [88, 172], [102, 213], [131, 236], [175, 249], [218, 240], [257, 212], [275, 169], [284, 86], [285, -12]],
  [[-14, 22], [274, 22], [274, 150], [88, 150], [88, 88], [221, 88], [220, 213], [322, 213]],
  [[-31, 110], [55, 110], [55, 197], [220, 197], [220, 27], [108, 27], [108, 112], [268, 112], [268, 329]],
  [[117, -13], [116, 82], [197, 82], [197, 178], [114, 178], [113, 216], [266, 216], [266, 29], [-29, 28]],
  [[280, -22], [279, 33], [54, 32], [54, 67], [150, 68], [149, 205], [53, 205], [53, 134], [328, 134]],
  [[318, 20], [33, 21], [17, 29], [11, 44], [18, 59], [32, 69], [267, 68], [283, 75], [288, 92], [286, 328]],
  [[30, -20], [29, 90], [36, 110], [54, 117], [259, 120], [275, 133], [275, 153], [263, 173], [47, 172], [26, 182], [27, 205], [42, 215], [259, 215], [270, 232], [269, 320]],
  [[320, 76], [32, 77], [14, 67], [6, 46], [15, 24], [33, 16], [259, 17], [275, 24], [287, 40], [286, 57], [286, 313]],
  [[-22, 3], [46, 19], [87, 39], [119, 57], [207, 90], [243, 81], [257, 49], [230, 31], [182, 44], [140, 75], [73, 114], [36, 119], [6, 95], [15, 71], [42, 66], [77, 79], [102, 94], [133, 108], [163, 127], [205, 154], [250, 154], [264, 136], [242, 114], [205, 117], [165, 133], [131, 151], [38, 190], [13, 183], [15, 158], [42, 151], [65, 159], [203, 217], [247, 215], [260, 183], [225, 175], [179, 182], [32, 248], [-35, 282]],
  [[13, 308], [14, 261], [25, 234], [45, 217], [74, 202], [93, 180], [102, 152], [93, 124], [72, 108], [47, 96], [28, 80], [19, 58], [23, 34], [43, 19], [76, 15], [336, 15]],
  [[18, 324], [21, 49], [33, 25], [59, 16], [89, 29], [110, 53], [193, 147], [219, 162], [250, 169], [322, 169]],
  [[45, 324], [45, 165], [33, 147], [16, 132], [8, 113], [9, 40], [17, 26], [32, 16], [50, 12], [239, 12], [264, 22], [280, 48], [277, 77], [259, 98], [-7, 317]],
  [[-18, 280], [30, 282], [65, 278], [93, 254], [112, 217], [115, 156], [124, 124], [142, 106], [172, 99], [193, 88], [214, 68], [228, 31], [229, -32]],
  [[-28, 185], [7, 244], [28, 270], [69, 276], [108, 262], [132, 233], [144, 181], [138, 124], [114, 94], [69, 85], [23, 97], [7, 127], [13, 159], [35, 179], [64, 191], [116, 189], [183, 140], [233, 92], [287, 58], [341, 57]],
  [[-44, 71], [278, 72], [278, 180], [187, 180], [187, 19], [120, 19], [120, 97], [247, 97], [247, 135], [36, 135], [36, 55], [150, 55], [150, 153], [83, 153], [83, 18], [251, 18], [251, 54], [169, 54], [169, 153], [248, 153], [248, 72], [59, 72], [59, 176], [160, 178], [160, 30], [19, 30], [19, 188], [274, 188], [274, 112], [-44, 112]],
  [[292, -18], [282, 85], [263, 127], [239, 142], [216, 142], [188, 121], [162, 80], [136, 33], [112, 7], [87, 3], [61, 13], [38, 46], [15, 115], [-13, 255]],
  [[330, 270], [205, 270], [205, 193, 0], [281, 192], [280, 114], [-20, 115]],
  [[330, 27], [35, 25], [19, 32], [11, 46], [23, 60], [268, 131], [288, 145], [287, 161], [276, 172], [-24, 172]],
  [[330, 17], [291, 134], [249, 205], [204, 251], [135, 275], [64, 249], [23, 187], [22, 109], [68, 43], [142, 26], [206, 49], [248, 95], [289, 172], [326, 292]],
  [[333, 149], [197, 148], [95, 70], [96, 41], [116, 21], [141, 22], [157, 41], [156, 330]],
  [[306, 9], [229, 73], [171, 91], [132, 84], [107, 51], [118, 22], [151, 7], [191, 20], [202, 55], [202, 102], [187, 140], [149, 173], [79, 181], [42, 157], [36, 122], [60, 95], [95, 95], [121, 118], [120, 154], [117, 202], [120, 245], [145, 277], [178, 291], [221, 277], [277, 202], [322, 163]],
  [[351, 188], [215, 187], [142, 171], [113, 134], [114, 90], [142, 71], [175, 79], [196, 112], [227, 133], [260, 119], [268, 84], [258, 52], [227, 33], [172, 26], [114, 39], [72, 74], [54, 132], [64, 183], [94, 231], [143, 261], [208, 273], [355, 274]],
  [[-23, 17], [21, 17], [62, 25], [97, 50], [119, 88], [152, 109], [194, 109], [243, 108], [277, 121], [284, 143], [275, 168], [243, 184], [-16, 185]],
];

// Stykades.mt PROB — [monsterTypeId, difficultyThreshold].
export const PROB: number[][] = [
  [1, 0],
  [3, 300],
  [2, 400],
  [30, 700],   // MINES
  [9, 1000],   // BRIAROS
  [7, 1200],   // BLOCK
  [4, 1300],   // FURIA
  [5, 1500],   // GROMPH
  [10, 1700],  // STORM L1
  [20, 2000],  // ORB
  [17, 2000],  // 5x CUTTY
  [31, 2200],  // 5x MINES
  [33, 2400],  // SHIELD
  [16, 2600],  // BRIAROS RAVE
  [11, 2800],
  [22, 3000],  // GERGIN
  [6, 3200],   // BACK GROMPH
  [8, 3800],   // SURGROMPH
  [18, 4000],  // NES
  [12, 5000],
  [32, 6000],  // 10x MINES
  [34, 7000],  // 8x KILLER BRIAROS
];

// Helpers (Cs.mt).
export function clamp(a: number, b: number, c: number): number {
  return Math.min(Math.max(a, b), c);
}

export function sMod(v: number, mod: number): number {
  let r = v;
  while (r >= mod) r -= mod;
  while (r < 0) r += mod;
  return r;
}

export function hMod(v: number, mod: number): number {
  let r = v;
  while (r > mod) r -= mod * 2;
  while (r < -mod) r += mod * 2;
  return r;
}

export function getDist(o1: { x: number; y: number }, o2: { x: number; y: number }): number {
  const dx = o1.x - o2.x;
  const dy = o1.y - o2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function getAng(o1: { x: number; y: number }, o2: { x: number; y: number }): number {
  return Math.atan2(o1.y - o2.y, o1.x - o2.x);
}

export function randInt(n: number): number {
  if (n <= 1) return 0;
  return Math.floor(Math.random() * n);
}

export const ASSET_ROOT = '/assets/iron-chouquette';
