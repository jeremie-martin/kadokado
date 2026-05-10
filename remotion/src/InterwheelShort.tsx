import { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { ScoreLine } from './components/ScoreLine';
import { HeightLine } from './components/HeightLine';
import { WaterGauge } from './components/WaterGauge';
import { loadSidecar, SidecarRow } from './sidecar';
import {
  WastedEffectKnobs,
  WastedTextLayer,
  WastedTintLayer,
  WastedVignetteLayer,
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
};

function resolveUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : staticFile(src);
}

// The 1080×1920 frame: blurred extend in the bands, central 1080×1080 game,
// HUD on top of the bands. Used for both phases — pre-WASTED feeds it the
// regular gameplay video, the WASTED phase feeds it slow-mo videos and a
// grade filter.
const LayoutFrame: React.FC<{
  row: SidecarRow | null;
  backdrop: React.ReactNode;
  game: React.ReactNode;
  gradeFilter?: string;
}> = ({ row, backdrop, game, gradeFilter }) => (
  <AbsoluteFill style={{ filter: gradeFilter }}>
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {backdrop}
      <AbsoluteFill style={{ backgroundColor: 'rgba(0, 0, 0, 0.45)' }} />
    </AbsoluteFill>

    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: SHORT_WIDTH,
        height: TOP_BAND_HEIGHT,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        alignContent: 'center',
        rowGap: 28,
        columnGap: 40,
        padding: '0 80px',
      }}
    >
      <ScoreLine score={row?.score ?? 0} />
      <HeightLine heightM={row?.heightM ?? 0} />
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
      {game}
    </div>

    <div
      style={{
        position: 'absolute',
        left: 0,
        top: TOP_BAND_HEIGHT + GAME_SIZE,
        width: SHORT_WIDTH,
        height: BOTTOM_BAND_HEIGHT,
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        alignContent: 'center',
        columnGap: 40,
        padding: '0 80px',
      }}
    >
      <WaterGauge waterY={row?.waterY ?? 0} blobY={row?.blob.y ?? 0} />
    </div>
  </AbsoluteFill>
);

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
}> = ({ videoUrl, sidecar }) => {
  const frame = useCurrentFrame();
  const row = sidecar ? sidecar[Math.min(frame, sidecar.length - 1)] ?? null : null;
  return (
    <LayoutFrame
      row={row}
      backdrop={<OffthreadVideo src={videoUrl} muted style={blurredBackdropStyle} />}
      game={<OffthreadVideo src={videoUrl} muted style={centerGameStyle} />}
    />
  );
};

// Same layout, but the videos are slow-mo continuations of the same source
// starting at wastedStartFrame; the layout receives the cinematic grade
// filter; tint, vignette, WASTED text and audio overlay the entire frame.
//
// Sidecar lookup uses the absolute frame (wastedStartFrame + relative frame)
// so the HUD reads post-death rows directly. Score/height/etc. don't change
// after death so the HUD reads as "frozen at death values" without needing
// any explicit freeze.
const WastedPhase: React.FC<{
  videoUrl: string;
  textUrl: string;
  audioUrl: string;
  sidecar: SidecarRow[] | null;
  wastedStartFrame: number;
  effectProps: WastedEffectKnobs;
}> = ({ videoUrl, textUrl, audioUrl, sidecar, wastedStartFrame, effectProps }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timeline = useWastedTimeline(
    { ...effectProps, baseStartFromSec: wastedStartFrame / fps },
    { frame, fps },
  );

  const absFrame = wastedStartFrame + frame;
  const row = sidecar ? sidecar[Math.min(absFrame, sidecar.length - 1)] ?? null : null;

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

  return (
    <AbsoluteFill>
      <LayoutFrame
        row={row}
        backdrop={slowMoBackdrop}
        game={slowMoGame}
        gradeFilter={timeline.grade.filter}
      />

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

      <Audio src={audioUrl} />
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
        <RegularPhase videoUrl={videoUrl} sidecar={sidecar} />
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
