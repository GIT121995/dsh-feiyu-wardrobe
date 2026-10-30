#!/usr/bin/env python3
"""把 AI 生成的裙子立绘处理成网页素材：去白底 → 裁切 → 统一高度 → PNG。

用法:
  python3 tools/prepare_dress.py raw.png docs/dress-up/dresses/starry.png
"""
import sys
from PIL import Image, ImageDraw

def trim_white(src: str) -> Image.Image:
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    probe = im.convert('RGB')
    d = ImageDraw.Draw(probe)
    magenta = (255, 0, 255)
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(probe, corner, magenta, thresh=26)
    px = probe.load()
    out = im.copy()
    op = out.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == magenta:
                op[x, y] = (0, 0, 0, 0)
    bbox = out.getbbox()
    return out.crop(bbox) if bbox else out

def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    src, dst = sys.argv[1], sys.argv[2]
    im = trim_white(src)
    target_h = 1200
    scale = target_h / im.height
    im = im.resize((max(1, round(im.width * scale)), target_h), Image.LANCZOS)
    im.save(dst, 'PNG', optimize=True)
    print(f'{src} -> {dst} ({im.width}x{im.height})')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
