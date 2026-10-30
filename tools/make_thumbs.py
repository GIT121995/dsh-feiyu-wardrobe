#!/usr/bin/env python3
"""从换装间图层生成衣柜缩略图（docs/dress-up/art/thumbs/*.webp）。

用法（仓库根目录）:
  python3 tools/make_thumbs.py

规则：
  裙子   —— 取图层内容裁切，等比缩进 200×200 的小方格，底部对齐（裙摆完整露出来）
  外套   —— 取内容裁切，居中缩进小方格
  头饰   —— 取内容裁切，居中缩进小方格
  背景   —— 居中裁切成正方形（cover）
  底座   —— 全身缩进小方格（经典原装那格用）
"""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / 'docs' / 'dress-up'
THUMB = ART / 'art' / 'thumbs'
BOX = 200
MARGIN = 6


def contain(img: Image.Image, box: int = BOX - MARGIN * 2) -> Image.Image:
    ratio = min(box / img.width, box / img.height)
    return img.resize((max(1, round(img.width * ratio)), max(1, round(img.height * ratio))), Image.LANCZOS)


def on_square(img: Image.Image, *, bottom: bool = False) -> Image.Image:
    canvas = Image.new('RGBA', (BOX, BOX), (0, 0, 0, 0))
    x = (BOX - img.width) // 2
    y = BOX - MARGIN - img.height if bottom else (BOX - img.height) // 2
    canvas.alpha_composite(img, (x, y))
    return canvas


def trim_alpha(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def layer_thumb(file: str, *, bottom: bool = False) -> Image.Image:
    img = trim_alpha(Image.open(ART / file).convert('RGBA'))
    return on_square(contain(img), bottom=bottom)


def cover_thumb(file: str) -> Image.Image:
    img = Image.open(ART / file).convert('RGB')
    side = min(img.width, img.height)
    img = img.crop(((img.width - side) // 2, (img.height - side) // 2,
                    (img.width + side) // 2, (img.height + side) // 2))
    return img.resize((BOX, BOX), Image.LANCZOS)


def save(img: Image.Image, name: str) -> Path:
    THUMB.mkdir(parents=True, exist_ok=True)
    out = THUMB / f'{name}.webp'
    img.save(out, 'WEBP', quality=86, method=6)
    return out


def main() -> None:
    manifest = json.loads((ART / 'manifest.json').read_text())
    written = 0
    for gown in manifest['gowns']:
        if gown.get('file'):
            img = layer_thumb(gown['file'], bottom=True)
        else:  # 经典原装：直接拿底座全身
            img = layer_thumb(manifest['base'], bottom=True)
        save(img, Path(gown['thumb']).stem)
        written += 1
    for coat in manifest['coats']:
        if coat.get('file'):
            save(layer_thumb(coat['file']), Path(coat['thumb']).stem)
            written += 1
    for hat in manifest['hats']:
        if hat.get('file'):
            save(layer_thumb(hat['file']), Path(hat['thumb']).stem)
            written += 1
    for bg in manifest['backgrounds']:
        save(cover_thumb(bg['file']), Path(bg['thumb']).stem)
        written += 1
    print(f'wrote {written} thumbnails -> {THUMB}')


if __name__ == '__main__':
    main()
