// HUD readout for the previous run's high score — stacked under the live
// score on the top band. Renders muted by default ("reference info, not
// the actor"), gains a warm glow + brighter alpha as the live score
// approaches the threshold (see useHighScoreState in scoreSignals).
//
// Same baseline-size compensation as ScoreLine: value font-size is bumped
// a few px above the label to offset the bold-weight optical compression.

import { Fragment } from 'react';
import { clamp01 } from '../scoreSignals';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const LABEL_FONT_SIZE = 80;
const VALUE_FONT_SIZE = 86;

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: LABEL_FONT_SIZE,
  lineHeight: 1,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: 4,
  alignSelf: 'baseline',
};

const baseValueStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: VALUE_FONT_SIZE,
  lineHeight: 1,
  fontWeight: 700,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -2,
  textShadow: '0 4px 14px rgba(0, 0, 0, 0.5)',
  alignSelf: 'baseline',
  display: 'inline-block',
  transformOrigin: 'left center',
  willChange: 'transform, filter, color, opacity',
};

export const HighScoreLine: React.FC<{
  highScore: number;
  // [0, 1] — ramps up as the live score approaches the high. Drives the
  // alpha, warm glow, and a tiny scale bump on the readout. 0 below the
  // approach threshold, 1 at the crossing.
  approachLevel?: number;
}> = ({ highScore, approachLevel = 0 }) => {
  const a = clamp01(approachLevel);
  // Alpha lerps 0.45 (muted reference) → 1.00 (full presence at threshold).
  const alpha = 0.45 + 0.55 * a;
  // Color lerp white(255,255,255) → soft gold(255,220,150) at peak.
  const r = 255;
  const g = Math.round(255 - (255 - 220) * a);
  const b = Math.round(255 - (255 - 150) * a);
  // Glow grows in matching warm tone, peaks at (32 px, 0.75 opacity).
  const glowBlur = 32 * a;
  const glowOpacity = 0.75 * a;
  const filter =
    glowBlur > 0.1
      ? `drop-shadow(0 0 ${glowBlur.toFixed(1)}px rgba(255, 220, 150, ${glowOpacity.toFixed(3)}))`
      : undefined;
  // Slightly bigger scale bump than before for "ignited" presence.
  const scale = 1 + 0.05 * a;

  return (
    <Fragment>
      <span style={{ ...labelStyle, color: `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})` }}>
        High
      </span>
      <span
        style={{
          ...baseValueStyle,
          color: `rgba(${r}, ${g}, ${b}, ${Math.min(1, alpha + 0.1).toFixed(3)})`,
          filter,
          transform: `scale(${scale.toFixed(4)})`,
        }}
      >
        {highScore.toLocaleString('en-US')}
      </span>
    </Fragment>
  );
};
