# Iron Chouquette — Asset Provenance

Source SWFs:
- `WebGamesArchives/KadoKado/Games/Iron Chouquette/swf/gfx.swf` — 84 sprites, 35 named
- `WebGamesArchives/KadoKado/Games/Iron Chouquette/swf/monster.swf` — 101 sprites, 5 named (Hero/Bads/Chouquette + 2 bases)
- `WebGamesArchives/KadoKado/Games/Iron Chouquette/swf/decor.swf` — 2 sprites, both named (Bg/Planet)
- `WebGamesArchives/KadoKado/Games/Iron Chouquette/swf/temple.swf` — 184 sprites, only 1 with an export name (and that one has a malformed name `" r_qd"` with a leading space; skipped)

Plus the pre-rasterized `bmp/` folder (10 PNG/JPG files), copied directly per the brief.

Extracted with FFDec 26.0.0 (same recipe as linea), one output dir per source SWF to avoid sprite-ID collisions.

52 normalized files in `public/assets/iron-chouquette/`. The 184 anonymous sprites in `extracted-assets/iron-chouquette/temple/` are kept for review — temple.swf appears to be the level-decor library where most symbols are unnamed, and the brief mentions parallax decor is referenced from external SWFs without specific symbol names.

## Mapped from gfx.swf — single frame (10)

| Canonical | Source |
|---|---|
| `big-laser.png` | 23 / `mcBigLaser` |
| `black-hole.png` | 39 / `mcBlackHole` |
| `laser-ray.png` | 25 / `mcLaserRay` |
| `queue-standard.png` | 68 / `mcQueueStandard` |
| `round.png` | 35 / `mcRound` |
| `sonic-boom.png` | 41 / `mcSonicBoom` |
| `part-invincibility.png` | 11 / `partInvincibility` |
| `part-laser.png` | 6 / `partLaser` |
| `part-light.png` | 112 / `partLight` |
| `part-spark.png` | 99 / `partSpark` |

## Mapped from gfx.swf — multi-frame (25)

| Canonical | Source | Frames |
|---|---|---|
| `magic-ball/` | 122 / `mcMagicBall` | 2 |
| `part-black-ball/` | 155 / `partBlackBall` | 2 |
| `part-magic-spark/` | 115 / `partMagicSpark` | 2 |
| `explo-trace/` | 66 / `mcExploTrace` | 3 |
| `part-paillette/` | 96 / `partPaillette` | 3 |
| `part-ray/` | 4 / `partRay` | 3 |
| `onde/` | 147 / `mcOnde` | 5 |
| `shield/` | 125 / `mcShield` | 5 |
| `speed/` | 57 / `mcSpeed` | 5 |
| `part-static/` | 54 / `partStatic` | 5 |
| `icon/` | 141 / `mcIcon` | 6 |
| `slot/` | 77 / `mcSlot` | 7 |
| `mini-explo/` | 152 / `mcMiniExplo` | 8 |
| `laser-light/` | 9 / `mcLaserLight` | 9 |
| `part-black-hole/` | 33 / `partBlackHole` | 9 |
| `explo-part/` | 64 / `mcExploPart` | 10 |
| `part-score/` | 29 / `partScore` | 11 |
| `part-concentrate/` | 92 / `partConcentrate` | 13 |
| `part-impact/` | 91 / `partImpact` | 14 |
| `queue-magic-ball/` | 118 / `queueMagicBall` | 16 |
| `part-spark-speed/` | 49 / `partSparkSpeed` | 17 |
| `queue-rocket/` | 144 / `queueRocket` | 19 |
| `part-plasma-bolt/` | 44 / `partPlasmaBolt` | 20 |
| `shot/` | 236 / `mcShot` | 23 |
| `bonus/` | 110 / `mcBonus` | 28 |

## Mapped from monster.swf (5)

| Canonical | Source | Frames |
|---|---|---|
| `base1.png` | 33 / `base1` | 1 |
| `base2.png` | 63 / `base2` | 1 |
| `chouquette/` | 77 / `mcChouquette` | 6 |
| `bads/` | 336 / `mcBads` | 20 |
| `hero/` | 15 / `mcHero` | 20 |

## Mapped from decor.swf (2)

| Canonical | Source |
|---|---|
| `bg-vector.png` | 6 / `mcBg` (renamed to `bg-vector` to avoid collision with `bmp/bg.jpg`) |
| `planet.png` | 3 / `mcPlanet` |

## Pre-rasterized rasters from bmp/ (10) — copied directly

| File | Brief role |
|---|---|
| `bg.jpg` | Parallax background, tiled vertically with scroll |
| `space_rabbit.png` | Hero primary sprite |
| `omega_body.png`, `omega_turn.png` | Omega enemy (type 1) sprite sheets |
| `blackron.png` | Blackron enemy sheet |
| `furia.png` | Furia enemy sheet |
| `steack.png` | Aggregated sheet (Gromph, Block, etc.) |
| `orbs.png`, `unorbs.png` | Bonus orb visuals |
| `psx_pad.png` | Control prompt / HUD |

## Brief mismatches

- `partDebris` listed in brief but not present in any extracted SWF. Likely an inferred name; if a literal MC reference exists in source, the porting agent should grep `Bads.mt` / `Phys.mt` / `Hero.mt` for `attach("partDebris"` to confirm and either map to one of the existing `part-*` folders or flag.
- `mcChouquette` (6 frames) is in `monster.swf` but not on the brief's list — it's the boss/title character (the namesake). Kept.

## Anonymous temple.swf

`temple.swf` is the largest of the four (184 sprites, ~338 KB) and is almost entirely anonymous — only one symbol has an export name and that name is malformed. The brief notes parallax decor lives in external SWF libraries without specific named symbol references, which matches: `temple.swf` is likely the level-decor library accessed by sprite ID rather than name.

For the porting agent: temple-decor will need either visual inspection to pick relevant frames, or a code-side approach where decor sprites are referenced by numeric ID and the asset folder grows incrementally as specific tiles are needed.

## Pivots
Not yet exported as SVG. Defer until needed. The high-frame-count sprites (`hero/` 20, `bads/` 20, `bonus/` 28, `shot/` 23) are likely the first ones that will need pivot inspection during port.
