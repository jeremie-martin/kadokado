import { Composition } from 'remotion';
import { InterwheelShort } from './InterwheelShort';

const FPS = 40;
const SHORT_WIDTH = 1080;
const SHORT_HEIGHT = 1920;

// Generous upper bound. compose-short.mjs always passes --frames so the
// rendered mp4 is the right length; Studio scrubbing past the sidecar end
// is harmless (Composition clamps to the last row).
const MAX_DURATION_FRAMES = FPS * 120;

export const Root: React.FC = () => {
  return (
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
  );
};
