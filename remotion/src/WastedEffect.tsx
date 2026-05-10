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
// Knobs all come in via props with defaults documented inline; tune via
// compose-wasted.mjs and surface attempts in the dashboard.

export interface WastedEffectProps {
  baseVideoSrc: string;
  wastedTextSrc: string;
  wastedAudioSrc: string;

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
}

// Canonical recipe (a.k.a. the `default` preset in compose-wasted.mjs).
// Synced to the audio sting at 2.43s, sepia-warm tint, retained color
// (sat 0.26), tight ~200ms impact spike via bloom + RGB-split rather than
// flash/shake. Override any subset for stylistic variants.
export const WASTED_EFFECT_DEFAULTS: Omit<WastedEffectProps,
  'baseVideoSrc' | 'wastedTextSrc' | 'wastedAudioSrc'> = {
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

function resolveUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : staticFile(src);
}

export const WastedEffect: React.FC<WastedEffectProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const baseUrl = resolveUrl(props.baseVideoSrc);
  const textUrl = resolveUrl(props.wastedTextSrc);
  const audioUrl = resolveUrl(props.wastedAudioSrc);

  // Drain progress 0..1 over [0, drainSec].
  const drain = clamp(t / props.drainSec, 0, 1);
  const drainEased = Easing.out(Easing.cubic)(drain);

  // Color grade — animate via CSS filter on the wrapper around the video.
  const sat = lerp(1, props.endSaturation, drainEased);
  const bri = lerp(1, props.endBrightness, drainEased);
  const con = lerp(1, props.endContrast, drainEased);
  // Tint pushed in via a multiply overlay layer (separate from the filter
  // chain so it doesn't fight the saturate/brightness/contrast filters).
  const tintOpacity = props.tintStrength * drainEased;

  // Vignette — radial gradient overlay that grows in opacity, with the
  // bright inner radius shrinking slightly so the edges encroach.
  const vigOpacity = props.vignetteIntensity * drainEased;
  const vigInner = lerp(0.55, props.vignetteInnerRadius, drainEased) * 100; // %

  // Ambient zoom on the base video (very slow, runs the full composition).
  const ambientZoom = interpolate(
    t, [0, props.totalSec],
    [1.0, props.ambientZoomEnd],
    { easing: Easing.inOut(Easing.quad), extrapolateRight: 'clamp' },
  );

  // Sting timing: text appears at textAppearSec.
  const stingT = t - props.textAppearSec;     // negative before sting
  const textVisible = stingT >= 0;
  const punchProg = clamp(stingT / props.textPunchDurationSec, 0, 1);
  const punchScale = textVisible
    ? interpolate(overshootEase(punchProg), [0, 1],
        [props.textOvershootScale, 1.0])
    : 0;

  // Breathing scale after the punch lands — small ±amplitude sine.
  const breathPhase = Math.max(0, stingT - props.textPunchDurationSec);
  const breath = textVisible
    ? Math.sin(breathPhase * 1.6) * props.textBreathAmplitude
    : 0;
  const textScale = textVisible ? punchScale + breath : 0;

  // Text opacity ramps over the same window as the scale so we don't pop
  // the glyphs in before the overshoot starts settling.
  const textOpacity = textVisible
    ? interpolate(punchProg, [0, 0.4, 1], [0, 0.95, 1], {
        extrapolateRight: 'clamp',
      })
    : 0;

  // Bloom: wide-blur warm halo via drop-shadow that decays from peak at
  // impact. Color is a warm off-white that complements red text.
  const bloomProg = clamp(stingT / props.textBloomDurationSec, 0, 1);
  const bloomRadius = textVisible
    ? props.textBloomPeakPx * (1 - bloomProg) ** 1.5
    : 0;

  // Chromatic aberration: red ghost shifted right + cyan ghost shifted left,
  // decaying from peak at impact. drop-shadow filters cascade so the two
  // offsets compose naturally with the depth shadow.
  const abProg = clamp(stingT / props.textAberrationDurationSec, 0, 1);
  const abOffset = textVisible
    ? props.textAberrationPeakPx * (1 - abProg) ** 2
    : 0;

  const textFilter = buildTextFilter({
    bloomRadius,
    aberrationOffset: abOffset,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Base video + grade + ambient zoom. */}
      <AbsoluteFill style={{
        transform: `scale(${ambientZoom})`,
        filter:
          `saturate(${sat.toFixed(3)}) ` +
          `brightness(${bri.toFixed(3)}) ` +
          `contrast(${con.toFixed(3)})`,
      }}>
        <OffthreadVideo
          src={baseUrl}
          playbackRate={props.basePlaybackRate}
          startFrom={Math.round(props.baseStartFromSec * fps)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
          }}
          muted
        />
      </AbsoluteFill>

      {/* Tint overlay (multiply blend keeps highlights from going chalky). */}
      <AbsoluteFill style={{
        backgroundColor: props.tintColor,
        mixBlendMode: 'multiply',
        opacity: tintOpacity,
      }} />

      {/* Vignette: radial gradient from transparent inner radius to black. */}
      <AbsoluteFill style={{
        background:
          `radial-gradient(ellipse at center, ` +
          `rgba(0,0,0,0) ${vigInner.toFixed(1)}%, ` +
          `rgba(0,0,0,1) 100%)`,
        opacity: vigOpacity,
        pointerEvents: 'none',
      }} />

      {/* WASTED text: centered, scale + breath, fades up at sting, with
          the bloom + RGB-split impact accents as drop-shadow filters. */}
      {textVisible && (
        <AbsoluteFill style={{
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          <Img
            src={textUrl}
            style={{
              width: '78%',
              height: 'auto',
              opacity: textOpacity,
              transform: `scale(${textScale.toFixed(4)})`,
              transformOrigin: 'center center',
              filter: textFilter,
            }}
          />
        </AbsoluteFill>
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
