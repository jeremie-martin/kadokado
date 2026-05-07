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

from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = REPO_ROOT / "public" / "assets" / "interwheel"
OUTPUT_ROOT = REPO_ROOT / "generated-assets" / "interwheel-upscale" / "interwheel-4x"
TMP_ROOT = Path("/tmp/interwheel-upscale-holo")
INPUT_TREE = TMP_ROOT / "input-png"
WORK_ROOT = TMP_ROOT / "work"

WAIFU2X_CUNET_MODEL = Path.home() / ".local/share/waifu2x-ncnn-vulkan/models-cunet"
WAIFU2X_UPCONV_ANIME_MODEL = (
    Path.home() / ".local/share/waifu2x-ncnn-vulkan/models-upconv_7_anime_style_art_rgb"
)

DEFAULT_GPU_ID = "1"
DEFAULT_TILE_SIZE = "128"
DEFAULT_THREADS = "1:2:2"


@dataclass(frozen=True)
class UpscalePass:
    tool: str
    args: tuple[str, ...]
    scale: int


@dataclass(frozen=True)
class Variant:
    name: str
    passes: tuple[UpscalePass, ...]


def realesrgan_pass(model: str, scale: int, tta: bool = False) -> UpscalePass:
    args = ["-n", model, "-s", str(scale)]
    if tta:
        args.append("-x")
    return UpscalePass("realesrgan-ncnn-vulkan", tuple(args), scale)


def waifu2x_pass(model_path: Path, noise: int, scale: int, tta: bool = False) -> UpscalePass:
    args = ["-m", str(model_path), "-n", str(noise), "-s", str(scale)]
    if tta:
        args.append("-x")
    return UpscalePass("waifu2x-ncnn-vulkan", tuple(args), scale)


CUNET = WAIFU2X_CUNET_MODEL
UPCONV_ANIME = WAIFU2X_UPCONV_ANIME_MODEL

