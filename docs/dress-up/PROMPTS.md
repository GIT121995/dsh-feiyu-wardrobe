# 大肥鱼衣橱 · 换装间素材配方（分层管线）

换装间 2.0 的素材全部是**分层透明 WebP**：背景、底座、裙子、外套、头饰分开画，
游戏里直接按 `背景 → 底座 → 裙子 → 外套 → 头饰 → 粒子特效` 的顺序叠起来，
所以任意搭配都对齐，不需要为每种组合重新合成整图。

## 目录结构

```text
docs/dress-up/
├── index.html / style.css / app.js   换装间前端
├── manifest.json                     衣柜数据（分类、名字、文件、缩略图、布局锚点）
├── art/                              图层素材（720×1200 WebP，同一画布）
│   ├── base.webp                     高清底座
│   ├── gown-*.webp / coat-*.webp / hat-*.webp / bg-*.webp
│   └── thumbs/*.webp                 衣柜缩略图
└── PROMPTS.md                        本文件
tools/
├── compose_dress.py                  图层合成（base / gown / hat / full）
├── make_thumbs.py                    缩略图生成
└── source/                           未合成的源素材（底座 + 裙子白底图 + 头饰白底图）
```

所有图层都画在 **900×1500 内部画布**（角色 700px 高、顶部 180px、裙子腰部基线 614px），
导出时统一缩放到 **720×1200**。游戏按 `manifest.json` 里的 `layout` / `bottom` / `top`
锚点自动缩放定位，裙子长得不一样也能各自铺满舞台。

## 高清底座

- 来源：[YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet) 的
  1024px Q 版大肥鱼立绘（`assets/whale/portrait.png`）
- 许可：**「大肥鱼项目署名许可 1.0」**——使用时必须保留
  “作者 YunYueSama + https://github.com/YunYueSama/codex-deepseek-pet” 署名
- 角色版权链：上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘（CC BY-NC-SA 4.0，非官方二创，禁止商用）
- 文件：`tools/source/classic-base-hires.png` → `python3 tools/compose_dress.py base ... docs/dress-up/art/base.webp`

## 裙子 / 外套 / 头饰（Moss 图像 API 生成）

生成器：`moss_image_api.py`（凭据在 `~/.config/moss-image/env`），参数一般
`--size 1024x1536 --seed <固定>`，白底、无人物。

### 裙子配方（每条裙子一张白底图）

```text
Q版动漫风格，只有一条{主题}的华丽大裙子，{材质/装饰描述}，蓬松多层裙摆，
正面展示，没有人物，没有身体，没有头，没有腿，深色描边，平涂上色，
白色背景，居中，干净简洁
```

| id | 名字 | 主题关键词 |
|---|---|---|
| starry | 星空礼服 | 深蓝星空渐变、星光点缀、缎带蝴蝶结 |
| strawberry | 草莓蛋糕裙 | 粉白奶油渐变、草莓装饰、层层褶皱 |
| gothic | 黑金哥特 | 黑色蕾丝、金色镶边、暗红玫瑰 |
| forest | 森系花仙 | 嫩绿渐变、花瓣层叠、藤蔓小花 |
| cyber | 赛博霓虹 | 半透明材质、青紫色霓虹光边、几何光纹 |
| sakura | 樱花茶会裙 | 樱花粉白渐变、花瓣与蕾丝、多层蓬松裙摆 |
| ocean | 深海珍珠裙 | 深海蓝绿渐变、水波纹与贝壳珍珠、薄纱层叠 |

### 外套配方（白底，含两只袖子，没有人物/头/腿）

```text
Q版动漫风格，只有一件{外套描述}，正面展示，含两只袖子，
没有人物，没有头，没有腿，深色描边，平涂上色，白色背景，居中，干净简洁
```

| id | 名字 | 描述 | 锚点（画布宽 / 顶端） |
|---|---|---|---|
| winter | 冬季毛领大衣 | 深蓝呢料 + 白色毛领毛袖口 | `--width 0.38 --top 0.32` |
| hoodie | 白色连帽卫衣 | 白色宽松连帽 + 橙色蝴蝶结 | `--width 0.30 --top 0.36` |

### 头饰配方（白底，只有配饰，没有人物）

| id | 名字 | 描述 | 锚点 |
|---|---|---|---|
| whale | 鲸鱼兜帽 | 蓝色鲸鱼造型毛绒兜帽（带白色绒边） | `--width 0.42 --top 0.082` |
| snow | 雪花发饰 | 银白色雪花发饰、带一点蓝光 | `--width 0.15 --top 0.075 --x 0.40` |
| berry | 草莓蝴蝶结 | 粉红草莓造型蝴蝶结发饰 | `--width 0.19 --top 0.105 --x 0.40` |
| crown | 星月小皇冠 | 蓝金星月小皇冠、镶小珍珠 | `--width 0.24 --top 0.078` |

### 合成命令

```sh
# 裙子图层（自动去白底 + 裙腰接触阴影）
python3 tools/compose_dress.py gown tools/source/skirt-starry.png docs/dress-up/art/gown-starry.webp

# 外套 / 头饰图层（按锚点贴到画布上）
python3 tools/compose_dress.py hat tools/source/coat-winter.png docs/dress-up/art/coat-winter.webp --width 0.38 --top 0.32
python3 tools/compose_dress.py hat tools/source/hat-whale.png  docs/dress-up/art/hat-whale.webp  --width 0.42 --top 0.082

# 缩略图（读 manifest.json 自动生成）
python3 tools/make_thumbs.py
```

> 头饰/外套的白底图需要先人工看一眼锚点效果（`--width/--top` 是可调参数），
> 贴好后再跑一次即可；裙子不需要单独调锚点，管线会自动对齐腰部。

## 背景（场景图，没有人物）

`--size 1024x1536`，纯场景、无人物、无文字，导出压缩到 800×1200 WebP：

| id | 名字 | 提示词要点 |
|---|---|---|
| bg-snow | 冬夜街道 | 冬夜欧洲街道、暖黄路灯、飘雪、远处钟楼 |
| bg-sakura | 樱花庭院 | 春日樱花庭院、石灯笼与木桥、黄昏暖光 |
| bg-starry | 银河原野 | 梦幻银河星空、紫蓝夜空、远山剪影 |
| bg-forest | 晨光森林 | 晨光森林花园、藤蔓野花、丁达尔光 |
| bg-cyber | 霓虹街区 | 赛博朋克霓虹街道、青紫灯牌、雨后反光 |
| bg-cafe | 雪日咖啡馆 | 复古咖啡馆室内、暖色吊灯、窗外雪景 |

## 新增一件衣服的完整流程

1. 用 Moss 出白底图（或画师直接给白底 PNG），放进 `tools/source/`；
2. 用 `tools/compose_dress.py` 的 `gown` / `hat` 子命令转成 `docs/dress-up/art/*.webp`；
3. 在 `manifest.json` 对应分类里加一项（`file`、`thumb`，裙子加 `bottom`、头饰加 `top` 锚点，数值可用脚本量 bbox 得到）；
4. `python3 tools/make_thumbs.py` 生成缩略图；
5. `npm run verify`（会检查每个引用的文件存在且是合法 WebP）。

## 版权与署名

- 底座：YunYueSama（署名许可，保留作者 + 仓库地址）
- AI 图层与背景：本项目用 Moss 图像 API 生成
- 角色二创版权链：上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘（CC BY-NC-SA 4.0，非官方，禁止商用）
- 本项目免费开源、不商业化、不卖皮肤；再分发请保留以上署名
