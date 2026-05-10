import { Config } from '@remotion/cli/config';

// PNG frames into ffmpeg keep the per-frame compositing pristine. H264 with
// CRF 18 + yuv444p is "visually transparent" — well below any artifact a
// human would notice — while staying under ~50 MB for a 30s short. The user
// re-encodes downstream for captions/effects, so we don't need bit-exact
// lossless here. Switch to `prores` with profile `4444` if you need it.
Config.setVideoImageFormat('png');
Config.setCodec('h264');
Config.setPixelFormat('yuv444p');
Config.setCrf(18);
Config.setOverwriteOutput(true);
