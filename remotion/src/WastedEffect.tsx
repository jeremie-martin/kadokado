import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from 'remotion';

// Recreates the GTA-V "WASTED" death sequence over an arbitrary base video.
//
// Phases (relative to composition T=0; audio plays from T=0 so the chord
// inside wasted.mp3 lands at audio_t = textAppearSec):
//
//   0.0–drainSec   drain     — saturation/brightness/contrast/vignette/tint
//                              ramp in. Base video plays at basePlaybackRate
//                              (constant; Remotion can't animate playback
//                              rate per frame).
//   drainSec–textAppearSec   build — held desaturated/dim, base crawls.
//   textAppearSec  impact    — text punches in (overshoot scale → 1.0) +
//                              soft warm bloom halo + chromatic-aberration
//                              ghost copies (red right / cyan left). All
//                              three accents decay quickly so the spike
//                              lasts ~200ms. No white flash, no screen
//                              shake — neither is in the GTA source.
//   impact–end     sustain   — text holds with a tiny breathing scale,
//                              base drifts via slow ambient zoom.
//
// The fullscreen `WastedEffect` composition below is what compose-wasted.mjs
// renders standalone. The exported timeline hook and layer components let
// InterwheelShort compose the same effect *on top of* its existing layout
// (HUD bands + central 1080×1080 game) without scaling the base video to
// fill the full frame.

export type WastedEffectKnobs = {
  // Phase durations (seconds).
  drainSec: number;            // 1.5  — color/vignette ramp-in length
  textAppearSec: number;       // 2.43 — when text impact lands (audio-sync)
  totalSec: number;            // 7.76 — composition length (= audio length)

  // Color grade targets at end of drain.
  endSaturation: number;       // 0.26 — friends' "muted not B&W" feedback
  endBrightness: number;       // 0.56
  endContrast: number;         // 1.16
  tintStrength: number;        // 0.24 — how much tint to mix in (multiply)
  tintColor: string;           // '#34221a' — sepia. Pass cool teal '#1d2a35'
                               // for the Max-Payne alternative.

  // Post-impact saturation drop. After the WASTED text lands, saturation
  // can lerp further down toward postImpactSaturation over a window of
  // postImpactSaturationDurationSec. Pass postImpactSaturation =
  // endSaturation (the default) to disable — saturation just holds at the
  // drain endpoint. Useful for pushing the death moment further toward
  // grayscale/old-film once the text has impacted.
  postImpactSaturation: number;
  postImpactSaturationDurationSec: number;

  // Vignette.
  vignetteIntensity: number;   // 0.86 — final dark-edge strength (0..1)
  vignetteInnerRadius: number; // 0.28 — fraction where dimming starts (0..1)

  // Base video timing.
  basePlaybackRate: number;    // 0.15 — 1.0 = real-time, 0.15 ≈ 6.7× slow-mo
  baseStartFromSec: number;    // 0    — where to begin the base video

  // Text impact accents — bloom + RGB-split spike at impact and decay.
  textOvershootScale: number;  // 1.18 — start scale before settling to 1.0
  textPunchDurationSec: number;// 0.10 — how long the overshoot snap takes
  textBreathAmplitude: number; // 0.025 — sustained breathing scale ±
  textBloomPeakPx: number;     // 24   — peak warm-halo blur radius (0 = off)
  textBloomDurationSec: number;// 0.18 — bloom decay window (≈ punchDuration
                               //        so the halo doesn't linger past the
                               //        text settling)
  textAberrationPeakPx: number;// 6    — peak red/cyan split offset (0 = off)
  textAberrationDurationSec: number; // 0.16 — aberration decay window

  // Cosmetic.
  ambientZoomEnd: number;      // 1.05 — base scale at totalSec (start = 1.0)
};

export interface WastedEffectProps extends WastedEffectKnobs {
  baseVideoSrc: string;
  wastedTextSrc: string;
  wastedAudioSrc: string;
}

