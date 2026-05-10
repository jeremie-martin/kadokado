// HUD score readout with the validated L5 pulse treatment baked in:
//
//   - Color lerps white → gold (#ffd166) as warmth rises.
//   - Filter chain: warm drop-shadow glow (blur + opacity scale with warmth
//     and kick), brightness boost on kick, depth shadow underneath.
//   - Tiny scale pop: ±2.5% on warmth, +6% impulse on kick (only ≥100-Δ
//     "events" so it stays rare).
//   - Tabular numerals — no digit-shape jitter.
//
// Pulse state arrives precomputed by useScorePulseState in scoreSignals.ts;
// this component is purely presentational.

import { Fragment } from 'react';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
// Label and value differ by ~13% on font-size to compensate for the bold
// weight (800) optically compressing digits vs the medium (500) label —
// this is what makes the *baseline* score visually equal to its label.
// Effects (warmth, kick) scale the value above this baseline.
const LABEL_FONT_SIZE = 104;
const VALUE_FONT_SIZE = 112;

// Lerp white(255,255,255) → gold(255, 209, 102) by warmth ∈ [0, 1].
function warmthColor(warmth: number): string {
  const r = 255;
  const g = Math.round(255 - (255 - 209) * warmth);
  const b = Math.round(255 - (255 - 102) * warmth);
  return `rgb(${r}, ${g}, ${b})`;
}

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: LABEL_FONT_SIZE,
  lineHeight: 1,
  fontWeight: 500,
  color: 'rgba(255, 255, 255, 0.65)',
  textTransform: 'uppercase',
  letterSpacing: 4,
  alignSelf: 'baseline',
};

const baseValueStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: VALUE_FONT_SIZE,
  lineHeight: 1,
  fontWeight: 800,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -2,
  alignSelf: 'baseline',
  display: 'inline-block',
  transformOrigin: 'left center',
  willChange: 'transform, filter, color',
};

export const ScoreLine: React.FC<{
  score: number;
  warmth?: number;
  kickEnv?: number;
  label?: string;
  // When true, the value's transform-origin is recentered so kick scaling
  // grows symmetrically rather than from the left edge — matters when the
  // value is rendered inside a horizontally-centered layout (post-crossing
  // "NEW BEST" state).
  centered?: boolean;
}> = ({ score, warmth = 0, kickEnv = 0, label = 'Score', centered = false }) => {
  const blur = 6 + 28 * warmth + 22 * kickEnv;
  const glowOpacity = Math.min(1, 0.2 + 0.5 * warmth + 0.4 * kickEnv);
  const scale = (1 + 0.025 * warmth) * (1 + 0.06 * kickEnv);
  const brightness = 1 + 0.4 * kickEnv;
  const filter =
    `drop-shadow(0 0 ${blur.toFixed(1)}px rgba(255, 195, 110, ${glowOpacity.toFixed(3)})) ` +
    `brightness(${brightness.toFixed(3)}) ` +
    'drop-shadow(0 4px 14px rgba(0, 0, 0, 0.6))';

  return (
    <Fragment>
      <span style={labelStyle}>{label}</span>
      <span
        style={{
          ...baseValueStyle,
          color: warmthColor(warmth),
          filter,
          transform: `scale(${scale.toFixed(4)})`,
          transformOrigin: centered ? 'center center' : 'left center',
        }}
      >
        {score.toLocaleString('en-US')}
      </span>
    </Fragment>
  );
};
