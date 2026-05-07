#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / "public" / "assets" / "interwheel"
OUTPUT_ROOT = REPO_ROOT / "generated-assets" / "interwheel-upscale" / "interwheel-2x"
PUBLIC_OUTPUT_ROOT = REPO_ROOT / "public" / "assets" / "interwheel-2x"
TMP_ROOT = Path("/tmp/interwheel-upscale-2x-holo")

WAIFU2X_CUNET_MODEL = Path.home() / ".local/share/waifu2x-ncnn-vulkan/models-cunet"
WAIFU2X_UPCONV_ANIME_MODEL = (
    Path.home() / ".local/share/waifu2x-ncnn-vulkan/models-upconv_7_anime_style_art_rgb"
)

DEFAULT_GPU_ID = "1"
DEFAULT_TILE_SIZE = "128"
DEFAULT_THREADS = "1:2:2"
FINAL_DIR_NAME = "median-all"


@dataclass(frozen=True)
class UpscalePass:
    tool: str
    args: tuple[str, ...]
    scale: int


@dataclass(frozen=True)
class Variant:
    name: str
    upass: UpscalePass


def realesrgan_pass(model: str, tta: bool = False) -> UpscalePass:
    args = ["-n", model, "-s", "2"]
    if tta:
        args.append("-x")
    return UpscalePass("realesrgan-ncnn-vulkan", tuple(args), 2)


def waifu2x_pass(model_path: Path, noise: int, tta: bool = False) -> UpscalePass:
    args = ["-m", str(model_path), "-n", str(noise), "-s", "2"]
    if tta:
        args.append("-x")
    return UpscalePass("waifu2x-ncnn-vulkan", tuple(args), 2)


CUNET = WAIFU2X_CUNET_MODEL
UPCONV_ANIME = WAIFU2X_UPCONV_ANIME_MODEL

VARIANTS: tuple[Variant, ...] = (
    Variant("realesr-animevideo3", realesrgan_pass("realesr-animevideov3")),
    Variant("realesr-animevideo3-tta", realesrgan_pass("realesr-animevideov3", True)),
    Variant("waifu2x-cunet-n-1", waifu2x_pass(CUNET, -1)),
    Variant("waifu2x-cunet-n0", waifu2x_pass(CUNET, 0)),
    Variant("waifu2x-cunet-n1", waifu2x_pass(CUNET, 1)),
    Variant("waifu2x-cunet-n2", waifu2x_pass(CUNET, 2)),
    Variant("waifu2x-cunet-n3", waifu2x_pass(CUNET, 3)),
    Variant("waifu2x-cunet-n1-tta", waifu2x_pass(CUNET, 1, True)),
    Variant("waifu2x-upconv-anime-n0", waifu2x_pass(UPCONV_ANIME, 0)),
    Variant("waifu2x-upconv-anime-n1", waifu2x_pass(UPCONV_ANIME, 1)),
    Variant("waifu2x-upconv-anime-n2", waifu2x_pass(UPCONV_ANIME, 2)),
    Variant("waifu2x-upconv-anime-n3", waifu2x_pass(UPCONV_ANIME, 3)),
    Variant("waifu2x-upconv-anime-n1-tta", waifu2x_pass(UPCONV_ANIME, 1, True)),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build 2x anime-upscaled Interwheel variants and a median final set."
    )
    parser.add_argument("--gpu", default=DEFAULT_GPU_ID, help="ncnn Vulkan GPU id")
    parser.add_argument("--tile", default=DEFAULT_TILE_SIZE, help="ncnn tile size")
    parser.add_argument("--threads", default=DEFAULT_THREADS, help="ncnn load:proc:save threads")
    parser.add_argument("--tmp-root", type=Path, default=TMP_ROOT, help="temporary work root")
    parser.add_argument("--force", action="store_true", help="rebuild selected variants")
    parser.add_argument("--median-only", action="store_true", help="only rebuild the median directory")
    parser.add_argument("--no-median", action="store_true", help="skip median generation")
    parser.add_argument("--list-variants", action="store_true", help="print variants and exit")
    parser.add_argument(
        "--variant",
        action="append",
        choices=[variant.name for variant in VARIANTS],
        help="variant to build; may be supplied more than once",
    )
    return parser.parse_args()


def log(message: str) -> None:
    print(message, flush=True)


def relpath(path: Path) -> str:
    return path.as_posix()


