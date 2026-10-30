#!/usr/bin/env python3
"""换装 2.0 素材构建：把 Seedream 生成的「整套穿着立绘」处理成游戏素材。

输入目录（默认 .scratch/feiyu-gen/raw6）里按命名约定存放：
  chibi-dress-<id>.png      Q版整套立绘（连衣裙）
  chibi-combo-<top>-<bottom>.png  Q版整套立绘（上衣+下装组合）
  girl-*                    少女版同上

处理：
  1. 纯白背景 → 透明（保留原始画布，保证所有立绘位置一致）
  2. 统一缩放到 675×1200 WebP（9:16）
  3. 生成 200×200 缩略图
  4. 量出每张立绘的内容上下边界，写进 manifest 的 bounds
  5. 重建 docs/dress-up/manifest.json（v4）

用法:
  python3 tools/build_wardrobe.py [--src .scratch/feiyu-gen/raw6] [--out docs/dress-up]
"""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TARGET = (675, 1200)
THUMB = 200

DRESSES = [
    ('maid', '经典女仆装', '她本来的样子。'),
    ('starry', '星空礼服', '把银河穿在身上。'),
    ('strawberry', '草莓蛋糕裙', '三层奶油，一层少女心。'),
    ('gothic', '黑金哥特', '暗夜玫瑰，黑金蕾丝。'),
    ('forest', '森系花仙', '把一整个春天缝进裙摆。'),
    ('sakura', '樱花茶会裙', '花瓣落在蕾丝上，春天来啦。'),
]
TOPS = [
    ('sweater', '白色高领毛衣', '软乎乎的，像一条围巾。'),
    ('hoodie', '白色连帽卫衣', '宽宽松松，把自己藏进去。'),
    ('sailor', '水手服上衣', '海风味的日常。'),
]
BOTTOMS = [
    ('plaid', '格纹百褶裙', '校园里最普通也最好看的那条。'),
    ('pleated', '深蓝百褶裙', '转一圈，裙摆会开成花。'),
]
SHAPES = [
    ('chibi', 'Q版', '大头小身子的可爱版本'),
    ('girl', '少女版', '六头身的少女比例'),
]

# 背景：id, 名字, 描述, 地面线（0–1，人物脚底对齐到这里）
BACKGROUNDS = [
    ('bg-snow', '冬夜街道', '暖黄色的路灯，和一直下的雪。', 0.86),
    ('bg-sakura', '樱花庭院', '走过小桥，花瓣落了一路。', 0.88),
    ('bg-starry', '银河原野', '抬头是整条银河。', 0.9),
    ('bg-forest', '晨光森林', '雾还没散，花已经开了。', 0.88),
    ('bg-cyber', '霓虹街区', '雨后的路面，倒映着一整条街的灯。', 0.86),
    ('bg-cafe', '雪日咖啡馆', '窗外在下雪，热可可刚好。', 0.92),
]

# 右侧衣柜图标：只用「衣服本身」的白底图（不能出现穿好衣服的人）
ICON_SOURCES = {
    'maid': 'maid-dress.png',
    'starry': 'dress-starry.png',
    'strawberry': 'dress-strawberry.png',
    'gothic': 'dress-gothic.png',
    'forest': 'dress-forest.png',
    'sakura': 'dress-sakura.png',
    'sweater': 'top-sweater.png',
    'hoodie': 'top-hoodie.png',
    'sailor': 'top-sailor.png',
    'plaid': 'bottom-plaid.png',
    'pleated': 'bottom-pleated.png',
}
EFFECTS = [
    ('none', '无', '安安静静。', '🌙'),
    ('snow', '飘雪', '一直一直下雪。', '❄️'),
    ('petals', '花瓣', '风一吹，花瓣就落下来。', '🌸'),
    ('stars', '星光', '四周浮着小小的光。', '✨'),
]
BUBBLES = [
    '这条裙子…会不会太夸张了？不过我喜欢。',
    '转一圈给你看——怎么样！',
    '今天的鱼粮，够买新裙子吗？',
    '唔…不许偷看裙底！',
    '这个背景好漂亮，像画一样。',
    '我是不是…又吃多了。',
    '再换一条嘛，就一条。',
    '拍立绘卡的时候，记得把我拍得好看一点。',
    '你看你看，这个发型配这身是不是很搭？',
    '要是每天都能换新衣服就好了。',
]


