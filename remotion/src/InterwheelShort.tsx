import { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { ScoreLine } from './components/ScoreLine';
import { HighScoreLine } from './components/HighScoreLine';
import { loadSidecar, SidecarRow } from './sidecar';
import {
  useScorePulseState,
  useWaterDanger,
  useHighScoreState,
  clamp01,
} from './scoreSignals';
import {
  WastedEffectKnobs,
  WastedTextLayer,
  WastedTintLayer,
  WastedVignetteLayer,
  WastedTimeline,
  useWastedTimeline,
} from './WastedEffect';

const SHORT_WIDTH = 1080;
const SHORT_HEIGHT = 1920;
const GAME_SIZE = 1080;
const TOP_BAND_HEIGHT = (SHORT_HEIGHT - GAME_SIZE) / 2; // 420
const BOTTOM_BAND_HEIGHT = TOP_BAND_HEIGHT;             // 420
const FPS = 40;

// Music plays at full volume up to 0.5s after the WASTED text impact, then
// fades linearly to silence by the end of the composition. The WASTED audio
// sting stays at full volume — the fade is on the music bed only, so the
// sting cuts through naturally as the music recedes.
const MUSIC_BASE_VOLUME = 0.55;
const MUSIC_FADE_LEAD_AFTER_TEXT_SEC = 0.5;

// Position of the chord/sting inside wasted.mp3 (seconds from file start).
// When effectProps.textAppearSec is shorter than this, the audio is started
// mid-file via Audio's startFrom so the chord still lands on the text impact.
const WASTED_AUDIO_STING_OFFSET_SEC = 2.43;

// Pre-WASTED "tell": a silent visual lead-in during the regular phase, in
// the last PRE_WASTED_TELL_SEC seconds before wastedStartFrame. Saturation
// and brightness ease from identity (1.0/1.0) to (END_SAT/END_BRI) using a
// late-loaded curve, so the dread builds quietly under regular gameplay
// audio with no music change. At wastedStartFrame the slow-mo + audio sting
// take over and the WASTED drain pulls grade from identity down to its full
// peak — a small "snap to full color" at the seam is intentional, masked by
// the slow-mo cut + audio impact, and reads as the world's last gasp before
// the WASTED takeover.
const PRE_WASTED_TELL_SEC = 2.0;
const PRE_WASTED_TELL_END_SAT = 0.7;
const PRE_WASTED_TELL_END_BRI = 0.92;

// Danger tint composition over time. Three behaviours layered:
//   * Slow heartbeat — ±DANGER_HEARTBEAT_AMP sine on alpha at
//     DANGER_HEARTBEAT_HZ, gated by danger ≥ DANGER_HEARTBEAT_GATE so
//     it stays silent at low danger and rises with the threat. Phased on
//     absolute frame to keep rhythm continuous across the regular→WASTED
//     cut.
//   * Color shift — lerp from the calm-phase orange-red (R0,G0,B0) to a
//     more saturated pure red (R1,G1,B1) over [-2s, 0s] of WASTED time
//     (i.e. during the pre-WASTED tell window). By the moment the WASTED
//     audio starts the tint is already pure red.
//   * Two-segment fade-out — once the audio starts, multiplicatively
//     fade the tint's visibility piecewise:
//       wastedT ∈ [0, KNEE_SEC]: 1.0 → (1 - KNEE_PCT)  (gentle slope)
//       wastedT ∈ [KNEE_SEC, END_SEC]: → 0.0           (faster cleanup)
//     The shape lets the alarm dim slowly through most of the slow-mo
//     replay, then snaps the rest off as the cinematic grade takes over.
const DANGER_HEARTBEAT_HZ = 0.8;
const DANGER_HEARTBEAT_AMP = 0.15;
const DANGER_HEARTBEAT_GATE = 0.4;
const DANGER_TINT_RGB_CALM: [number, number, number] = [255, 100, 60];
const DANGER_TINT_RGB_WASTED: [number, number, number] = [255, 60, 50];
const DANGER_WASTED_COLOR_START_SEC = -2.0;
const DANGER_WASTED_COLOR_END_SEC = 0.0;
const DANGER_WASTED_FADE_KNEE_SEC = 2.0;
const DANGER_WASTED_FADE_KNEE_PCT = 0.65;
const DANGER_WASTED_FADE_END_SEC = 2.43;

type DangerTintParams = { rgb: string; visibility: number };

function computeDangerTint(args: {
  waterDanger: number;
  frameAbs: number;
  fps: number;
  // Seconds relative to wastedStartFrame. Negative during the pre-WASTED
  // window of the regular phase. null when the run has no death event,
  // in which case the calm color stays and there's no fade-out.
  wastedRelativeT: number | null;
}): DangerTintParams {
  const { waterDanger, frameAbs, fps, wastedRelativeT } = args;

  // Color shift: orange-red → pure red over [START, END] in wasted-time.
  let colorT = 0;
  if (wastedRelativeT != null) {
    colorT = clamp01(
      (wastedRelativeT - DANGER_WASTED_COLOR_START_SEC) /
        (DANGER_WASTED_COLOR_END_SEC - DANGER_WASTED_COLOR_START_SEC),
    );
  }
  const g = Math.round(
    DANGER_TINT_RGB_CALM[1] + (DANGER_TINT_RGB_WASTED[1] - DANGER_TINT_RGB_CALM[1]) * colorT,
  );
  const b = Math.round(
    DANGER_TINT_RGB_CALM[2] + (DANGER_TINT_RGB_WASTED[2] - DANGER_TINT_RGB_CALM[2]) * colorT,
  );
  const rgb = `${DANGER_TINT_RGB_CALM[0]}, ${g}, ${b}`;

  // Two-segment piecewise-linear fade-out. Visibility is 1 below 0s,
  // reaches (1 − KNEE_PCT) at KNEE_SEC, then 0 at END_SEC.
  let fadeAmount = 0;
  if (wastedRelativeT != null && wastedRelativeT > 0) {
    if (wastedRelativeT <= DANGER_WASTED_FADE_KNEE_SEC) {
      fadeAmount =
        (wastedRelativeT / DANGER_WASTED_FADE_KNEE_SEC) * DANGER_WASTED_FADE_KNEE_PCT;
    } else if (wastedRelativeT < DANGER_WASTED_FADE_END_SEC) {
      fadeAmount =
        DANGER_WASTED_FADE_KNEE_PCT +
        ((wastedRelativeT - DANGER_WASTED_FADE_KNEE_SEC) /
          (DANGER_WASTED_FADE_END_SEC - DANGER_WASTED_FADE_KNEE_SEC)) *
          (1 - DANGER_WASTED_FADE_KNEE_PCT);
    } else {
      fadeAmount = 1;
    }
  }
  const fadeVisibility = 1 - fadeAmount;

  const heartbeatGate = clamp01((waterDanger - DANGER_HEARTBEAT_GATE) / (1 - DANGER_HEARTBEAT_GATE));
  const heartbeat =
    1 +
    DANGER_HEARTBEAT_AMP * heartbeatGate * Math.sin(2 * Math.PI * DANGER_HEARTBEAT_HZ * (frameAbs / fps));

  return { rgb, visibility: heartbeat * fadeVisibility };
}

export type InterwheelShortProps = {
  gameVideoSrc: string;
  sidecarSrc: string;
  musicSrc: string | null;
  musicStartSec: number;

  // null = no death in this run; the gameplay plays through to its natural
  // end with no WASTED takeover.
  wastedStartFrame: number | null;
  wastedTextSrc: string;
  wastedAudioSrc: string;
  // Full WastedEffectKnobs; `baseStartFromSec` from the input is ignored —
  // the WASTED phase derives it from wastedStartFrame so the slow-mo replay
  // begins exactly where the regular gameplay leaves off.
  wastedEffectProps: WastedEffectKnobs;

  // Previous high score to display on the right of the top band. When the
  // live score crosses it, the HighScoreLine fades out, the ScoreLine label
  // flips to "New Best", and a synthetic kick fires on the score's pulse.
  // null/undefined hides the high score readout entirely.
  previousHighScore?: number | null;
};

function resolveUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : staticFile(src);
}

