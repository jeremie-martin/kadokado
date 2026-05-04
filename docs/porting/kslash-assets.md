# K-Slash — Asset Provenance

Source SWFs:
- `WebGamesArchives/KadoKado/Games/kslash/swf/gfx.swf` (82 sprites total, 23 named)
- `WebGamesArchives/KadoKado/Games/kslash/swf/decor.swf` (4 sprites, all named)

Extracted with FFDec 26.0.0 (same recipe as linea), separated by SWF library to avoid sprite-ID collisions.

26 normalized files in `public/assets/kslash/`. Anonymous folders kept in `extracted-assets/kslash/{gfx,decor}/` for review.

## Naming convention

- `mc` prefix stripped (`mcHero` → `hero/`).
- `part` prefix kept and kebab-cased (`partLight` → `part-light/`).
- Underscores in source names treated as word separators (`hammer_supa_smoke` → `hammer-supa-smoke/`, `FXVanish` → `fx-vanish/`).

## Mapped from gfx.swf — single frame

| Canonical | Source | Notes |
|---|---|---|
| `kunai.png` | 214 / `mcKunai` | Enemy projectile |
| `part-circle.png` | 219 / `partCircle` | |
| `inter.png` | 294 / `inter` | HUD container background |
| `score.png` | 405 / `mcScore` | Score popup |
| `map-bg.png` | 407 / `mapBg` | Map background. Identical (matching MD5) to `decor/DefineSprite_5_mapBg`; kept once |

## Mapped from gfx.swf — multi-frame folders

| Canonical | Source | Frames |
|---|---|---|
| `shade/` | 183 / `mcShade` | 30 |
| `part-light/` | 186 / `partLight` | 2 |
| `icon/` | 193 / `mcIcon` | 3 |
| `part-smoke/` | 212 / `partSmoke` | 19 |
| `part-dust/` | 217 / `partDust` | 2 |
| `part-spark/` | 225 / `partSpark` | 6 |
| `tanker/` | 269 / `mcTanker` | 89 |
| `fall/` | 26 / `fall` | 14 |
| `flyer/` | 290 / `mcFlyer` | 50 |
| `ninja-shot/` | 311 / `mcNinjaShot` | 2 |
| `hammer-supa-icemeteor/` | 317 / `hammer_supa_icemeteor` | 41 |
| `hammer-supa-smoke/` | 12 / `hammer_supa_smoke` | 13 |
| `bonus/` | 330 / `bonus` | 10 |
| `part-explosion/` | 331 / `partExplosion` | 20 |
| `monster/` | 385 / `mcMonster` | 161 |
| `plat/` | 402 / `mcPlat` | 2 |
| `fx-vanish/` | 5 / `FXVanish` | 3 |
| `hero/` | 73 / `mcHero` | 150 |

## Mapped from decor.swf

| Canonical | Source | Frames |
|---|---|---|
| `bg-back.png` | 3 / `bgBack` | 1 |
| `bg-front/` | 14 / `bgFront` | 3 |
| `bg/` | 19 / `bg` | 2 |

## Brief mismatches

- The brief's `mcMonster` is described as "Soldier/Runner/Tanker sprite" — but `gfx.swf` has separate `mcMonster` (161 frames) and `mcTanker` (89 frames). They are distinct sprites, not parent/child. The Soldier/Runner variants are likely state/frame indices inside `mcMonster`. Porting agent should inspect frame indices vs. `Cs.mt` ST_* state constants to confirm.
- Brief lists `partQueue` — not present in either SWF. Likely the brief inferred a name; check during port whether it's referenced as a literal MC name in source or whether a different sprite serves the role.
- `hammer_supa_*` (smoke + icemeteor) are extras not on the brief's list — kept; appear to be hammer/super-mode visual FX.

## Pivots
Not yet exported as SVG. Defer until needed.
