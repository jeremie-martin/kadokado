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
// Force BT.709 (limited range) on the final encode + tag the file. Without
// this, Remotion v4 falls back to BT.601 untagged, and downstream players
// (Chrome/QuickTime/etc.) heuristically decode HD H.264 as BT.709 — the
// matrix mismatch desaturates greens and shifts reds toward orange. With
// the tag set, every consumer agrees on the colorimetry. The matching
// source-side tag lives in scripts/interwheel/make-video.mjs.
Config.setColorSpace('bt709');
