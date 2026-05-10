// HUD readout for the previous run's high score — stacked under the live
// score on the top band. Renders muted by default ("reference info, not
// the actor"), gains a white glow + brighter alpha as the live score
// approaches the threshold, then fades out via `opacity` once the
// crossing fires (see useHighScoreState in scoreSignals).
//
// Same baseline-size compensation as ScoreLine: value font-size is bumped
// a few px above the label to offset the bold-weight optical compression.
//
// Renders even at opacity 0 (returns transparent spans rather than null)
// so the grid row keeps its space — prevents the score from jolting back
// to vertical center the moment HIGH finishes fading after the crossing.

import { Fragment } from 'react';

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
  opacity?: number;
  // [0, 1] — ramps up as the live score approaches the high. Drives the
  // alpha, white glow, and a tiny scale bump on the readout. 0 below the
  // approach threshold, 1 at the crossing, 0 again post-crossing.
  approachLevel?: number;
}> = ({ highScore, opacity = 1, approachLevel = 0 }) => {
  const a = Math.max(0, Math.min(1, approachLevel));
  // Alpha lerps from 0.45 (muted reference) to 0.85 (active challenge).
  const alpha = 0.45 + 0.4 * a;
  // White glow builds from 0 to (20 px blur, 0.55 opacity) at the threshold.
  const glowBlur = 20 * a;
  const glowOpacity = 0.55 * a;
  const filter =
    glowBlur > 0.1
      ? `drop-shadow(0 0 ${glowBlur.toFixed(1)}px rgba(255, 255, 255, ${glowOpacity.toFixed(3)}))`
      : undefined;
  // Tiny scale bump — keeps tabular alignment, just adds presence.
  const scale = 1 + 0.03 * a;

  return (
    <Fragment>
      <span style={{ ...labelStyle, color: `rgba(255, 255, 255, ${alpha.toFixed(3)})`, opacity }}>
        High
      </span>
      <span
        style={{
          ...baseValueStyle,
          color: `rgba(255, 255, 255, ${(alpha + 0.1).toFixed(3)})`,
          filter,
          transform: `scale(${scale.toFixed(4)})`,
          opacity,
        }}
      >
        {highScore.toLocaleString('en-US')}
      </span>
    </Fragment>
  );
};
