#!/usr/bin/env python3
"""大肥鱼衣橱 · 立绘/服装图层合成工具（换装游戏 2.0 分层管线）

所有图层都画在同一块 900×1500 画布上，再统一缩放到 720×1200 导出 WebP。
游戏里把「背景 / 底座 / 裙子 / 头饰」几张同尺寸透明图直接叠起来就能对齐，
不需要为每种搭配重新合成整图。

子命令:
  base <立绘.png> <out.webp>
      生成底座图层（裁透明边、按 700px 高居中放到画布）。

  gown <裙子.png> <out.webp>
      生成裙子图层（自动去白底 + 裙腰接触阴影）。裙子白底是必需的上游约定。

  hat <头饰.png> <out.webp> --width 0.34 --top 0.10 [--x 0.5] [--shadow]
      生成头饰图层：按画布宽度比例缩放、水平居中、贴到指定高度。
      头饰图要求纯白底、只有配饰、没有人物。

  full <立绘.png> <裙子.png> <out.png|webp> [--no-shadow]
      生成整图（预览/README 用，等价于 base + gown 合成）。

  compose <立绘.png> <裙子.png> <out.webp>
      旧版兼容别名（= full 且存 webp）。

常用命令（在仓库根目录执行）:
  python3 tools/compose_dress.py base tools/source/classic-base-hires.png docs/dress-up/art/base.webp
  python3 tools/compose_dress.py gown tools/source/skirt-starry.png docs/dress-up/art/gown-starry.webp
  python3 tools/compose_dress.py hat  tools/source/hat-whale.png  docs/dress-up/art/hat-whale.webp --width 0.40 --top 0.075
"""
import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

# 内部画布：900×1500；角色 700px 高、顶部留 180px；裙子贴在下巴以下（保留围裙/上身）
W, H = 900, 1500
CHAR_H = 700
CHAR_TOP = 180
SKIRT_TOP = 614  # just under the shoulders: blouse + apron stay visible
SKIRT_MAX_W = 860
SKIRT_MAX_H = 640
OUT_W, OUT_H = 720, 1200

# 裙子压在身体上，裙腰处需要一点投影——只用裙子上部 42% 的 alpha 做遮罩，向下淡出
SHADOW_BAND = 0.42
SHADOW_RGBA = (10, 20, 60, 150)
SHADOW_BLUR = 9


def trim_white(src: str, thresh: int = 24) -> Image.Image:
    """去掉白底（从四角泛洪），返回按内容裁切后的透明 PNG。"""
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    probe = im.convert('RGB')
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(probe, corner, (255, 0, 255), thresh=thresh)
    px = probe.load()
    op = im.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == (255, 0, 255):
                op[x, y] = (0, 0, 0, 0)
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im


def trim_alpha(src: str) -> Image.Image:
    """裁掉透明边距（底座图用）。"""
    im = Image.open(src).convert('RGBA')
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im


def blank() -> Image.Image:
    return Image.new('RGBA', (W, H), (0, 0, 0, 0))


def base_layer(base_path: str) -> Image.Image:
    canvas = blank()
    base = trim_alpha(base_path)
    scale = CHAR_H / base.height
    base = base.resize((round(base.width * scale), CHAR_H), Image.LANCZOS)
    canvas.alpha_composite(base, ((W - base.width) // 2, CHAR_TOP))
    return canvas


def skirt_shadow(skirt: Image.Image) -> Image.Image:
    """裙子上缘的柔和接触阴影：越靠裙腰越深，向下淡出。"""
    mask = Image.new('L', skirt.size, 0)
    band = max(1, int(skirt.height * SHADOW_BAND))
    for y in range(band):
        mask.paste(int(SHADOW_RGBA[3] * (1 - y / band) ** 1.6), (0, y, skirt.width, y + 1))
    alpha = Image.composite(skirt.getchannel('A'), Image.new('L', skirt.size, 0), mask)
    shadow = Image.new('RGBA', skirt.size, SHADOW_RGBA[:3] + (0,))
    shadow.putalpha(alpha.filter(ImageFilter.GaussianBlur(SHADOW_BLUR)))
    return shadow


def gown_layer(skirt_path: str, shadow: bool = True) -> Image.Image:
    canvas = blank()
    skirt = trim_white(skirt_path)
    ratio = min(SKIRT_MAX_W / skirt.width, SKIRT_MAX_H / skirt.height)
    skirt = skirt.resize((max(1, round(skirt.width * ratio)), max(1, round(skirt.height * ratio))), Image.LANCZOS)
    pos = ((W - skirt.width) // 2, SKIRT_TOP)
    if shadow:
        canvas.alpha_composite(skirt_shadow(skirt), (pos[0], pos[1] + 2))
    canvas.alpha_composite(skirt, pos)
    return canvas


def hat_layer(hat_path: str, width: float, top: float, x: float = 0.5, shadow: bool = False) -> Image.Image:
    canvas = blank()
    hat = trim_white(hat_path)
    target_w = max(1, round(W * max(0.05, min(1.0, width))))
    ratio = target_w / hat.width
    hat = hat.resize((target_w, max(1, round(hat.height * ratio))), Image.LANCZOS)
    pos = (round(W * x - hat.width / 2), round(H * max(0.0, min(1.0, top))))
    if shadow:
        sh = Image.new('RGBA', hat.size, (10, 20, 60, 0))
        sh.putalpha(hat.getchannel('A').filter(ImageFilter.GaussianBlur(6)))
        canvas.alpha_composite(sh, (pos[0], pos[1] + 4))
    canvas.alpha_composite(hat, pos)
    return canvas


def save(canvas: Image.Image, out_path: str) -> None:
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    img = canvas.resize((OUT_W, OUT_H), Image.LANCZOS)
    if out.suffix.lower() == '.webp':
        img.save(out, 'WEBP', quality=90, method=6)
    else:
        img.save(out, 'PNG', optimize=True)
    print(f'wrote {out} {img.size} {out.stat().st_size // 1024}KB')


def full_image(base_path: str, skirt_path: str | None, shadow: bool = True) -> Image.Image:
    canvas = base_layer(base_path)
    if skirt_path:
        canvas.alpha_composite(gown_layer(skirt_path, shadow=shadow))
    return canvas


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='大肥鱼衣橱图层合成', add_help=False)
    parser.add_argument('command', nargs='?')
    parser.add_argument('args', nargs='*')
    parser.add_argument('--width', type=float, default=0.34)
    parser.add_argument('--top', type=float, default=0.10)
    parser.add_argument('--x', type=float, default=0.5)
    parser.add_argument('--shadow', action='store_true')
    parser.add_argument('--no-shadow', action='store_true')
    known, rest = parser.parse_known_args(argv)
    args = known.args + rest
    cmd = known.command

    if cmd == 'base' and len(args) == 2:
        save(base_layer(args[0]), args[1])
    elif cmd == 'gown' and len(args) == 2:
        save(gown_layer(args[0], shadow=not known.no_shadow), args[1])
    elif cmd == 'hat' and len(args) == 2:
        save(hat_layer(args[0], known.width, known.top, x=known.x, shadow=known.shadow), args[1])
    elif cmd in ('full', 'compose') and len(args) == 3:
        save(full_image(args[0], args[1], shadow=not known.no_shadow), args[2])
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