// The 1080×1920 frame: blurred extend in the bands, central 1080×1080 game,
// HUD on top of the bands. Used for both phases — pre-WASTED feeds it the
// regular gameplay video, the WASTED phase feeds a slow-mo video plus a
// `wasted` timeline that drives differential dimming.
//
// During WASTED: the full grade + tint + vignette are clipped to the central
// 1080×1080 gameplay box, while the HUD bands and the blurred backdrop get a
// much softer "support" grade (light desaturation + slight darken). This
// keeps score / height / water legible instead of being crushed by the
// vignette's outer ring and the global brightness drop.
const LayoutFrame: React.FC<{
  row: SidecarRow | null;
  backdrop: React.ReactNode;
  game: React.ReactNode;
  wasted?: WastedTimeline | null;
  textNode?: React.ReactNode;
  // Pre-WASTED tell: a CSS filter string applied to the central gameplay
  // box only (HUD bands and backdrop unaffected) during the regular phase's
  // lead-in window. Ignored when `wasted` is set — WASTED's grade takes over.
  preTellGrade?: string | null;
  // Score-pulse state from useScorePulseState (warmth in [0,1], kickEnv
  // in [0,1]). Passed through to ScoreLine. `kickEnv` here is already the
  // max of the natural pastille kick and the synthetic high-score-crossing
  // kick — caller composes.
  warmth: number;
  kickEnv: number;
  previousHighScore: number | null | undefined;
  highScoreOpacity: number;
  highScoreApproach: number;
  // Water danger ∈ [0, 1], LP-filtered (see useWaterDanger). Drives a red
  // tint overlay on both top and bottom bands — replaces the numeric
  // WaterGauge readout. 0 = calm, 1 = blob touching/below water.
  waterDanger: number;
  // RGB string ("r, g, b") for the danger tint. Phase-dependent — see
  // computeDangerTint. Caller composes; LayoutFrame just inserts.
  dangerTintRGB: string;
  // Multiplier on the tint alpha (heartbeat × fade). 1 = full tint, 0 =
  // hidden. Caller computes; LayoutFrame multiplies into both band and
  // gameplay alphas.
  dangerVisibility: number;
}> = ({
  row,
  backdrop,
  game,
  wasted,
  textNode,
  preTellGrade,
  warmth,
  kickEnv,
  previousHighScore,
  highScoreOpacity,
  highScoreApproach,
  waterDanger,
  dangerTintRGB,
  dangerVisibility,
}) => {
  const drain = wasted?.drainEased ?? 0;
  // Soft grade applied to the HUD bands and the blurred backdrop during
  // WASTED. Peak (drain=1) lands at saturate(0.55) brightness(0.82) — strong
  // enough to read as part of the WASTED mood, gentle enough that the HUD
  // text stays clearly readable.
  const supportFilter = wasted
    ? `saturate(${(1 - 0.45 * drain).toFixed(3)}) ` +
      `brightness(${(1 - 0.18 * drain).toFixed(3)})`
    : undefined;
  // Extra black overlay added on top of the backdrop's existing 0.45 dim
  // during WASTED — gives the bands a subtle additional darken without
  // touching the HUD text on top.
  const backdropExtraDimAlpha = drain * 0.18;

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ overflow: 'hidden', filter: supportFilter }}>
        {backdrop}
        <AbsoluteFill style={{ backgroundColor: 'rgba(0, 0, 0, 0.45)' }} />
        {wasted && (
          <AbsoluteFill
            style={{
              backgroundColor: `rgba(0, 0, 0, ${backdropExtraDimAlpha.toFixed(3)})`,
            }}
          />
        )}
      </AbsoluteFill>

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: SHORT_WIDTH,
          height: TOP_BAND_HEIGHT,
          filter: supportFilter,
          backgroundColor: waterDanger > 0 && dangerVisibility > 0
            ? `rgba(${dangerTintRGB}, ${(waterDanger * 0.55 * dangerVisibility).toFixed(3)})`
            : undefined,
        }}
      >
        {/*
         * Pre-crossing layout — score over high, both left-aligned in a
         * 2-row grid. Fades out as transitionT (= 1 − highScoreOpacity)
         * goes 0 → 1 over the 0.4 s window after the crossing fires.
         */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            gridTemplateColumns: 'auto auto',
            alignContent: 'center',
            justifyContent: 'start',
            columnGap: 40,
            rowGap: 12,
            padding: '0 44px',
            opacity: highScoreOpacity,
          }}
        >
          <ScoreLine
            score={row?.score ?? 0}
            warmth={warmth}
            kickEnv={kickEnv}
            label="Score"
          />
          {previousHighScore != null && previousHighScore > 0 && (
            <HighScoreLine
              highScore={previousHighScore}
              opacity={1}
              approachLevel={highScoreApproach}
            />
          )}
        </div>

        {/*
         * Post-crossing layout — "NEW BEST" centered above the score, both
         * horizontally and vertically centered in the top band. Fades in
         * synchronously with the pre-layout fade-out. ScoreLine's centered
         * prop redirects its kick transform-origin to center-center so the
         * scale grows symmetrically.
         */}
        {previousHighScore != null && previousHighScore > 0 && highScoreOpacity < 1 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              rowGap: 16,
              padding: '0 44px',
              opacity: 1 - highScoreOpacity,
            }}
          >
            <ScoreLine
              score={row?.score ?? 0}
              warmth={warmth}
              kickEnv={kickEnv}
              label="New Best"
              centered
            />
          </div>
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: TOP_BAND_HEIGHT,
          width: SHORT_WIDTH,
          height: GAME_SIZE,
          overflow: 'hidden',
        }}
      >
        <AbsoluteFill style={{ filter: wasted?.grade.filter ?? preTellGrade ?? undefined }}>
          {game}
          {waterDanger > 0 && dangerVisibility > 0 && (
            <AbsoluteFill
              style={{
                backgroundColor: `rgba(${dangerTintRGB}, ${(waterDanger * 0.25 * dangerVisibility).toFixed(3)})`,
                pointerEvents: 'none',
              }}
            />
          )}
        </AbsoluteFill>
        {wasted && (
          <>
            <WastedTintLayer opacity={wasted.tint.opacity} color={wasted.tint.color} />
            <WastedVignetteLayer
              opacity={wasted.vignette.opacity}
              innerPct={wasted.vignette.innerPct}
            />
          </>
        )}
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          top: TOP_BAND_HEIGHT + GAME_SIZE,
          width: SHORT_WIDTH,
          height: BOTTOM_BAND_HEIGHT,
          filter: supportFilter,
          backgroundColor: waterDanger > 0 && dangerVisibility > 0
            ? `rgba(${dangerTintRGB}, ${(waterDanger * 0.55 * dangerVisibility).toFixed(3)})`
            : undefined,
        }}
      />

      {textNode}
    </AbsoluteFill>
  );
};

const blurredBackdropStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  transform: 'scale(1.05)',
  filter: 'blur(40px) saturate(0.8) brightness(0.45)',
};

const centerGameStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  objectFit: 'cover',
};

const RegularPhase: React.FC<{
  videoUrl: string;
  sidecar: SidecarRow[] | null;
  wastedStartFrame: number | null;
  previousHighScore: number | null | undefined;
}> = ({ videoUrl, sidecar, wastedStartFrame, previousHighScore }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const row = sidecar ? sidecar[Math.min(frame, sidecar.length - 1)] ?? null : null;
  const pulse = useScorePulseState(sidecar, frame, fps);
  const waterDanger = useWaterDanger(sidecar, frame, fps);
  const highScore = useHighScoreState(sidecar, previousHighScore, frame, fps);
  const dangerTint = computeDangerTint({
    waterDanger,
    frameAbs: frame,
    fps,
    wastedRelativeT:
      wastedStartFrame != null ? (frame - wastedStartFrame) / fps : null,
  });

  let preTellGrade: string | null = null;
  if (wastedStartFrame != null) {
    const tellWindowFrames = PRE_WASTED_TELL_SEC * fps;
    const tellStartFrame = wastedStartFrame - tellWindowFrames;
    if (frame >= tellStartFrame) {
      const t = Math.max(0, Math.min(1, (frame - tellStartFrame) / tellWindowFrames));
      // Ease-in cubic — drain accelerates as you near the death frame, so
      // the last ~0.5s feels like a sharper tightening rather than a flat
      // ramp.
      const eased = Easing.in(Easing.cubic)(t);
      const sat = 1 - (1 - PRE_WASTED_TELL_END_SAT) * eased;
      const bri = 1 - (1 - PRE_WASTED_TELL_END_BRI) * eased;
      preTellGrade = `saturate(${sat.toFixed(3)}) brightness(${bri.toFixed(3)})`;
    }
  }

  return (
    <LayoutFrame
      row={row}
      backdrop={<OffthreadVideo src={videoUrl} muted style={blurredBackdropStyle} />}
      game={<OffthreadVideo src={videoUrl} muted style={centerGameStyle} />}
      preTellGrade={preTellGrade}
      warmth={pulse.warmth}
      kickEnv={Math.max(pulse.kickEnv, highScore.crossKickEnv)}
      previousHighScore={previousHighScore}
      highScoreOpacity={highScore.highScoreOpacity}
      highScoreApproach={highScore.approachLevel}
      waterDanger={waterDanger}
      dangerTintRGB={dangerTint.rgb}
      dangerVisibility={dangerTint.visibility}
    />
  );
};

