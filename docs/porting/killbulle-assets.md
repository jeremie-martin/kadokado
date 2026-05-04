# Killbulle — Asset Provenance

Source SWF: `WebGamesArchives/KadoKado/Games/killbulle/swf/gfx.swf`.
Extracted with FFDec 26.0.0 (same recipe as linea).

9 of 53 sprite folders normalized (8 brief-listed + 1 extra named `fall`). 44 anonymous folders kept in `extracted-assets/killbulle/` for review.

## Mapped (named symbols)

| Canonical name | Source DefineSprite | Frames | Notes |
|---|---|---|---|
| `bg.png` | 172 / `bg` | 1 | Static background |
| `bg2.png` | 169 / `bg2` | 1 | Parallax layer |
| `hero/` | 166 / `hero` | 7 | Hero state poses; the per-state animation atlas likely lives in an anonymous sub-clip — see below |
| `blob/` | 74 / `blob` | 18 | Enemy blob with `col` color-transform child |
| `corde/` | 102 / `corde` | 7 | Rope segments. Brief said "scales vertically" implying single graphic; SWF has 7 frames — keep all |
| `grapin/` | 39 / `grapin` | 2 | Frame 1 normal, frame 2 super-grapin |
| `bonus/` | 29 / `bonus` | 4 | Frames 1–4: time, super, shuriken, points |
| `anim-explose/` | 94 / `animExplose` | 13 | Explosion animation |
| `fall/` | 116 / `fall` | 14 | Extra — not on brief's list, kept |

## Hero sub-clip flag

The brief states hero has a sub-MovieClip `sub` containing idle (frame 1) + walk cycle (frames 2+). The extracted `hero/` only has 7 frames — likely those are 7 state poses, not the full animation reel. The actual animation atlas is probably one of these anonymous high-frame-count sprites (kept in `extracted-assets/killbulle/`):

| Source | Frames | Likely role (guess only) |
|---|---|---|
| `DefineSprite_26` | 41 | Hero animation atlas candidate (largest single-symbol frame count) |
| `DefineSprite_28` | 30 | |
| `DefineSprite_21` | 30 | |
| `DefineSprite_16` | 30 | |
| `DefineSprite_11` | 30 | |
| `DefineSprite_129` | 26 | |
| `DefineSprite_161` | 21 | |
| `DefineSprite_141` | 20 | |

**Action for porting agent:** during port, if hero animation looks too coarse with only 7 frames, sample the candidates above (start with `DefineSprite_26`) — the right one will visibly contain the hero walk cycle. Document the find and add a line here.

## Pivots
Not yet exported as SVG. Defer until needed.
