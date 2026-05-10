import { Fragment } from 'react';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SIZE = 92;

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  lineHeight: 1,
  fontWeight: 500,
  color: 'rgba(255, 255, 255, 0.65)',
  textTransform: 'uppercase',
  letterSpacing: 4,
  alignSelf: 'baseline',
};

const valueStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: FONT_SIZE,
  lineHeight: 1,
  fontWeight: 800,
  color: '#fff',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -2,
  textShadow: '0 4px 24px rgba(0, 0, 0, 0.4)',
  alignSelf: 'baseline',
};

export const HeightLine: React.FC<{ heightM: number }> = ({ heightM }) => {
  return (
    <Fragment>
      <span style={labelStyle}>Height</span>
      <span style={valueStyle}>{heightM.toLocaleString('en-US')}m</span>
    </Fragment>
  );
};
