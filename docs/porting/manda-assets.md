# Manda — Asset Provenance

Source SWF: `WebGamesArchives/KadoKado/Games/manda/swf/gfx.swf`.
Extracted with FFDec 26.0.0 (same recipe as linea).

10 of 18 sprite folders normalized into `public/assets/manda/` (8 brief-listed + 2 extras with meaningful export names). 8 anonymous folders kept in `extracted-assets/manda/` and flagged below for review.

## Mapped (named symbols)

| Canonical name | Source DefineSprite | Frames | Notes |
|---|---|---|---|
| `bg.png` | 283 / `bg` | 1 | |
| `bg-mask.png` | 275 / `bgMask` | 1 | Play-area mask (~294×264) |
| `jackpot-mask.png` | 229 / `jackpotMask` | 1 | Slot-machine viewport mask |
| `qparticule.png` | 227 / `qparticule` | 1 | Explosion particle |
| `jackpot.png` | 279 / `jackpot` | 1 | Slot-machine frame |
| `bonus/` | 22 / `bonus` | 23 | Brief inferred 8 frames; SWF ground truth is 23 |
| `fruit/` | 225 / `fruit` | 24 | Brief inferred 8 frames; SWF ground truth is 24 — likely the parent picker, with the 201-frame variant in `fruit-type/` |
| `fruit-type/` | 224 / `fruit_type` | 201 | The 201-frame fruit ID atlas the brief mentioned (sub-clip `f`) |
| `score-digit/` | 261 / `scoreDigit` | 41 | Brief expected 10 (digits 0–9); 41 frames suggests states + colors or similar |
| `tete/` | 273 / `tete` | 20 | Brief inferred 2 frames (normal/invincible); SWF ground truth is 20 — likely 10 angles × 2 states or animated head |

## Frame-count corrections to brief

The Manda brief inferred frame counts from the source code's `gotoAndStop()` references; SWF reality differs in three places:
- `tete`: brief says 2 frames; SWF has 20.
- `bonus`: brief says 8 frames; SWF has 23.
- `fruit`: brief says 8-frame picker with 201-frame sub-clip; SWF has 24-frame parent + 201-frame `fruit_type`.

Use SWF counts during porting, not brief counts.

## Not mapped (anonymous DefineSprite folders)

| Source | Frames | Likely role (guess only) |
|---|---|---|
| `DefineSprite_3` | 21 | Possibly snake body segment animation |
| `DefineSprite_13` | 15 | Possibly fruit-type sub-graphic |
| `DefineSprite_18` | 1 | Sub-shape |
| `DefineSprite_21` | 8 | Possibly bonus-icon sub-clip |
| `DefineSprite_264` | 1 | Sub-shape |
| `DefineSprite_265` | 12 | Possibly UI/score animation |
| `DefineSprite_267` | 1 | Sub-shape |
| `DefineSprite_282` | 1 | Sub-shape |

These are kept available in `extracted-assets/manda/`. The porting agent should review during port — if a referenced symbol turns out to live in one of these (e.g., snake body), map it then.

## Pivots
Not yet exported as SVG. Defer to porting agent.
