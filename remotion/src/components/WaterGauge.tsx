import { Fragment } from 'react';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const FONT_SIZE = 92;

// World-px-per-meter (game uses 5 world units per displayed meter; matches
// `heightMeters = maxHeight * 0.2` in Interwheel).
const PX_PER_METER = 5;

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

export const WaterGauge: React.FC<{ waterY: number; blobY: number }> = ({
  waterY,
  blobY,
}) => {
  // World coords: smaller Y = up. Distance above water in meters.
  const distanceMeters = Math.max(0, Math.floor((waterY - blobY) / PX_PER_METER));
  const text = distanceMeters > 0 ? `−${distanceMeters}m` : '0m';

  return (
    <Fragment>
      <span style={labelStyle}>Water</span>
      <span style={valueStyle}>{text}</span>
    </Fragment>
  );
};