def remove_white(src: Path) -> Image.Image:
    """白底 → 透明，保持原画布尺寸，保证多张立绘位置一致。"""
    im = Image.open(src).convert('RGBA')
    w, h = im.size
    probe = im.convert('RGB')
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(probe, corner, (255, 0, 255), thresh=26)
    px = probe.load()
    op = im.load()
    for y in range(h):
        for x in range(w):
            if px[x, y] == (255, 0, 255):
                op[x, y] = (0, 0, 0, 0)
    return im


def fit_canvas(im: Image.Image) -> Image.Image:
    return im.resize(TARGET, Image.LANCZOS)


def make_thumb(im: Image.Image, out: Path) -> None:
    bbox = im.getbbox()
    body = im.crop(bbox) if bbox else im
    ratio = min((THUMB - 12) / body.width, (THUMB - 12) / body.height)
    body = body.resize((max(1, round(body.width * ratio)), max(1, round(body.height * ratio))), Image.LANCZOS)
    canvas = Image.new('RGBA', (THUMB, THUMB), (0, 0, 0, 0))
    canvas.alpha_composite(body, ((THUMB - body.width) // 2, (THUMB - body.height) // 2))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, 'WEBP', quality=86, method=6)


def bounds_of(im: Image.Image) -> dict:
    bbox = im.getbbox()
    if not bbox:
        return {'top': 0.1, 'bottom': 0.9}
    return {'top': round(bbox[1] / TARGET[1], 4), 'bottom': round(bbox[3] / TARGET[1], 4)}


def make_icon(src_file: Path, out: Path) -> None:
    im = remove_white(src_file)
    bbox = im.getbbox()
    body = im.crop(bbox) if bbox else im
    ratio = min((THUMB - 18) / body.width, (THUMB - 18) / body.height)
    body = body.resize((max(1, round(body.width * ratio)), max(1, round(body.height * ratio))), Image.LANCZOS)
    canvas = Image.new('RGBA', (THUMB, THUMB), (0, 0, 0, 0))
    canvas.alpha_composite(body, ((THUMB - body.width) // 2, (THUMB - body.height) // 2))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out, 'WEBP', quality=88, method=6)


def build(src: Path, out: Path) -> None:
    art = out / 'art'
    bounds: dict[str, dict] = {}

    def add_layer(shape: str, rel: str, src_file: Path) -> None:
        im = fit_canvas(remove_white(src_file))
        dst = art / shape / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, 'WEBP', quality=88, method=6)
        key = f'art/{shape}/{rel}'
        bounds[key] = bounds_of(im)
        thumb_rel = f'art/{shape}/thumbs/{rel}'
        make_thumb(im, out / thumb_rel)
        print(f'  {key} {dst.stat().st_size // 1024}KB')

    for shape, _, _ in SHAPES:
        for ident, _, _ in DRESSES:
            src_file = src / f'{shape}-dress-{ident}.png'
            if not src_file.exists():
                raise SystemExit(f'missing source: {src_file}')
            add_layer(shape, f'dress-{ident}.webp', src_file)
        for top, _, _ in TOPS:
            for bottom, _, _ in BOTTOMS:
                src_file = src / f'{shape}-combo-{top}-{bottom}.png'
                if not src_file.exists():
                    raise SystemExit(f'missing source: {src_file}')
                add_layer(shape, f'combo-{top}-{bottom}.webp', src_file)

    # 右侧衣柜图标（只有衣服）
    icon_root = src.parent
    for ident, filename in ICON_SOURCES.items():
        icon_src = icon_root / 'raw3' / filename
        if not icon_src.exists():
            raise SystemExit(f'missing icon source: {icon_src}')
        make_icon(icon_src, art / 'icons' / f'{ident}.webp')
    print(f'  icons: {len(ICON_SOURCES)}')

    manifest = {
        'version': 4,
        'title': '大肥鱼衣橱 · 换装间',
        'character': '大肥鱼 · 经典鲸鱼娘',
        'credits': (
            '立绘 / 服装：本项目用 Seedream 5.0（火山方舟）基于自建素体生成 · '
            '角色参考：大肥鱼社区二创（仅作风格参考，未直接使用原画）· '
            '非官方，禁止商用'
        ),
        'shapes': [{'id': sid, 'name': name, 'desc': desc} for sid, name, desc in SHAPES],
        'bounds': bounds,
        'categories': [
            {'id': 'outfits', 'name': '套装', 'emoji': '👗', 'stateKey': 'outfit'},
            {'id': 'tops', 'name': '上衣', 'emoji': '👚', 'stateKey': 'top'},
            {'id': 'bottoms', 'name': '下装', 'emoji': '👘', 'stateKey': 'bottom'},
            {'id': 'backgrounds', 'name': '背景', 'emoji': '🏙️', 'stateKey': 'bg'},
            {'id': 'effects', 'name': '特效', 'emoji': '❄️', 'stateKey': 'effect'},
        ],
        'items': {
            'outfits': [{'id': 'none', 'name': '不穿套装', 'emoji': '🚫', 'desc': '换成上衣 + 下装搭配。'}]
            + [{'id': i, 'name': n, 'desc': d, 'icon': f'art/icons/{i}.webp'} for i, n, d in DRESSES],
            'tops': [{'id': i, 'name': n, 'desc': d, 'icon': f'art/icons/{i}.webp'} for i, n, d in TOPS],
            'bottoms': [{'id': i, 'name': n, 'desc': d, 'icon': f'art/icons/{i}.webp'} for i, n, d in BOTTOMS],
            'backgrounds': [{'id': i, 'name': n, 'desc': d, 'file': f'art/{i}.webp',
                             'thumb': f'art/thumbs/{i}.webp', 'floor': floor}
                            for i, n, d, floor in BACKGROUNDS],
            'effects': [{'id': i, 'name': n, 'desc': d, 'emoji': e} for i, n, d, e in EFFECTS],
        },
        'defaults': {'shape': 'chibi', 'outfit': 'maid', 'top': 'sweater', 'bottom': 'plaid',
                     'bg': 'bg-snow', 'effect': 'snow'},
        'bubbles': BUBBLES,
    }
    # 背景缩略图
    for bid, _, _, _ in BACKGROUNDS:
        bg_file = out / 'art' / f'{bid}.webp'
        if not bg_file.exists():
            print(f'  WARN missing background {bg_file}')
            continue
        im = Image.open(bg_file).convert('RGB')
        side = min(im.size)
        im = im.crop(((im.width - side) // 2, (im.height - side) // 2,
                      (im.width + side) // 2, (im.height + side) // 2)).resize((THUMB, THUMB), Image.LANCZOS)
        thumb = out / 'art' / 'thumbs' / f'{bid}.webp'
        thumb.parent.mkdir(parents=True, exist_ok=True)
        im.save(thumb, 'WEBP', quality=86, method=6)

    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f'manifest -> {out / "manifest.json"}')
    print(f'shapes={len(SHAPES)} dresses={len(DRESSES)} combos={len(TOPS)*len(BOTTOMS)} layers={len(bounds)}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', default=str(ROOT / '.scratch/feiyu-gen/raw8'))
    parser.add_argument('--out', default=str(ROOT / 'docs/dress-up'))
    args = parser.parse_args()
    build(Path(args.src), Path(args.out))
