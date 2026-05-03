# Linea — Asset Provenance

Source SWF: `WebGamesArchives/KadoKado/Games/linea/swf/gfx.swf`.
Extracted with FFDec 26.0.0:
```
java -jar tools/ffdec/ffdec-cli.jar -config parallelSpeedUp=0 -ignorebackground \
  -format sprite:png -export sprite extracted-assets/linea <gfx.swf>
```

All 17 named DefineSprite symbols from `gfx.swf` were normalized into `public/assets/linea/`. None were dropped.

| Canonical name | Source DefineSprite | Frames | On brief's expected list? |
|---|---|---|---|
| `part.png` | 16 / `mcPart` | 1 | yes |
| `bonus-combo.png` | 22 / `mcBonusCombo` | 1 | yes |
| `line-score.png` | 25 / `mcLineScore` | 1 | yes |
| `bonus-score.png` | 29 / `mcBonusScore` | 1 | yes |
| `solo-bonus.png` | 31 / `mcSoloBonus` | 1 | extra |
| `start.png` | 35 / `mcStart` | 1 | yes |
| `ui.png` | 43 / `mcUI` | 1 | yes |
| `border.png` | 45 / `mcBorder` | 1 | yes |
| `comet.png` | 48 / `mcComet` | 1 | extra |
| `back.png` | 51 / `mcBack` | 1 | yes |
| `ani-circle-1.png` | 53 / `mcAnicircle1` | 1 | extra |
| `add-line.png` | 56 / `mcAddline` | 1 | yes (brief uses `mcAddLine`; SWF export name is `mcAddline`) |
| `bonus/` | 32 / `mcBonus` | 2 | yes |
| `square/` | 7 / `mcSquare` | 4 | yes |
| `bonus-parts/` | 14 / `mcBonusParts` | 6 | yes |
| `ani-glow/` | 54 / `mcAniglow` | 12 | extra |
| `bg/` | 57 / `mcBg` | 120 | flagged — see below |

## Notes

- **Runtime text templates:** `templates/ui-template.png`, `templates/bonus-score-template.png`, `templates/line-score-template.png`, and `templates/bonus-combo-template.png` are derived from the corresponding FFDec PNGs with dynamic `DefineEditText` placeholder glyphs erased. Flash replaces those fields at runtime; leaving FFDec's initial text baked into the PNG causes doubled/ghosted numbers.
- **Embedded fonts:** `fonts/neuropol-score.ttf` and `fonts/neuropol-ui.ttf` are FFDec exports of the SWF's Neuropol subsets. Use them for dynamic score/x-factor text instead of browser fallback fonts.
- **Registration points:** several cropped PNG exports need non-zero Pixi pivots to match Flash MovieClip origins: `mcAddline` is centered (~21,21), `mcPart` is (2.5,15), `mcBonusScore` is (73.5,5.6), `mcLineScore` is (38.25,20.6), and `mcBonusCombo` has origin slightly above-left of its bitmap (-3,-4.5). `mcBonus` itself is a parent of four `mcSoloBonus` children at x=5.6, y=2/12/22/33.
- **`bg/` (120 frames)**: Suspicious. The expected background asset is `mcBack` (single frame). `mcBg` having 120 frames is more consistent with the SWF's main timeline being exported as a per-frame composite render than with a usable background-loop asset. The porting agent should inspect: if the frames look like the entire game scene over time (UI + background composited together), the asset is unusable and should be ignored — `back.png` is the real background. If they look like a 120-frame animated background loop, use as-is.
- **Remaining pivot caveat:** pivots above were recovered from FFDec XML bounds and verified against PNG dimensions for sprites used by the port. Unused extras (`mcComet`, `mcAnicircle1`, `mcAniglow`, `mcBg`) may still need the same treatment if they become active.
- **`mcSoloBonus`, `mcComet`, `mcAnicircle1`, `mcAniglow`** are present in the SWF but not on the brief's expected list. Kept on the assumption the brief is inferred-from-source and may have missed references; the porting agent can drop them if confirmed unused.
- The Linea brief notes "static graphics... `gfx.swf` (not included in archive; must be recreated or mocked)" — that statement is incorrect. `gfx.swf` is present in the archive at `WebGamesArchives/KadoKado/Games/linea/swf/gfx.swf` and was extracted successfully. Brief should be corrected when revisiting.