VARIANTS: tuple[Variant, ...] = (
    Variant("realesrgan-anime6b", (realesrgan_pass("realesrgan-x4plus-anime", 4),)),
    Variant("realesrgan-anime6b-tta", (realesrgan_pass("realesrgan-x4plus-anime", 4, True),)),
    Variant("realesr-animevideo3", (realesrgan_pass("realesr-animevideov3", 4),)),
    Variant("realesr-animevideo3-tta", (realesrgan_pass("realesr-animevideov3", 4, True),)),
    Variant("waifu2x-cunet-n-1", (waifu2x_pass(CUNET, -1, 4),)),
    Variant("waifu2x-cunet-n0", (waifu2x_pass(CUNET, 0, 4),)),
    Variant("waifu2x-cunet-n1", (waifu2x_pass(CUNET, 1, 4),)),
    Variant("waifu2x-cunet-n2", (waifu2x_pass(CUNET, 2, 4),)),
    Variant("waifu2x-cunet-n3", (waifu2x_pass(CUNET, 3, 4),)),
    Variant("waifu2x-cunet-n1-tta", (waifu2x_pass(CUNET, 1, 4, True),)),
    Variant("waifu2x-upconv-anime-n0", (waifu2x_pass(UPCONV_ANIME, 0, 4),)),
    Variant("waifu2x-upconv-anime-n1", (waifu2x_pass(UPCONV_ANIME, 1, 4),)),
    Variant("waifu2x-upconv-anime-n2", (waifu2x_pass(UPCONV_ANIME, 2, 4),)),
    Variant("waifu2x-upconv-anime-n3", (waifu2x_pass(UPCONV_ANIME, 3, 4),)),
    Variant("waifu2x-upconv-anime-n1-tta", (waifu2x_pass(UPCONV_ANIME, 1, 4, True),)),
    Variant(
        "realesr-animevideo3-x2x2",
        (
            realesrgan_pass("realesr-animevideov3", 2),
            realesrgan_pass("realesr-animevideov3", 2),
        ),
    ),
    Variant(
        "realesr-animevideo3-x2x2-tta",
        (
            realesrgan_pass("realesr-animevideov3", 2, True),
            realesrgan_pass("realesr-animevideov3", 2, True),
        ),
    ),
    Variant(
        "waifu2x-cunet-n0-x2x2",
        (waifu2x_pass(CUNET, 0, 2), waifu2x_pass(CUNET, 0, 2)),
    ),
    Variant(
        "waifu2x-cunet-n1-x2x2",
        (waifu2x_pass(CUNET, 1, 2), waifu2x_pass(CUNET, 1, 2)),
    ),
    Variant(
        "waifu2x-cunet-n0-n1-x2x2",
        (waifu2x_pass(CUNET, 0, 2), waifu2x_pass(CUNET, 1, 2)),
    ),
    Variant(
        "waifu2x-upconv-anime-n0-x2x2",
        (waifu2x_pass(UPCONV_ANIME, 0, 2), waifu2x_pass(UPCONV_ANIME, 0, 2)),
    ),
    Variant(
        "waifu2x-upconv-anime-n1-x2x2",
        (waifu2x_pass(UPCONV_ANIME, 1, 2), waifu2x_pass(UPCONV_ANIME, 1, 2)),
    ),
    Variant(
        "waifu2x-upconv-anime-n0-n1-x2x2",
        (waifu2x_pass(UPCONV_ANIME, 0, 2), waifu2x_pass(UPCONV_ANIME, 1, 2)),
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build 4x anime-upscaled Interwheel asset variants."
    )
    parser.add_argument("--gpu", default=DEFAULT_GPU_ID, help="ncnn Vulkan GPU id")
    parser.add_argument("--tile", default=DEFAULT_TILE_SIZE, help="ncnn tile size")
    parser.add_argument("--threads", default=DEFAULT_THREADS, help="ncnn load:proc:save threads")
    parser.add_argument("--tmp-root", type=Path, default=TMP_ROOT, help="temporary work root")
    parser.add_argument("--force", action="store_true", help="rebuild selected variants")
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
    missing_tools = sorted({p.tool for variant in VARIANTS for p in variant.passes if shutil.which(p.tool) is None})
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


def expected_size(source_rel: Path, scale: int) -> tuple[int, int]:
    with Image.open(SOURCE_ROOT / source_rel) as source:
        return source.width * scale, source.height * scale


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
                expected = (source.width * 4, source.height * 4)
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


def reattach_alpha(source_dir: Path, output_dir: Path, pngs: list[Path], scale: int, label: str) -> None:
    for index, rel in enumerate(pngs, start=1):
        source_path = source_dir / rel
        output_path = output_dir / rel
        with Image.open(source_path) as source_image, Image.open(output_path) as output_image:
            rgba_source = source_image.convert("RGBA")
            rgba_output = output_image.convert("RGBA")
            expected = (rgba_source.width * scale, rgba_source.height * scale)
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
            f"  [{index}/{len(dirs)}] {upass.tool} scale {upass.scale} "
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
    tmp_root: Path,
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
    pass_work_root = tmp_root / "work" / variant.name
    if pass_work_root.exists():
        shutil.rmtree(pass_work_root)

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    if len(variant.passes) == 1:
        run_directory_batch(
            variant.passes[0], input_tree, output_dir, dirs, gpu, tile, threads
        )
        log(f"  reattaching final alpha for {variant.name}")
        reattach_alpha(SOURCE_ROOT, output_dir, pngs, 4, "final")
    elif len(variant.passes) == 2:
        pass1_root = pass_work_root / "pass1"
        run_directory_batch(
            variant.passes[0], input_tree, pass1_root, dirs, gpu, tile, threads
        )
        log(f"  reattaching pass1 alpha for {variant.name}")
        reattach_alpha(SOURCE_ROOT, pass1_root, pngs, 2, "pass1")
        run_directory_batch(
            variant.passes[1], pass1_root, output_dir, dirs, gpu, tile, threads
        )
        log(f"  reattaching final alpha for {variant.name}")
        reattach_alpha(SOURCE_ROOT, output_dir, pngs, 4, "final")
    else:
        raise RuntimeError(f"unsupported pass count for {variant.name}: {len(variant.passes)}")

    copy_svgs(output_dir, svgs)
    complete, reason = variant_complete(output_dir, pngs, svgs, progress=True)
    if not complete:
        raise RuntimeError(f"{variant.name} failed completion check: {reason}")
    log(f"DONE {variant.name}: {reason}")
    return True


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
    variant_entries = []
    for variant in selected:
        output_dir = OUTPUT_ROOT / variant.name
        complete, reason = variant_complete(output_dir, pngs, svgs)
        variant_entries.append(
            {
                "name": variant.name,
                "complete": complete,
                "status": reason,
                "passes": [pass_manifest(upass, gpu, tile, threads) for upass in variant.passes],
                "pngCount": len(pngs) if complete else len(exact_png_set(output_dir)),
                "svgCount": len(svgs) if complete else len(exact_svg_set(output_dir)),
            }
        )
    manifest = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "sourceRoot": str(SOURCE_ROOT.relative_to(REPO_ROOT)),
        "outputRoot": str(OUTPUT_ROOT.relative_to(REPO_ROOT)),
        "tmpRoot": str(TMP_ROOT),
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
        },
        "alphaPolicy": {
            "description": (
                "Model-generated RGB is retained. Source alpha is resized with Pillow "
                "Lanczos and written back after each direct pass, after chained pass1, "
                "and after chained final output."
            ),
            "finalScale": 4,
            "intermediateScaleForChainedPass1": 2,
        },
        "inputTreePolicy": {
            "path": str(INPUT_TREE),
            "description": (
                "Temporary PNG input tree uses regular files via hardlink where possible, "
                "with copy fallback, because the local ncnn directory loaders skip symlinked "
                "PNG entries. Source assets are not modified."
            ),
        },
        "variants": variant_entries,
    }
    (OUTPUT_ROOT / "manifest.json").write_text(
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

    global TMP_ROOT, INPUT_TREE, WORK_ROOT
    TMP_ROOT = args.tmp_root
    INPUT_TREE = TMP_ROOT / "input-png"
    WORK_ROOT = TMP_ROOT / "work"

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

    input_tree = prepare_input_tree(TMP_ROOT, pngs)
    for index, variant in enumerate(variants, start=1):
        log(f"VARIANT {index}/{len(variants)} {variant.name}")
        built = build_variant(
            variant,
            pngs,
            svgs,
            dirs,
            input_tree,
            TMP_ROOT,
            args.gpu,
            args.tile,
            args.threads,
            args.force,
        )
        write_manifest(variants, pngs, svgs, args.gpu, args.tile, args.threads)
        if built:
            log(f"manifest updated after {variant.name}")

    write_manifest(variants, pngs, svgs, args.gpu, args.tile, args.threads)
    log(f"manifest written: {OUTPUT_ROOT / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