def source_pngs() -> list[Path]:
    return sorted(path.relative_to(SOURCE_ROOT) for path in SOURCE_ROOT.rglob("*.png"))


def source_svgs() -> list[Path]:
    return sorted(path.relative_to(SOURCE_ROOT) for path in SOURCE_ROOT.rglob("*.svg"))


def png_dirs(pngs: Iterable[Path]) -> list[Path]:
    return sorted({path.parent for path in pngs})


def ensure_source_tree(pngs: list[Path], svgs: list[Path]) -> None:
    if not SOURCE_ROOT.is_dir():
        raise SystemExit(f"source asset root does not exist: {SOURCE_ROOT}")
    if len(pngs) != 416:
        raise SystemExit(f"expected 416 source PNGs, found {len(pngs)}")
    if len(svgs) != 1:
        raise SystemExit(f"expected 1 source SVG, found {len(svgs)}")


def ensure_tools() -> None:
    missing_tools = sorted({variant.upass.tool for variant in VARIANTS if shutil.which(variant.upass.tool) is None})
    if missing_tools:
        raise SystemExit(f"missing required executable(s): {', '.join(missing_tools)}")
    for model_path in (WAIFU2X_CUNET_MODEL, WAIFU2X_UPCONV_ANIME_MODEL):
        if not model_path.is_dir():
            raise SystemExit(f"missing waifu2x model directory: {model_path}")


def prepare_input_tree(tmp_root: Path, pngs: list[Path]) -> Path:
    input_tree = tmp_root / "input-png"
    if input_tree.exists():
        shutil.rmtree(input_tree)
    input_tree.mkdir(parents=True)
    hardlinked = 0
    copied = 0
    for rel in pngs:
        source = SOURCE_ROOT / rel
        target = input_tree / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(source, target)
            hardlinked += 1
        except OSError:
            shutil.copy2(source, target)
            copied += 1
    log(f"temporary input files: {hardlinked} hardlinks, {copied} copies")
    return input_tree


def copy_svgs(output_dir: Path, svgs: list[Path]) -> None:
    for rel in svgs:
        source = SOURCE_ROOT / rel
        target = output_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def exact_png_set(root: Path) -> set[Path]:
    if not root.exists():
        return set()
    return {path.relative_to(root) for path in root.rglob("*.png")}


def exact_svg_set(root: Path) -> set[Path]:
    if not root.exists():
        return set()
    return {path.relative_to(root) for path in root.rglob("*.svg")}


def variant_complete(
    output_dir: Path, pngs: list[Path], svgs: list[Path], progress: bool = False
) -> tuple[bool, str]:
    if not output_dir.is_dir():
        return False, "variant directory is missing"
    expected_pngs = set(pngs)
    actual_pngs = exact_png_set(output_dir)
    if actual_pngs != expected_pngs:
        missing = len(expected_pngs - actual_pngs)
        extra = len(actual_pngs - expected_pngs)
        return False, f"PNG set mismatch: {missing} missing, {extra} extra"
    expected_svgs = set(svgs)
    actual_svgs = exact_svg_set(output_dir)
    if actual_svgs != expected_svgs:
        missing = len(expected_svgs - actual_svgs)
        extra = len(actual_svgs - expected_svgs)
        return False, f"SVG set mismatch: {missing} missing, {extra} extra"
    for rel in svgs:
        if (SOURCE_ROOT / rel).read_bytes() != (output_dir / rel).read_bytes():
            return False, f"SVG copy differs: {relpath(rel)}"
    for index, rel in enumerate(pngs, start=1):
        target = output_dir / rel
        try:
            with Image.open(SOURCE_ROOT / rel) as source, Image.open(target) as output:
                expected = (source.width * 2, source.height * 2)
                if output.size != expected:
                    return (
                        False,
                        f"wrong size for {relpath(rel)}: {output.size}, expected {expected}",
                    )
                output.load()
        except Exception as exc:
            return False, f"invalid PNG {relpath(rel)}: {exc}"
        if progress and index % 100 == 0:
            log(f"  verified {index}/{len(pngs)} PNGs")
    return True, "complete"


