// TEMPORARY iteration scaffold (v2) — five score-warmth treatments rendered
// in the central 1080×1080 game area so each variant gets ~200 px of vertical
// room and subtle effects are visible. The "winner" gets folded back into
// ScoreLine and this whole file + the showScoreLab prop come out.
//
// Model — both channels precomputed once over the full sidecar in useMemo,
// indexed per frame to render. O(n) once, O(1) per frame.
//
//   Warmth channel (continuous "is something happening")
//   ──────────────────────────────────────────────────────
//   Leaky integrator over Δscore[t]:
//       x[t+1] = (1 − α) · x[t] + α · Δ[t]   with α = 1 − exp(−1 / (τ·fps))
//
//   Two τ values are precomputed: 0.7 s (smooth) and 0.3 s (jumpy). Both
//   are normalized by WARMTH_NORM (= 100) and clamped to [0, 1].
//
//   Empirical from seed4200: τ=0.7 sits at p50≈19, p90≈33, p99≈122,
//   max=214 — pastilles spike clearly above the climbing baseline.
//
//   Kick channel (impulsive "got a real bonus")
//   ───────────────────────────────────────────
//   Sharp envelope ON when Δ ≥ KICK_THRESHOLD (= 100). Quadratic decay
//   over KICK_DECAY_SEC (= 0.25 s). Independent of warmth — fires only on
//   the bimodal upper tail (pastilles and finale spikes).
//
// Variants (top→bottom in the panel):
//   L1 glow                — warmth → drop-shadow glow only
//   L2 color               — warmth → white→gold lerp only
//   L3 glow + color + scale — combined warmth treatment, no kick
//   L4 + kick              — L3 plus kick (extra glow + scale + brightness)
//   L5 jumpy warmth        — L4 with τ=0.3 s on warmth (more reactive)
//
// A small live-signal strip at the top of the panel shows w₀.₇, w₀.₃, kick
// as 0..1 bars so the visual response can be cross-referenced to the input.

import { useMemo } from 'react';
import { SidecarRow } from '../sidecar';

const FONT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const VALUE_FONT_PX = 132;
const LABEL_FONT_PX = 30;
const HINT_FONT_PX = 20;
const SIGNAL_STRIP_HEIGHT = 56;

const WARMTH_NORM = 100;       // raw integrator value that maps to 1.0
const KICK_THRESHOLD = 100;    // Δscore ≥ this fires the kick
const KICK_DECAY_SEC = 0.25;   // kick envelope length

type LabSignals = {
  warmth07: number[];
  warmth03: number[];
  kickElapsed: number[]; // seconds since most recent Δ ≥ KICK_THRESHOLD
};

function computeLeaky(deltas: number[], tauSec: number, fps: number): number[] {
  const alpha = 1 - Math.exp(-1 / (tauSec * fps));
  const out = new Array(deltas.length);
  let x = 0;
  for (let i = 0; i < deltas.length; i++) {
    x = (1 - alpha) * x + alpha * deltas[i];
    out[i] = x;
  }
  return out;
}

function buildSignals(sidecar: SidecarRow[], fps: number): LabSignals {
  const n = sidecar.length;
  const deltas = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) deltas[i] = sidecar[i].score - sidecar[i - 1].score;

  const warmth07 = computeLeaky(deltas, 0.7, fps);
  const warmth03 = computeLeaky(deltas, 0.3, fps);

  const kickElapsed = new Array<number>(n);
  let lastBigFrame = -10000;
  for (let i = 0; i < n; i++) {
    if (deltas[i] >= KICK_THRESHOLD) lastBigFrame = i;
    kickElapsed[i] = (i - lastBigFrame) / fps;
  }
  return { warmth07, warmth03, kickElapsed };
}

function pulseDecay(elapsedSec: number, durationSec: number): number {
  if (elapsedSec >= durationSec || elapsedSec < 0) return 0;
  const t = elapsedSec / durationSec;
  return (1 - t) ** 2;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function formatScore(score: number): string {
  return score.toLocaleString('en-US');
}

// Lerp white(255,255,255) → gold(255,209,102).
function warmthColor(w: number): string {
  const r = 255;
  const g = Math.round(255 - (255 - 209) * w);
  const b = Math.round(255 - (255 - 102) * w);
  return `rgb(${r}, ${g}, ${b})`;
}

const baseValueStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: VALUE_FONT_PX,
  lineHeight: 1,
  fontWeight: 800,
  color: '#fff',
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -2,
  display: 'inline-block',
  transformOrigin: 'left center',
  willChange: 'transform, filter, color',
};

const baseShadow = 'drop-shadow(0 4px 14px rgba(0,0,0,0.6))';

const L1Glow: React.FC<{ score: number; w: number }> = ({ score, w }) => {
  const blur = 8 + 36 * w;
  const opacity = 0.25 + 0.55 * w;
  const filter =
    `drop-shadow(0 0 ${blur.toFixed(1)}px rgba(255, 195, 110, ${opacity.toFixed(3)})) ` +
    baseShadow;
  return <span style={{ ...baseValueStyle, filter }}>{formatScore(score)}</span>;
};

const L2Color: React.FC<{ score: number; w: number }> = ({ score, w }) => (
  <span style={{ ...baseValueStyle, color: warmthColor(w), filter: baseShadow }}>
    {formatScore(score)}
  </span>
);

