// TEMPORARY iteration scaffold — five score-pulse treatments rendered side
// by side so a single render exposes all candidates simultaneously. The
// "winner" gets folded back into ScoreLine and the lab + the showScoreLab
// prop get deleted.
//
// Variants (in render order, top to bottom):
//   V1 plain     — control. No pulse, just the value.
//   V2 scale     — soft scale bump on every increment, ~120ms cubic decay.
//                  ±4% size — the "tasteful default".
//   V3 flash     — brightness flash (filter brightness 1 → 1.5 → 1) over
//                  ~150ms. Tests whether a luminance kick reads better than
//                  a size kick.
//   V4 tier      — thresholded: small pulse for tiny deltas, bigger pulse
//                  + warm color tint for delta ≥ 200 (pastille proxy). The
//                  derivative-aware variant from the brief.
//   V5 spring    — overshoot+settle damped sinusoid, ~400ms. Stacking on
//                  rapid increments gives a "kept hitting" feel — tests
//                  whether physical motion reads as more alive.
//
// All five share the same input data (sidecar score, current frame, fps);
// only the treatment differs. The lab walks back up to 2s through the
// sidecar to find the most recent score increment, then drives each variant
// off `(elapsedSec, delta)`. Walk is bounded to keep per-frame cost flat.

import { SidecarRow } from '../sidecar';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const VARIANT_LABEL_FONT_SIZE = 22;
const VARIANT_VALUE_FONT_SIZE = 56;
const PASTILLE_TIER_DELTA = 200;

type IncrementState = {
  elapsedSec: number;
  delta: number;
};

function findLastIncrement(
  sidecar: SidecarRow[],
  idx: number,
  fps: number,
): IncrementState {
  const lookbackFrames = Math.min(idx, fps * 2); // 2s lookback bound
  for (let i = idx; i > idx - lookbackFrames; i--) {
    if (i <= 0) break;
    const dx = sidecar[i].score - sidecar[i - 1].score;
    if (dx > 0) {
      return { elapsedSec: (idx - i) / fps, delta: dx };
    }
  }
  return { elapsedSec: 999, delta: 0 };
}

// Quadratic-decay impulse envelope: 1 at t=0, 0 at t=durationSec.
function pulseDecay(elapsedSec: number, durationSec: number): number {
  if (elapsedSec >= durationSec || elapsedSec < 0) return 0;
  const t = elapsedSec / durationSec;
  return (1 - t) ** 2;
}

// Damped cosine for the spring variant. Frequency in Hz, decay in 1/s.
function dampedSpring(elapsedSec: number, freqHz: number, decayPerSec: number): number {
  if (elapsedSec < 0) return 0;
  return Math.exp(-elapsedSec * decayPerSec) * Math.cos(elapsedSec * 2 * Math.PI * freqHz);
}

const baseValueStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: VARIANT_VALUE_FONT_SIZE,
  lineHeight: 1,
  fontWeight: 800,
  color: '#fff',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -1,
  textShadow: '0 2px 12px rgba(0, 0, 0, 0.45)',
  display: 'inline-block',
  transformOrigin: 'left center',
};

const labelStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: VARIANT_LABEL_FONT_SIZE,
  fontWeight: 600,
  color: 'rgba(255, 255, 255, 0.55)',
  textTransform: 'uppercase',
  letterSpacing: 2,
  width: 80,
  flexShrink: 0,
};

function formatScore(score: number): string {
  return score.toLocaleString('en-US');
}

function VariantRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, height: 64 }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </div>
  );
}

const V1Plain: React.FC<{ score: number }> = ({ score }) => (
  <VariantRow label="V1 plain">
    <span style={baseValueStyle}>{formatScore(score)}</span>
  </VariantRow>
);

const V2Scale: React.FC<{ score: number; inc: IncrementState }> = ({
  score,
  inc,
}) => {
  const scale = 1 + 0.04 * pulseDecay(inc.elapsedSec, 0.12);
  return (
    <VariantRow label="V2 scale">
      <span style={{ ...baseValueStyle, transform: `scale(${scale.toFixed(4)})` }}>
        {formatScore(score)}
      </span>
    </VariantRow>
  );
};

const V3Flash: React.FC<{ score: number; inc: IncrementState }> = ({
  score,
  inc,
}) => {
  const bri = 1 + 0.5 * pulseDecay(inc.elapsedSec, 0.15);
  return (
    <VariantRow label="V3 flash">
      <span style={{ ...baseValueStyle, filter: `brightness(${bri.toFixed(3)})` }}>
        {formatScore(score)}
      </span>
    </VariantRow>
  );
};

const V4Tier: React.FC<{ score: number; inc: IncrementState }> = ({
  score,
  inc,
}) => {
  const big = inc.delta >= PASTILLE_TIER_DELTA;
  const mag = big ? 0.10 : 0.04;
  const dur = big ? 0.22 : 0.10;
  const env = pulseDecay(inc.elapsedSec, dur);
  const scale = 1 + mag * env;
  // Big tier also adds a warm tint that fades with the same envelope.
  const tintStrength = big ? env : 0;
  const color = tintStrength > 0
    ? `rgb(255, ${Math.round(255 - 30 * tintStrength)}, ${Math.round(255 - 120 * tintStrength)})`
    : '#fff';
  return (
    <VariantRow label="V4 tier">
      <span
        style={{
          ...baseValueStyle,
          transform: `scale(${scale.toFixed(4)})`,
          color,
        }}
      >
        {formatScore(score)}
      </span>
    </VariantRow>
  );
};

const V5Spring: React.FC<{ score: number; inc: IncrementState }> = ({
  score,
  inc,
}) => {
  const offset = 0.08 * dampedSpring(inc.elapsedSec, 6, 6);
  const scale = 1 + offset;
  return (
    <VariantRow label="V5 spring">
      <span style={{ ...baseValueStyle, transform: `scale(${scale.toFixed(4)})` }}>
        {formatScore(score)}
      </span>
    </VariantRow>
  );
};

export const ScoreVariantsLab: React.FC<{
  sidecar: SidecarRow[] | null;
  frame: number;
  fps: number;
}> = ({ sidecar, frame, fps }) => {
  if (!sidecar || sidecar.length === 0) return null;
  const idx = Math.min(frame, sidecar.length - 1);
  const score = sidecar[idx].score;
  const inc = findLastIncrement(sidecar, idx, fps);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        justifyContent: 'center',
        height: '100%',
      }}
    >
      <V1Plain score={score} />
      <V2Scale score={score} inc={inc} />
      <V3Flash score={score} inc={inc} />
      <V4Tier score={score} inc={inc} />
      <V5Spring score={score} inc={inc} />
    </div>
  );
};
