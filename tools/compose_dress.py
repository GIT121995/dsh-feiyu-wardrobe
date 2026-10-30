#!/usr/bin/env python3
"""把 AI 生成的裙子图层合成到经典立绘底座上（Q版比例，腰部对齐）。

用法:
  python3 tools/compose_dress.py base.png skirt.png out.png [名字]
"""
import sys
from PIL import Image, ImageDraw

W, H = 900, 1500
CHAR_H = 700
CHAR_TOP = 180
SKIRT_TOP = 614  # just under the shoulders: blouse + apron stay visible
SKIRT_MAX_W = 860
SKIRT_MAX_H = 640


def trim_white(src: str, thresh: int = 24) -> Image.Image:
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


def compose(base_path: str, skirt_path: str | None, out_path: str) -> None:
    canvas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    base = Image.open(base_path).convert('RGBA')
    scale = CHAR_H / base.height
    base = base.resize((round(base.width * scale), CHAR_H), Image.LANCZOS)
    canvas.alpha_composite(base, ((W - base.width) // 2, CHAR_TOP))
    if skirt_path:
        skirt = trim_white(skirt_path)
        ratio = min(SKIRT_MAX_W / skirt.width, SKIRT_MAX_H / skirt.height)
        skirt = skirt.resize((max(1, round(skirt.width * ratio)), max(1, round(skirt.height * ratio))), Image.LANCZOS)
        canvas.alpha_composite(skirt, ((W - skirt.width) // 2, SKIRT_TOP))
    bbox = canvas.getbbox()
    if bbox:
        pad = 24
        left, top = max(0, bbox[0] - pad), max(0, bbox[1] - pad)
        right, bottom = min(W, bbox[2] + pad), min(H, bbox[3] + pad)
        canvas = canvas.crop((left, top, right, bottom))
    target_h = 1200
    scale = target_h / canvas.height
    canvas = canvas.resize((max(1, round(canvas.width * scale)), target_h), Image.LANCZOS)
    canvas.save(out_path, 'PNG', optimize=True)
    print(f'composed {out_path} {canvas.size}')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        raise SystemExit(1)
    compose(sys.argv[1], None if sys.argv[2] == '-' else sys.argv[2], sys.argv[3])
