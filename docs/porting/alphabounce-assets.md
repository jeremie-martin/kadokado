# Alphabounce — Asset Provenance

Source SWF: `WebGamesArchives/KadoKado/Games/Alphabounce/swf/gfx.swf`.
Extracted with FFDec 26.0.0 (same recipe as linea).
Plus `bmp/side.png` from the source archive (referenced as a raster resource by the brief — copy directly when porting).

40 of 66 sprite folders normalized into `public/assets/alphabounce/` (every named sprite plus pad/block subclips recovered from anonymous definitions). 26 anonymous folders left in `extracted-assets/alphabounce/` for review.

## Naming convention used here

- `mc` prefix is stripped (matches the existing interwheel/pioupiou convention where MovieClip is the default).
- `part` prefix kept — it's a meaningful classification (particles) and the brief consistently distinguishes `mc*` (MovieClips) from `part*` (particle assets).
- camelCase → kebab-case (e.g., `mcGreenBar` → `green-bar.png`, `partLineUp` → `part-line-up.png`).

## Mapped (single frame, flat PNG)

| Canonical name | Source DefineSprite |
|---|---|
| `brush.png` | 106 / `mcBrush` |
| `debug-square.png` | 51 / `mcDebugSquare` |
| `green-bar.png` | 115 / `mcGreenBar` |
| `ice-stone.png` | 63 / `mcIceStone` |
| `javelot.png` | 40 / `mcJavelot` |
| `laser.png` | 55 / `mcLaser` |
| `onde-ray.png` | 74 / `ondeRay` |
| `option.png` | 86 / `mcOption` |
| `pad.png` | 128 / `mcPad` |
| `pad-mid-power-base/1.png` | 122 / power-pad mid base reconstructed from `DefineShape_122` |
| `pad-power/1.png` | 124 / nested pad power bar `mid.smc` |
| `part-bubble.png` | 57 / `partBubble` |
| `part-glue.png` | 180 / `partGlue` |
| `part-ice-shard.png` | 65 / `partIceShard` |
| `part-light.png` | 61 / `partLight` |
| `part-line.png` | 49 / `partLine` |
| `part-line-up.png` | 76 / `partLineUp` |
| `part.png` | 111 / `mcPart` |
| `pink-bar.png` | 113 / `mcPinkBar` |
| `quasar.png` | 178 / `mcQuasar` |
| `score.png` | 98 / `mcScore` |
| `scroll.png` | 81 / `mcScroll` |
| `title.png` | 7 / `mcTitle` |
| `title-level.png` | 4 / `mcTitleLevel` |
| `wave.png` | 59 / `mcWave` |

## Mapped (multi-frame folder)

| Canonical | Source | Frames |
|---|---|---|
| `ball/` | 152 / `mcBall` | 8 |
| `bg/` | 187 / `mcBg` | 6 |
| `blink/` | 109 / `mcBlink` | 9; runtime pivot is inside the exported sweep bounds |
| `block/` | 173 / `mcBlock` | 6 |
| `block-life/` | 164 / nested normal-block life sprite | 5 |
| `ice/` | 10 / `mcIce` | 2 |
| `onde/` | 75 / `mcOnde` | 11 |
| `pad-mid/` | 127 / `mcPad.mid` subclip | 7 |
| `pad-side/` | 119 / `mcPad.side0` / `side1` subclip | 8 |
| `part-explode/` | 34 / `partExplode` | 45 exported; runtime uses first 23 visible frames |
| `part-glass/` | 37 / `partGlass` | 2 |
| `part-spark/` | 72 / `partSpark` | 2 |
| `part-twinkle/` | 95 / `partTwinkle` | 6 |
| `protection/` | 47 / `mcProtection` | 14 |
| `shape/` | 104 / `mcShape` | 8 |
| `side/` | 91 / `mcSide` | 10 |

## Mapped Fonts

Extracted with `ffdec -format font:ttf -export font` from `gfx.swf` for runtime text fields whose PNG exports contain placeholder text:

| Canonical name | Source font |
|---|---|
| `kiloton-condensed-bold.ttf` | DefineFont3 2 / `Kiloton Condensed Italic` |
| `kiloton-condensed.ttf` | DefineFont3 96 / `Kiloton Condensed Italic` |
| `verdana-bold.ttf` | DefineFont3 79 / `verdana` |

## Brief-listed but not present in `gfx.swf`

| Brief name | Likely status |
|---|---|
| `partScore` | Floating score popup. The SWF has `mcScore` (1 frame) — the porting agent should treat that as `partScore` per brief, OR check whether `partScore` lives in a different SWF. |
| `partOnde` | Wave effect particle. SWF has `mcOnde` (11 frames) and `ondeRay` (1 frame). The brief's `partOnde` may have been an inferred name; map to `mcOnde` during port. |

## Extra raster

`bmp/side.png` from `WebGamesArchives/KadoKado/Games/Alphabounce/bmp/` is referenced by the brief and the source. Not yet copied — defer until the porting agent confirms its use vs. the extracted `side/` sprite folder.

## Pivots
Not yet exported as SVG. Defer until needed.
