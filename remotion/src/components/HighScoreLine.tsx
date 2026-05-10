// HUD readout for the previous run's high score — sits on the right of the
// top band, mirrored against ScoreLine on the left. Renders in a muted
// half-alpha style so it reads as reference info rather than competing with
// the live score readout. Fades out via the `opacity` prop when the current
// score crosses the previous high (see useHighScoreState in scoreSignals).
//
// Smaller font than ScoreLine (80 vs 104 px) — visual hierarchy puts the
// live score first; the HIGH is the bar to beat, not the actor.

import { Fragment } from 'react';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SIZE = 80;

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  lineHeight: 1,
  fontWeight: 500,
  color: 'rgba(255, 255, 255, 0.45)',
  textTransform: 'uppercase',
  letterSpacing: 4,
  alignSelf: 'baseline',
};

const valueStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  lineHeight: 1,
  fontWeight: 700,
  color: 'rgba(255, 255, 255, 0.55)',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -2,
  textShadow: '0 4px 14px rgba(0, 0, 0, 0.5)',
  alignSelf: 'baseline',
};

export const HighScoreLine: React.FC<{
  highScore: number;
  opacity?: number;
}> = ({ highScore, opacity = 1 }) => {
  if (opacity <= 0) return null;
  return (
    <Fragment>
      <span style={{ ...labelStyle, opacity }}>High</span>
      <span style={{ ...valueStyle, opacity }}>{highScore.toLocaleString('en-US')}</span>
    </Fragment>
  );
};