// Canonical recipe (a.k.a. the `default` preset in compose-wasted.mjs).
// Synced to the audio sting at 2.43s, sepia-warm tint, retained color
// (sat 0.26), tight ~200ms impact spike via bloom + RGB-split rather than
// flash/shake. Override any subset for stylistic variants.
export const WASTED_EFFECT_DEFAULTS: WastedEffectKnobs = {
  drainSec: 1.5,
  textAppearSec: 2.43,
  totalSec: 7.76,
  endSaturation: 0.26,
  endBrightness: 0.56,
  endContrast: 1.16,
  tintStrength: 0.24,
  tintColor: '#34221a',
  vignetteIntensity: 0.86,
  vignetteInnerRadius: 0.28,
  postImpactSaturation: 0.26,    // = endSaturation → no-op by default
  postImpactSaturationDurationSec: 1.0,
  basePlaybackRate: 0.15,
  baseStartFromSec: 0,
  textOvershootScale: 1.18,
  textPunchDurationSec: 0.10,
  textBreathAmplitude: 0.025,
  textBloomPeakPx: 24,
  textBloomDurationSec: 0.18,
  textAberrationPeakPx: 6,
  textAberrationDurationSec: 0.16,
  ambientZoomEnd: 1.05,
};

// Cubic-bezier-ish overshoot for the text punch (stronger than easeOut).
const overshootEase = Easing.bezier(0.16, 1.4, 0.3, 1);

// Computed per-frame state for the WASTED effect. Pure derivation from
// props + (frame, fps); shared between the standalone composition and the
// integrated InterwheelShort treatment so visual behavior can't drift.
export type WastedTimeline = {
  drainEased: number;
  grade: { sat: number; bri: number; con: number; filter: string };
  tint: { opacity: number; color: string };
  vignette: { opacity: number; innerPct: number };
  text: { visible: boolean; opacity: number; scale: number; filter: string };
  ambientZoom: number;
};

export function useWastedTimeline(
  props: WastedEffectKnobs,
  ctx: { frame: number; fps: number },
): WastedTimeline {
  const t = ctx.frame / ctx.fps;

  const drain = clamp(t / props.drainSec, 0, 1);
  const drainEased = Easing.out(Easing.cubic)(drain);

  // Two-stage saturation: phase 1 drains 1 → endSaturation over drainSec
  // (eased), phase 2 (post-impact) lerps endSaturation → postImpactSaturation
  // over postImpactSaturationDurationSec, kicking in once the text impacts.
  const drainSat = lerp(1, props.endSaturation, drainEased);
  const postImpactT = clamp(
    (t - props.textAppearSec) / Math.max(0.001, props.postImpactSaturationDurationSec),
    0,
    1,
  );
  const sat = lerp(drainSat, props.postImpactSaturation, postImpactT);
  const bri = lerp(1, props.endBrightness, drainEased);
  const con = lerp(1, props.endContrast, drainEased);

  const tintOpacity = props.tintStrength * drainEased;
  const vigOpacity = props.vignetteIntensity * drainEased;
  const vigInner = lerp(0.55, props.vignetteInnerRadius, drainEased) * 100;

  const ambientZoom = interpolate(
    t, [0, props.totalSec],
    [1.0, props.ambientZoomEnd],
    { easing: Easing.inOut(Easing.quad), extrapolateRight: 'clamp' },
  );

  const stingT = t - props.textAppearSec;
  const textVisible = stingT >= 0;
  const punchProg = clamp(stingT / props.textPunchDurationSec, 0, 1);
  const punchScale = textVisible
    ? interpolate(overshootEase(punchProg), [0, 1],
        [props.textOvershootScale, 1.0])
    : 0;
  const breathPhase = Math.max(0, stingT - props.textPunchDurationSec);
  const breath = textVisible
    ? Math.sin(breathPhase * 1.6) * props.textBreathAmplitude
    : 0;
  const textScale = textVisible ? punchScale + breath : 0;
  const textOpacity = textVisible
    ? interpolate(punchProg, [0, 0.4, 1], [0, 0.95, 1], {
        extrapolateRight: 'clamp',
      })
    : 0;

  const bloomProg = clamp(stingT / props.textBloomDurationSec, 0, 1);
  const bloomRadius = textVisible
    ? props.textBloomPeakPx * (1 - bloomProg) ** 1.5
    : 0;
  const abProg = clamp(stingT / props.textAberrationDurationSec, 0, 1);
  const abOffset = textVisible
    ? props.textAberrationPeakPx * (1 - abProg) ** 2
    : 0;
  const textFilter = buildTextFilter({
    bloomRadius,
    aberrationOffset: abOffset,
  });

  return {
    drainEased,
    grade: {
      sat, bri, con,
      filter:
        `saturate(${sat.toFixed(3)}) ` +
        `brightness(${bri.toFixed(3)}) ` +
        `contrast(${con.toFixed(3)})`,
    },
    tint: { opacity: tintOpacity, color: props.tintColor },
    vignette: { opacity: vigOpacity, innerPct: vigInner },
    text: { visible: textVisible, opacity: textOpacity, scale: textScale, filter: textFilter },
    ambientZoom,
  };
}