def reattach_alpha(source_dir: Path, output_dir: Path, pngs: list[Path], label: str) -> None:
    for index, rel in enumerate(pngs, start=1):
        source_path = source_dir / rel
        output_path = output_dir / rel
        with Image.open(source_path) as source_image, Image.open(output_path) as output_image:
            rgba_source = source_image.convert("RGBA")
            rgba_output = output_image.convert("RGBA")
            expected = (rgba_source.width * 2, rgba_source.height * 2)
            if rgba_output.size != expected:
                raise RuntimeError(
                    f"{label}: {relpath(rel)} is {rgba_output.size}, expected {expected}"
                )
            alpha = rgba_source.getchannel("A").resize(expected, Image.Resampling.LANCZOS)
            rgba_output.putalpha(alpha)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            rgba_output.save(output_path, format="PNG")
        if index % 100 == 0 or index == len(pngs):
            log(f"  alpha {label}: {index}/{len(pngs)}")


def run_directory_batch(
    upass: UpscalePass,
    input_root: Path,
    output_root: Path,
    dirs: list[Path],
    gpu: str,
    tile: str,
    threads: str,
) -> None:
    common_args = ["-g", gpu, "-t", tile, "-j", threads, "-f", "png"]
    for index, rel_dir in enumerate(dirs, start=1):
        input_dir = input_root / rel_dir
        output_dir = output_root / rel_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        command = [
            upass.tool,
            "-i",
            str(input_dir),
            "-o",
            str(output_dir),
            *upass.args,
            *common_args,
        ]
        log(
            f"  [{index}/{len(dirs)}] {upass.tool} scale 2 "
            f"{relpath(rel_dir) if rel_dir != Path('.') else '.'}"
        )
        try:
            subprocess.run(
                command,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            if exc.stdout:
                sys.stderr.write(exc.stdout)
            raise


def build_variant(
    variant: Variant,
    pngs: list[Path],
    svgs: list[Path],
    dirs: list[Path],
    input_tree: Path,
    gpu: str,
    tile: str,
    threads: str,
    force: bool,
) -> bool:
    output_dir = OUTPUT_ROOT / variant.name
    if not force:
        complete, reason = variant_complete(output_dir, pngs, svgs)
        if complete:
            log(f"SKIP {variant.name}: already complete")
            return False
        log(f"REBUILD {variant.name}: {reason}")
    else:
        log(f"REBUILD {variant.name}: forced")

    if output_dir.exists():
        shutil.rmtree(output_dir)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    run_directory_batch(variant.upass, input_tree, output_dir, dirs, gpu, tile, threads)
    log(f"  reattaching alpha for {variant.name}")
    reattach_alpha(SOURCE_ROOT, output_dir, pngs, variant.name)
    copy_svgs(output_dir, svgs)
    complete, reason = variant_complete(output_dir, pngs, svgs, progress=True)
    if not complete:
        raise RuntimeError(f"{variant.name} failed completion check: {reason}")
    log(f"DONE {variant.name}: {reason}")
    return True


def median_sources(selected: list[Variant], pngs: list[Path], svgs: list[Path]) -> list[Path]:
    sources = []
    for variant in selected:
        output_dir = OUTPUT_ROOT / variant.name
        complete, reason = variant_complete(output_dir, pngs, svgs)
        if complete:
            sources.append(output_dir)
        else:
            log(f"SKIP median source {variant.name}: {reason}")
    if not sources:
        raise RuntimeError("no complete 2x variants are available for median generation")
    return sources


def build_median(sources: list[Path], pngs: list[Path], svgs: list[Path]) -> None:
    output_dir = PUBLIC_OUTPUT_ROOT / FINAL_DIR_NAME
    if output_dir.exists():
        shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True)
    log(f"BUILD {FINAL_DIR_NAME}: median of {len(sources)} variants")
    for index, rel in enumerate(pngs, start=1):
        stack = []
        for source in sources:
            with Image.open(source / rel) as image:
                stack.append(np.asarray(image.convert("RGBA"), dtype=np.uint8))
        median = np.median(np.stack(stack, axis=0), axis=0).round().astype(np.uint8)
        target = output_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(median, mode="RGBA").save(target, format="PNG")
        if index % 50 == 0 or index == len(pngs):
            log(f"  median: {index}/{len(pngs)}")
    copy_svgs(output_dir, svgs)
    complete, reason = variant_complete(output_dir, pngs, svgs, progress=True)
    if not complete:
        raise RuntimeError(f"{FINAL_DIR_NAME} failed completion check: {reason}")
    write_median_manifest(sources, pngs, svgs)
    log(f"DONE {FINAL_DIR_NAME}: {reason}")


