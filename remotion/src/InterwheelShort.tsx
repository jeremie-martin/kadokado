import { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  Freeze,
  OffthreadVideo,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { ScoreLine } from './components/ScoreLine';
import { HeightLine } from './components/HeightLine';
import { WaterGauge } from './components/WaterGauge';
import { loadSidecar, SidecarRow } from './sidecar';

const SHORT_WIDTH = 1080;
const SHORT_HEIGHT = 1920;
const GAME_SIZE = 1080;
const TOP_BAND_HEIGHT = (SHORT_HEIGHT - GAME_SIZE) / 2; // 420
const BOTTOM_BAND_HEIGHT = TOP_BAND_HEIGHT;             // 420
const FPS = 40;

// Music ducks hard while the WASTED overlay is on screen so the sting cuts
// through. The WASTED overlay is composited in by compose-short.mjs as an
// ffmpeg post-step (chromakey on a greenscreen mp4) — Remotion only handles
// the freeze + telemetry + music here.
const MUSIC_BASE_VOLUME = 0.55;
const MUSIC_DUCK_VOLUME = 0.22;
const MUSIC_DUCK_RAMP_FRAMES = 12; // ~0.3s ramp into the duck

export type InterwheelShortProps = {
  gameVideoSrc: string;
  sidecarSrc: string;
  musicSrc: string | null;
  musicStartSec: number;
  // Frame at which the music starts ducking (typically the moment the WASTED
  // overlay begins, i.e. deathFrame - leadFrames). null = no duck.
  musicDuckStartFrame: number | null;
};

function resolveUrl(src: string): string {
  return src.startsWith('http') || src.startsWith('/') ? src : staticFile(src);
}

export const InterwheelShort: React.FC<InterwheelShortProps> = ({
  gameVideoSrc,
  sidecarSrc,
  musicSrc,
  musicStartSec,
  musicDuckStartFrame,
}) => {
  const frame = useCurrentFrame();
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

  const deathFrame: number | null = useMemo(() => {
    if (!sidecar) return null;
    for (let i = 0; i < sidecar.length; i += 1) {
      if (sidecar[i].events?.endingStarted) return i;
    }
    return null;
  }, [sidecar]);

  const row: SidecarRow | null = sidecar
    ? sidecar[Math.min(frame, sidecar.length - 1)] ?? null
    : null;

  const videoUrl = resolveUrl(gameVideoSrc);

  // Game video plays normally up to the actual death, then freezes there.
  const videoEffectiveFrame =
    deathFrame != null && frame >= deathFrame ? deathFrame : frame;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      {/* Subtle blurred-extend backdrop. */}
      <Freeze frame={videoEffectiveFrame}>
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <OffthreadVideo
            src={videoUrl}
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: 'scale(1.05)',
              filter: 'blur(40px) saturate(0.8) brightness(0.45)',
            }}
          />
          <AbsoluteFill style={{ backgroundColor: 'rgba(0, 0, 0, 0.45)' }} />
        </AbsoluteFill>
      </Freeze>

      {/* TOP BAND: SCORE + HEIGHT, column-aligned via CSS grid. */}
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

      {/* GAME: 1080×1080, frozen at the actual death frame. */}
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
        <Freeze frame={videoEffectiveFrame}>
          <OffthreadVideo
            src={videoUrl}
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        </Freeze>
      </div>

      {/* BOTTOM BAND: WATER */}
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
        <WaterGauge
          waterY={row?.waterY ?? 0}
          blobY={row?.blob.y ?? 0}
        />
      </div>

      {/* Background music — duck during the WASTED overlay window. */}
      {musicSrc && (
        <Audio
          src={resolveUrl(musicSrc)}
          startFrom={Math.max(0, Math.round(musicStartSec * FPS))}
          volume={(f) => {
            if (musicDuckStartFrame == null || f < musicDuckStartFrame) {
              return MUSIC_BASE_VOLUME;
            }
            const t = Math.min(1, (f - musicDuckStartFrame) / MUSIC_DUCK_RAMP_FRAMES);
            return MUSIC_BASE_VOLUME + (MUSIC_DUCK_VOLUME - MUSIC_BASE_VOLUME) * t;
          }}
        />
      )}
    </AbsoluteFill>
  );
};
