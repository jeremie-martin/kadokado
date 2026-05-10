import { Composition, staticFile } from 'remotion';
import { InterwheelShort } from './InterwheelShort';
import { WastedEffect, WASTED_EFFECT_DEFAULTS } from './WastedEffect';

const FPS = 40;
const SHORT_WIDTH = 1080;
const SHORT_HEIGHT = 1920;
const MAX_DURATION_FRAMES = FPS * 120;

// WASTED effect renders at 1:1 — base.mp4 is currently 1200×1200 game
// footage; we render at 1200 to keep one source pixel per output pixel.
const WASTED_SIDE = 1200;
const WASTED_DURATION_FRAMES = Math.round(WASTED_EFFECT_DEFAULTS.totalSec * FPS);

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="InterwheelShort"
        component={InterwheelShort}
        width={SHORT_WIDTH}
        height={SHORT_HEIGHT}
        fps={FPS}
        durationInFrames={MAX_DURATION_FRAMES}
        defaultProps={{
          gameVideoSrc: 'latest/game.mp4',
          sidecarSrc: 'latest/game.ndjson',
          musicSrc: 'latest/music.opus',
          musicStartSec: 0,
          musicDuckStartFrame: null,
        }}
      />
      <Composition
        id="WastedEffect"
        component={WastedEffect}
        width={WASTED_SIDE}
        height={WASTED_SIDE}
        fps={FPS}
        durationInFrames={WASTED_DURATION_FRAMES}
        defaultProps={{
          baseVideoSrc: staticFile('latest/base.mp4'),
          wastedTextSrc: staticFile('latest/wasted.png'),
          wastedAudioSrc: staticFile('latest/wasted.mp3'),
          ...WASTED_EFFECT_DEFAULTS,
        }}
      />
    </>
  );
};