def pass_manifest(upass: UpscalePass, gpu: str, tile: str, threads: str) -> dict[str, object]:
    return {
        "tool": upass.tool,
        "args": list(upass.args),
        "scale": upass.scale,
        "commonArgs": ["-g", gpu, "-t", tile, "-j", threads, "-f", "png"],
        "commandTemplate": [
            upass.tool,
            "-i",
            "<input-directory>",
            "-o",
            "<output-directory>",
            *upass.args,
            "-g",
            gpu,
            "-t",
            tile,
            "-j",
            threads,
            "-f",
            "png",
        ],
    }


def write_manifest(
    selected: list[Variant],
    pngs: list[Path],
    svgs: list[Path],
    gpu: str,
    tile: str,
    threads: str,
) -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    variants = []
    for variant in selected:
        output_dir = OUTPUT_ROOT / variant.name
        complete, reason = variant_complete(output_dir, pngs, svgs)
        variants.append(
            {
                "name": variant.name,
                "complete": complete,
                "status": reason,
                "pass": pass_manifest(variant.upass, gpu, tile, threads),
                "pngCount": len(pngs) if complete else len(exact_png_set(output_dir)),
                "svgCount": len(svgs) if complete else len(exact_svg_set(output_dir)),
            }
        )
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceRoot": str(SOURCE_ROOT.relative_to(REPO_ROOT)),
        "outputRoot": str(OUTPUT_ROOT.relative_to(REPO_ROOT)),
        "source": {
            "pngCount": len(pngs),
            "svgCount": len(svgs),
            "pngFiles": [relpath(path) for path in pngs],
            "svgFiles": [relpath(path) for path in svgs],
        },
        "settings": {
            "gpuId": gpu,
            "tileSize": tile,
            "threads": threads,
            "format": "png",
            "finalScale": 2,
        },
        "alphaPolicy": {
            "description": (
                "Model-generated RGB is retained. Source alpha is resized with Pillow "
                "Lanczos and written back after each 2x pass."
            ),
        },
        "variants": variants,
        "final": {
            "name": FINAL_DIR_NAME,
            "root": str((PUBLIC_OUTPUT_ROOT / FINAL_DIR_NAME).relative_to(REPO_ROOT)),
            "method": "per-channel median of complete selected variants",
        },
    }
    (OUTPUT_ROOT / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def write_median_manifest(sources: list[Path], pngs: list[Path], svgs: list[Path]) -> None:
    output_dir = PUBLIC_OUTPUT_ROOT / FINAL_DIR_NAME
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceRoot": str(SOURCE_ROOT.relative_to(REPO_ROOT)),
        "outputRoot": str(output_dir.relative_to(REPO_ROOT)),
        "method": "per-channel median",
        "scale": 2,
        "sourceVariants": [source.name for source in sources],
        "pngCount": len(pngs),
        "svgCount": len(svgs),
    }
    (output_dir / "median-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def selected_variants(names: list[str] | None) -> list[Variant]:
    if not names:
        return list(VARIANTS)
    wanted = set(names)
    return [variant for variant in VARIANTS if variant.name in wanted]


def main() -> int:
    args = parse_args()
    if args.list_variants:
        for variant in VARIANTS:
            print(variant.name)
        return 0

    pngs = source_pngs()
    svgs = source_svgs()
    ensure_source_tree(pngs, svgs)
    ensure_tools()
    dirs = png_dirs(pngs)
    variants = selected_variants(args.variant)

    log(f"source PNGs: {len(pngs)}")
    log(f"source SVGs: {len(svgs)}")
    log(f"source directories with PNGs: {len(dirs)}")
    log(f"selected variants: {len(variants)}")
    log(f"gpu/tile/threads: {args.gpu}/{args.tile}/{args.threads}")

    if not args.median_only:
        input_tree = prepare_input_tree(args.tmp_root, pngs)
        for index, variant in enumerate(variants, start=1):
            log(f"VARIANT {index}/{len(variants)} {variant.name}")
            build_variant(
                variant,
                pngs,
                svgs,
                dirs,
                input_tree,
                args.gpu,
                args.tile,
                args.threads,
                args.force,
            )
            write_manifest(variants, pngs, svgs, args.gpu, args.tile, args.threads)

    if not args.no_median:
        sources = median_sources(variants, pngs, svgs)
        build_median(sources, pngs, svgs)
        write_manifest(variants, pngs, svgs, args.gpu, args.tile, args.threads)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
