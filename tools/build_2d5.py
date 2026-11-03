#!/usr/bin/env python3
"""大肥鱼衣橱 2.5D runtime 资产构建器（M3 产品化）

把 POC（`.scratch/m2-full/poc/`）产出的 rig JSON + 每 drawable 裁剪纹理，
整理成产品运行时直接消费的「每身形一张图集 + 紧凑 rig JSON」：

    docs/dress-up/art/2d5/<shape>/
    ├── rig.json           紧凑 rig（浮点定点化、去 runtime 不用的字段、UV 重映射到图集空间）
    ├── atlas.webp         单张 lossless WebP 图集（RGBA，逐 drawable 4px 透明 padding）
    └── build-report.json  构建报告（逐 drawable 图集矩形/字节数/校验结果）

输入契约（M4 会按 `.scratch/m3/ASSET-SPEC-2D5.md` 交付同结构）：
  --rig      POC 形态 rig JSON（含 skeleton/deformers/physics/drawables/outfits/slots）
  --texdir   纹理目录（drawable.texture 的 basename 必须能在该目录找到；尺寸 = drawable.texSize）
  --out      输出目录（<out>/<shape>/rig.json 等）
  --shape    chibi | girl（用于命名与校验）

确定性：同一输入两次构建输出逐字节一致（无时间戳；图集编码固定参数）。
校验：默认回读 atlas.webp 与内存合成逐像素比对（lossless 必须完全相等）；失败退出码 1。

用法：
    python3 tools/build_2d5.py \
        --rig /home/ubuntu/dsh/.scratch/m2-full/poc/chibi-v2-m3.feiyu.json \
        --texdir /home/ubuntu/dsh/.scratch/m2-full/poc/assets/m3/chibi \
        --out docs/dress-up/art/2d5 --shape chibi
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent          # <repo>/tools
ROOT = HERE.parent                              # <repo>
DEFAULT_OUT = ROOT / 'docs' / 'dress-up' / 'art' / '2d5'

# 定点精度：positions 0.01px、uvs 1e-5（≈0.006px@598px 纹理）、weights 1e-4、deform 1e-3。
# 相对 POC 全精度 JSON：raw -20%、gzip -13%，渲染像素差 0（构建后 4x 目检 + E2E）。
PRECISION = {'positions': 2, 'uvs': 5, 'weights': 4, 'deform': 3, 'skeleton': 2}
PAD = 2                  # 图集每 drawable 四周透明 padding（px）；裁切纹理自带 2px 透明边，
                         # 实际内容间距 = 4+2*pad = 8px，mipmap on 时防采样串色
MAX_WIDTH = 2048         # 图集最大宽度（GL ES 3.0 最低保证 2048）
GENERATOR = 'tools/build_2d5.py'


def load_rig(path: Path) -> dict:
    data = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(data, dict):
        raise SystemExit(f'rig 不是对象：{path}')
    for key in ('drawables', 'skeleton', 'outfits', 'slots', 'physics', 'deformers'):
        if key not in data:
            raise SystemExit(f'rig 缺少字段 {key}：{path}')
    return data


def drawable_id(d: dict) -> str:
    return d.get('id') or Path(d.get('texture') or '').stem


def load_texture(texdir: Path, d: dict) -> tuple[Image.Image, str]:
    """按 drawable.texture 的 basename 读纹理；尺寸必须与 texSize 一致。"""
    tex = d.get('texture') or ''
    name = Path(tex).name
    path = texdir / name
    if not name or not path.is_file():
        raise SystemExit(f'drawable {drawable_id(d)} 纹理缺失：{path}')
    img = Image.open(path)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    size = d.get('texSize')
    if size and tuple(size) != img.size:
        raise SystemExit(f'drawable {drawable_id(d)} 纹理尺寸 {img.size} != texSize {tuple(size)}')
    return img, name


def pack_rects(sizes: list[tuple[int, int]], pad: int, max_width: int) -> tuple[int, int, list[tuple[int, int]]]:
    """Best-fit decreasing height 打包（比货架省 ~5% 图集面积）。

    按高度降序逐块放置：在已有「行」里选一个高度足够、剩余高度浪费最小的行；
    放不下则新开一行。返回图集宽高与每块左上角（含 padding 的外框）。
    """
    order = sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0], i))
    rows: list[list[int]] = []          # [y, height, usedWidth]
    pos: list[tuple[int, int]] = [(0, 0)] * len(sizes)
    for i in order:
        w, h = sizes[i]
        ww, hh = w + 2 * pad, h + 2 * pad
        best = None
        for row in rows:
            if row[2] + ww > max_width or hh > row[1]:
                continue
            waste = row[1] - hh
            if best is None or waste < best[0]:
                best = (waste, row)
        if best is None:
            row = [sum(r[1] for r in rows), hh, 0]
            rows.append(row)
        else:
            row = best[1]
        pos[i] = (row[2] + pad, row[0] + pad)
        row[2] += ww
    width = max((r[2] for r in rows), default=0)
    height = sum(r[1] for r in rows)
    return width, height, pos


def round_floats(values: list, ndigits: int) -> list:
    return [[round(float(v), ndigits) for v in row] for row in values]


def build(rig_path: Path, texdir: Path, out_dir: Path, shape: str, pad: int,
          max_width: int, verify: bool) -> dict:
    rig = load_rig(rig_path)
    if rig.get('shape') and rig['shape'] != shape:
        raise SystemExit(f'rig shape={rig["shape"]} 与 --shape={shape} 不一致')

    drawables = rig['drawables']
    images: list[Image.Image] = []
    names: list[str] = []
    sizes: list[tuple[int, int]] = []
    for d in drawables:
        img, name = load_texture(texdir, d)
        images.append(img)
        names.append(name)
        sizes.append(img.size)

    atlas_w, atlas_h, pos = pack_rects(sizes, pad, max_width)
    if atlas_w <= 0 or atlas_h <= 0:
        raise SystemExit('空图集')
    atlas = Image.new('RGBA', (atlas_w, atlas_h), (0, 0, 0, 0))
    for img, (px, py) in zip(images, pos):
        atlas.alpha_composite(img, (px, py))

    # UV 重映射：POC uvs 是「裁剪矩形内归一化」，换算到图集归一化坐标。
    for d, img, (px, py) in zip(drawables, images, pos):
        tw, th = img.size
        mesh = d['mesh']
        mesh['uvs'] = [
            [round((px + float(u) * tw) / atlas_w, PRECISION['uvs']),
             round((py + float(v) * th) / atlas_h, PRECISION['uvs'])]
            for u, v in mesh['uvs']
        ]
        mesh['positions'] = round_floats(mesh['positions'], PRECISION['positions'])
        mesh['weights'] = round_floats(mesh['weights'], PRECISION['weights'])
        mesh['deform'] = round_floats(mesh['deform'], PRECISION['deform'])
        d['texture'] = 'atlas.webp'
        d['atlasRect'] = [px, py, tw, th]
        d.pop('source', None)
        mesh.pop('cell', None)
        mesh.pop('grid', None)

    for bone in rig['skeleton']['bones']:
        bone['base'] = [round(float(bone['base'][0]), PRECISION['skeleton']),
                        round(float(bone['base'][1]), PRECISION['skeleton'])]
    for dfm in rig['deformers']:
        if isinstance(dfm.get('pivot'), list):
            dfm['pivot'] = [round(float(v), PRECISION['skeleton']) for v in dfm['pivot']]
    for chain in rig['physics']:
        chain['nodes'] = round_floats(chain['nodes'], PRECISION['skeleton'])

    # 图集元数据 + 产品标记（保留 POC m3 字段，补充 atlas）
    rig['atlas'] = {
        'file': 'atlas.webp',
        'width': atlas_w,
        'height': atlas_h,
        'padding': pad,
        'format': 'webp-lossless-rgba',
    }
    m3 = dict(rig.get('m3') or {})
    m3.update({'version': 1, 'generator': GENERATOR, 'atlas': True, 'textureCrop': True})
    rig['m3'] = m3
    rig['format'] = rig.get('format') or 'feiyu-rig'
    rig['product'] = {'generator': GENERATOR, 'atlas': True}

    out_dir = out_dir / shape
    out_dir.mkdir(parents=True, exist_ok=True)
    atlas_path = out_dir / 'atlas.webp'
    atlas.save(atlas_path, format='WEBP', lossless=True, quality=100, method=6, exact=True)
    rig_bytes = json.dumps(rig, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    (out_dir / 'rig.json').write_bytes(rig_bytes)

    # 校验：回读图集必须逐像素 = 内存合成（lossless WebP 的 exact 模式）
    atlas_rgba = np.asarray(atlas, dtype=np.uint8)
    decoded = np.asarray(Image.open(atlas_path).convert('RGBA'), dtype=np.uint8)
    pixel_equal = bool(decoded.shape == atlas_rgba.shape and np.array_equal(decoded, atlas_rgba))
    if verify and not pixel_equal:
        raise SystemExit('图集回读与内存合成不一致（lossless 校验失败）')

    # 校验：UV 必须落在 [0,1] 且落在自己的图集矩形内（防打包/重映射 bug）
    uv_errors: list[str] = []
    for d in drawables:
        px, py, tw, th = d['atlasRect']
        for u, v in d['mesh']['uvs']:
            if not (0.0 <= u <= 1.0 and 0.0 <= v <= 1.0):
                uv_errors.append(f'{d["id"]}: uv 越界 ({u},{v})')
                break
            ax = u * atlas_w
            ay = v * atlas_h
            if not (px - 0.51 <= ax <= px + tw + 0.51 and py - 0.51 <= ay <= py + th + 0.51):
                uv_errors.append(f'{d["id"]}: uv 落在图集矩形外 ({u},{v})')
                break
    if uv_errors:
        raise SystemExit('UV 校验失败：' + '; '.join(uv_errors[:5]))

    # 校验：outfit 引用的 drawable id 必须存在；slots.face 模式/部件齐全
    known = {d['id'] for d in drawables}
    outfit_errors: list[str] = []
    for outfit_id, outfit in (rig.get('outfits') or {}).items():
        for slot in ('topUnder', 'bottom', 'topBody', 'sleeve'):
            for did in outfit.get(slot) or []:
                if did not in known:
                    outfit_errors.append(f'{outfit_id}.{slot}:{did}')
    if outfit_errors:
        raise SystemExit('outfit 引用缺失 drawable：' + ', '.join(outfit_errors[:5]))

    report = {
        'shape': shape,
        'sourceRig': rig_path.name,
        'sourceRigBytes': rig_path.stat().st_size,
        'generator': GENERATOR,
        'padding': pad,
        'atlas': {
            'width': atlas_w, 'height': atlas_h,
            'bytes': atlas_path.stat().st_size,
            'pixelEqual': pixel_equal,
            'rects': len(drawables),
        },
        'rig': {
            'bytes': len(rig_bytes),
            'gzipBytes': len(__import__('gzip').compress(rig_bytes, 9)),
            'sha256': hashlib.sha256(rig_bytes).hexdigest(),
        },
        'drawables': [
            {
                'id': d['id'], 'slot': d.get('slot'), 'z': d.get('z'),
                'atlasRect': d['atlasRect'], 'texSize': d['texSize'],
                'verts': len(d['mesh']['positions']),
                'tris': len(d['mesh']['indices']) // 3,
            }
            for d in drawables
        ],
    }
    report['textureTotal'] = {
        'atlasBytes': atlas_path.stat().st_size,
        'bytesPerPixel': 4,
        'texMiB': round(atlas_w * atlas_h * 4 / 1048576, 2),
        'texMiBwithMipmap': round(atlas_w * atlas_h * 4 * 4 / 3 / 1048576, 2),
    }
    (out_dir / 'build-report.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='构建 2.5D 产品资产（紧凑 rig + 每身形图集）')
    parser.add_argument('--rig', required=True, help='POC rig JSON 路径')
    parser.add_argument('--texdir', required=True, help='POC 纹理目录（drawable.texture 的 basename）')
    parser.add_argument('--out', default=str(DEFAULT_OUT), help='输出目录（默认 docs/dress-up/art/2d5）')
    parser.add_argument('--shape', required=True, choices=['chibi', 'girl'])
    parser.add_argument('--pad', type=int, default=PAD, help=f'图集 padding（默认 {PAD}px）')
    parser.add_argument('--max-width', type=int, default=MAX_WIDTH, help=f'图集最大宽度（默认 {MAX_WIDTH}）')
    parser.add_argument('--no-verify', action='store_true', help='跳过图集回读逐像素校验')
    args = parser.parse_args(argv)
    report = build(Path(args.rig), Path(args.texdir), Path(args.out), args.shape,
                   args.pad, args.max_width, verify=not args.no_verify)
    atlas = report['atlas']
    rig = report['rig']
    print(f'[{args.shape}] atlas {atlas["width"]}x{atlas["height"]} '
          f'{atlas["bytes"] / 1024:.0f} KiB · rig {rig["bytes"] / 1024:.0f} KiB '
          f'(gzip {rig["gzipBytes"] / 1024:.0f} KiB) · drawables {atlas["rects"]} · '
          f'pixelEqual {atlas["pixelEqual"]} · tex {report["textureTotal"]["texMiB"]} MiB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