// Same layout, but the videos are slow-mo continuations of the same source
// starting at wastedStartFrame; the layout receives the WASTED timeline and
// applies grade/tint/vignette only to the central gameplay box. The WASTED
// text + audio overlay the full frame.
//
// Sidecar lookup uses the absolute frame (wastedStartFrame + relative frame)
// so the HUD reads post-death rows directly. Score/height/etc. don't change
// after death so the HUD reads as "frozen at death values" without needing
// any explicit freeze.
//
// Audio is started mid-file via startFrom whenever effectProps.textAppearSec
// is shorter than WASTED_AUDIO_STING_OFFSET_SEC (the chord position in the
// source mp3) — this lets the cinematic preset pull the impact 1s sooner
// without re-recording the audio file.
const WastedPhase: React.FC<{
  videoUrl: string;
  textUrl: string;
  audioUrl: string;
  sidecar: SidecarRow[] | null;
  wastedStartFrame: number;
  effectProps: WastedEffectKnobs;
  previousHighScore: number | null | undefined;
}> = ({
  videoUrl,
  textUrl,
  audioUrl,
  sidecar,
  wastedStartFrame,
  effectProps,
  previousHighScore,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeline = useWastedTimeline(
    { ...effectProps, baseStartFromSec: wastedStartFrame / fps },
    { frame, fps },
  );

  const absFrame = wastedStartFrame + frame;
  const row = sidecar ? sidecar[Math.min(absFrame, sidecar.length - 1)] ?? null : null;
  const pulse = useScorePulseState(sidecar, absFrame, fps);
  const waterDanger = useWaterDanger(sidecar, absFrame, fps);
  const highScore = useHighScoreState(sidecar, previousHighScore, absFrame, fps);
  const dangerTint = computeDangerTint({
    waterDanger,
    frameAbs: absFrame,
    fps,
    wastedRelativeT: frame / fps,
  });

  const slowMoBackdrop = (
    <OffthreadVideo
      src={videoUrl}
      muted
      playbackRate={effectProps.basePlaybackRate}
      startFrom={wastedStartFrame}
      style={blurredBackdropStyle}
    />
  );
  const slowMoGame = (
    <OffthreadVideo
      src={videoUrl}
      muted
      playbackRate={effectProps.basePlaybackRate}
      startFrom={wastedStartFrame}
      style={centerGameStyle}
    />
  );

  const audioStartFromFrames = Math.max(
    0,
    Math.round((WASTED_AUDIO_STING_OFFSET_SEC - effectProps.textAppearSec) * fps),
  );

  return (
    <AbsoluteFill>
      <LayoutFrame
        row={row}
        backdrop={slowMoBackdrop}
        game={slowMoGame}
        wasted={timeline}
        textNode={
          timeline.text.visible ? (
            <WastedTextLayer
              src={textUrl}
              opacity={timeline.text.opacity}
              scale={timeline.text.scale}
              filter={timeline.text.filter}
            />
          ) : null
        }
        warmth={pulse.warmth}
        kickEnv={Math.max(pulse.kickEnv, highScore.crossKickEnv)}
        previousHighScore={previousHighScore}
        highScoreOpacity={highScore.highScoreOpacity}
        highScoreApproach={highScore.approachLevel}
        waterDanger={waterDanger}
        dangerTintRGB={dangerTint.rgb}
        dangerVisibility={dangerTint.visibility}
      />

      <Audio src={audioUrl} startFrom={audioStartFromFrames} />
    </AbsoluteFill>
  );
};

export const InterwheelShort: React.FC<InterwheelShortProps> = ({
  gameVideoSrc,
  sidecarSrc,
  musicSrc,
  musicStartSec,
  wastedStartFrame,
  wastedTextSrc,
  wastedAudioSrc,
  wastedEffectProps,
  previousHighScore = null,
}) => {
  const [sidecar, setSidecar] = useState<SidecarRow[] | null>(null);
  const [handle] = useState(() => delayRender('Loading sidecar'));

  useEffect(() => {
    loadSidecar(sidecarSrc)
      .then((rows) => {
        setSidecar(rows);
        continueRender(handle);
      })
      .catch((err) => {
        console.error(err);
        continueRender(handle);
      });
  }, [sidecarSrc, handle]);

  const videoUrl = useMemo(() => resolveUrl(gameVideoSrc), [gameVideoSrc]);
  const textUrl = useMemo(() => resolveUrl(wastedTextSrc), [wastedTextSrc]);
  const audioUrl = useMemo(() => resolveUrl(wastedAudioSrc), [wastedAudioSrc]);

  const preWastedDuration =
    wastedStartFrame != null ? Math.max(0, wastedStartFrame) : undefined;

  // Music fade window: starts MUSIC_FADE_LEAD_AFTER_TEXT_SEC after the
  // WASTED text appears (i.e. wastedStart + textAppearSec + 0.5s), ends at
  // the composition's last WASTED frame so the music silences out exactly
  // when the short ends.
  const musicFadeStartFrame =
    wastedStartFrame == null
      ? null
      : wastedStartFrame +
        Math.round((wastedEffectProps.textAppearSec + MUSIC_FADE_LEAD_AFTER_TEXT_SEC) * FPS);
  const musicFadeEndFrame =
    wastedStartFrame == null
      ? null
      : wastedStartFrame + Math.round(wastedEffectProps.totalSec * FPS);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence durationInFrames={preWastedDuration}>
        <RegularPhase
          videoUrl={videoUrl}
          sidecar={sidecar}
          wastedStartFrame={wastedStartFrame}
          previousHighScore={previousHighScore}
        />
      </Sequence>

      {wastedStartFrame != null && (
        <Sequence from={wastedStartFrame}>
          <WastedPhase
            videoUrl={videoUrl}
            textUrl={textUrl}
            audioUrl={audioUrl}
            sidecar={sidecar}
            wastedStartFrame={wastedStartFrame}
            effectProps={wastedEffectProps}
            previousHighScore={previousHighScore}
          />
        </Sequence>
      )}

      {musicSrc && (
        <Audio
          src={resolveUrl(musicSrc)}
          startFrom={Math.max(0, Math.round(musicStartSec * FPS))}
          volume={(f) => {
            if (musicFadeStartFrame == null || f < musicFadeStartFrame) {
              return MUSIC_BASE_VOLUME;
            }
            if (musicFadeEndFrame == null || f >= musicFadeEndFrame) {
              return 0;
            }
            const t = (f - musicFadeStartFrame) / (musicFadeEndFrame - musicFadeStartFrame);
            return MUSIC_BASE_VOLUME * (1 - t);
          }}
        />
      )}
    </AbsoluteFill>
  );
};