export const WastedTintLayer: React.FC<{ opacity: number; color: string }> = ({
  opacity, color,
}) => (
  <AbsoluteFill style={{
    backgroundColor: color,
    mixBlendMode: 'multiply',
    opacity,
    pointerEvents: 'none',
  }} />
);

export const WastedVignetteLayer: React.FC<{ opacity: number; innerPct: number }> = ({
  opacity, innerPct,
}) => (
  <AbsoluteFill style={{
    background:
      `radial-gradient(ellipse at center, ` +
      `rgba(0,0,0,0) ${innerPct.toFixed(1)}%, ` +
      `rgba(0,0,0,1) 100%)`,
    opacity,
    pointerEvents: 'none',
  }} />
);

export const WastedTextLayer: React.FC<{
  src: string;
  opacity: number;
  scale: number;
  filter: string;
  widthPct?: number;
}> = ({ src, opacity, scale, filter, widthPct = 78 }) => (
  <AbsoluteFill style={{
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  }}>
    <Img
      src={src}
      style={{
        width: `${widthPct}%`,
        height: 'auto',
        opacity,
        transform: `scale(${scale.toFixed(4)})`,
        transformOrigin: 'center center',
        filter,
      }}
    />
  </AbsoluteFill>
);

function resolveUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : staticFile(src);
}

export const WastedEffect: React.FC<WastedEffectProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeline = useWastedTimeline(props, { frame, fps });

  const baseUrl = resolveUrl(props.baseVideoSrc);
  const textUrl = resolveUrl(props.wastedTextSrc);
  const audioUrl = resolveUrl(props.wastedAudioSrc);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Base video + grade + ambient zoom. */}
      <AbsoluteFill style={{
        transform: `scale(${timeline.ambientZoom})`,
        filter: timeline.grade.filter,
      }}>
        <OffthreadVideo
          src={baseUrl}
          playbackRate={props.basePlaybackRate}
          startFrom={Math.round(props.baseStartFromSec * fps)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          muted
        />
      </AbsoluteFill>

      <WastedTintLayer opacity={timeline.tint.opacity} color={timeline.tint.color} />
      <WastedVignetteLayer
        opacity={timeline.vignette.opacity}
        innerPct={timeline.vignette.innerPct}
      />

      {timeline.text.visible && (
        <WastedTextLayer
          src={textUrl}
          opacity={timeline.text.opacity}
          scale={timeline.text.scale}
          filter={timeline.text.filter}
        />
      )}

      {/* Audio. Plays from composition start so the chord at audio T =
          textAppearSec lands on the same frame the text appears. */}
      <Audio src={audioUrl} />
    </AbsoluteFill>
  );
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Compose the text element's CSS filter chain. drop-shadow filters cascade,
// so the *first* shadow operates on the raw glyph alpha, the next on the
// combined result, etc. Putting chromatic-aberration ghosts first means
// the bloom catches *both* ghost copies — sells the "TV impact" look.
function buildTextFilter(args: { bloomRadius: number; aberrationOffset: number }): string {
  const parts: string[] = [];
  if (args.aberrationOffset > 0.01) {
    const ofs = args.aberrationOffset.toFixed(2);
    const negOfs = (-args.aberrationOffset).toFixed(2);
    parts.push(`drop-shadow(${ofs}px 0 0 rgba(255,30,40,1))`);
    parts.push(`drop-shadow(${negOfs}px 0 0 rgba(0,180,255,1))`);
  }
  if (args.bloomRadius > 0.5) {
    parts.push(`drop-shadow(0 0 ${args.bloomRadius.toFixed(1)}px rgba(255,160,120,0.85))`);
  }
  // Depth shadow that grounds the text against the frame.
  parts.push('drop-shadow(0 8px 28px rgba(0,0,0,0.6))');
  return parts.join(' ');
}

// Re-export with default-bound src paths for Remotion Studio convenience.
export const WastedEffectDefault: React.FC = () => (
  <WastedEffect
    baseVideoSrc={staticFile('latest/base.mp4')}
    wastedTextSrc={staticFile('latest/wasted.png')}
    wastedAudioSrc={staticFile('latest/wasted.mp3')}
    {...WASTED_EFFECT_DEFAULTS}
  />
);