const L3Combined: React.FC<{ score: number; w: number }> = ({ score, w }) => {
  const blur = 6 + 28 * w;
  const opacity = 0.2 + 0.5 * w;
  const scale = 1 + 0.025 * w;
  const filter =
    `drop-shadow(0 0 ${blur.toFixed(1)}px rgba(255, 195, 110, ${opacity.toFixed(3)})) ` +
    baseShadow;
  return (
    <span
      style={{
        ...baseValueStyle,
        color: warmthColor(w),
        filter,
        transform: `scale(${scale.toFixed(4)})`,
      }}
    >
      {formatScore(score)}
    </span>
  );
};

const TwoChannel: React.FC<{ score: number; w: number; kickEnv: number }> = ({
  score,
  w,
  kickEnv,
}) => {
  const blur = 6 + 28 * w + 22 * kickEnv;
  const opacity = clamp01(0.2 + 0.5 * w + 0.4 * kickEnv);
  const scale = (1 + 0.025 * w) * (1 + 0.06 * kickEnv);
  const brightness = 1 + 0.4 * kickEnv;
  const filter =
    `drop-shadow(0 0 ${blur.toFixed(1)}px rgba(255, 195, 110, ${opacity.toFixed(3)})) ` +
    `brightness(${brightness.toFixed(3)}) ` +
    baseShadow;
  return (
    <span
      style={{
        ...baseValueStyle,
        color: warmthColor(w),
        filter,
        transform: `scale(${scale.toFixed(4)})`,
      }}
    >
      {formatScore(score)}
    </span>
  );
};

const labelColStyle: React.CSSProperties = {
  width: 280,
  flexShrink: 0,
  paddingLeft: 60,
};
const labelTitleStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: LABEL_FONT_PX,
  fontWeight: 700,
  color: 'rgba(255, 255, 255, 0.85)',
  letterSpacing: 4,
  textTransform: 'uppercase',
  display: 'block',
};
const labelHintStyle: React.CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: HINT_FONT_PX,
  fontWeight: 500,
  color: 'rgba(255, 255, 255, 0.45)',
  marginTop: 6,
  display: 'block',
};

const VariantRow: React.FC<{
  label: string;
  hint: string;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', alignItems: 'center', minHeight: 168 }}>
    <div style={labelColStyle}>
      <span style={labelTitleStyle}>{label}</span>
      <span style={labelHintStyle}>{hint}</span>
    </div>
    <div style={{ flex: 1 }}>{children}</div>
  </div>
);

const SignalBar: React.FC<{ label: string; value: number; max?: number }> = ({
  label,
  value,
  max = 1,
}) => {
  const pct = clamp01(value / max);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
      <span
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 16,
          color: 'rgba(255,255,255,0.55)',
          fontVariantNumeric: 'tabular-nums',
          width: 110,
          letterSpacing: 1,
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 6,
          borderRadius: 3,
          background: 'rgba(255,255,255,0.08)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${(pct * 100).toFixed(1)}%`,
            height: '100%',
            background: 'rgba(255, 195, 110, 0.85)',
          }}
        />
      </div>
      <span
        style={{
          fontFamily: FONT_FAMILY,
          fontSize: 16,
          color: 'rgba(255,255,255,0.65)',
          fontVariantNumeric: 'tabular-nums',
          width: 56,
          textAlign: 'right',
        }}
      >
        {value.toFixed(2)}
      </span>
    </div>
  );
};

const SignalStrip: React.FC<{ w07: number; w03: number; kickEnv: number }> = ({
  w07,
  w03,
  kickEnv,
}) => (
  <div
    style={{
      height: SIGNAL_STRIP_HEIGHT,
      padding: '0 60px',
      display: 'flex',
      alignItems: 'center',
      gap: 32,
      borderBottom: '1px solid rgba(255,255,255,0.08)',
    }}
  >
    <SignalBar label="w  τ=0.7s" value={w07} />
    <SignalBar label="w  τ=0.3s" value={w03} />
    <SignalBar label="kick" value={kickEnv} />
  </div>
);

export const ScoreVariantsLab: React.FC<{
  sidecar: SidecarRow[] | null;
  frame: number;
  fps: number;
}> = ({ sidecar, frame, fps }) => {
  const signals = useMemo(
    () => (sidecar ? buildSignals(sidecar, fps) : null),
    [sidecar, fps],
  );
  if (!sidecar || !signals || sidecar.length === 0) return null;

  const idx = Math.min(frame, sidecar.length - 1);
  const score = sidecar[idx].score;
  const w07 = clamp01(signals.warmth07[idx] / WARMTH_NORM);
  const w03 = clamp01(signals.warmth03[idx] / WARMTH_NORM);
  const kickEnv = pulseDecay(signals.kickElapsed[idx], KICK_DECAY_SEC);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background:
          'radial-gradient(ellipse at center, #131820 0%, #08090c 100%)',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
      }}
    >
      <SignalStrip w07={w07} w03={w03} kickEnv={kickEnv} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-evenly' }}>
        <VariantRow label="L1" hint="warmth → glow">
          <L1Glow score={score} w={w07} />
        </VariantRow>
        <VariantRow label="L2" hint="warmth → color (white→gold)">
          <L2Color score={score} w={w07} />
        </VariantRow>
        <VariantRow label="L3" hint="glow + color + tiny scale">
          <L3Combined score={score} w={w07} />
        </VariantRow>
        <VariantRow label="L4" hint="L3 + kick on Δ ≥ 100">
          <TwoChannel score={score} w={w07} kickEnv={kickEnv} />
        </VariantRow>
        <VariantRow label="L5" hint="L4 with τ = 0.3 s warmth">
          <TwoChannel score={score} w={w03} kickEnv={kickEnv} />
        </VariantRow>
      </div>
    </div>
  );
};
