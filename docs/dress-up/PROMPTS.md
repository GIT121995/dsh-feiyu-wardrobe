# 大肥鱼衣橱 · 换装间素材管线（v0.9 · 纸娃娃分层 v2）

v0.9 起换装间是 **7 槽位纸娃娃分层**：

```
drawOrder: body → topUnder → bottom → topBody → arms → sleeve → hair

每个身形 = body（素体）+ arms（手臂+手）+ hair（完整前发）
每件上衣/连衣裙 = body 层（衣身，topBody 或 topUnder 槽位）+ sleeve 层（袖子，盖在手臂上）
每件下装 = bottom 层（裙子，在手臂层之下 → 手在裙前）
```

- 身形部件掩膜由 `tools/build_masks.py` 生成（`tools/masks/<shape>/{arms,hair}.png`，需要人工 QA）；
- 袖子层 = 衣身 alpha × dilate(手臂掩膜, 6px)，再减掉 look 真值里的手部 → 长袖正确盖手腕、手在袖口外；
- 衣服**不再挖头发洞**：头发是独立最上层，完整前发由 `hair` 层盖回。
- 契约与验收见 [`LAYER-MODEL.md`](./LAYER-MODEL.md)，技术选型见 [`LAYER-ARCHITECTURE.md`](./LAYER-ARCHITECTURE.md)。

**为什么不需要手工锚点/配准**：所有单件 look 都穿在**同一张素体**上生成，
构图（位置 / 比例 / 姿势 / 头脚位置）由参考图继承；图层从 look 里抠出来，
天然就在同一坐标系里。

## 目录结构

```
docs/dress-up/
├── index.html / style.css / app.js   换装间前端（按 drawOrder 动态槽位渲染）
├── wardrobe-core.js                  纯函数核心（穿搭规则 / resolveLayers / 随机搭配）
├── manifest.json                     v6：drawOrder + shapes[].layers(body/arms/hair) + items[].layers[shape][slot]
├── LAYER-MODEL.md                    v6 分层契约（槽位 / schema / 构建 / 验收）
├── LAYER-ARCHITECTURE.md             技术选型（为什么是 DOM 多槽位而不是 Canvas/WebGL/骨骼）
└── art/
    ├── bg-*.webp / thumbs/           6 张背景 + 缩略图
    ├── icons/*.webp                  6 张「纯衣服」衣柜图标
    ├── pet-default.webp              悬浮小鲸鱼兜底图（184×327 透明）
    └── <shape>/
        ├── body.webp                 素体（白色无肩带连体泳衣，675×1200 透明）
        ├── arms.webp                 手臂+手（画在衣服之上，长袖的袖子再盖回来）
        ├── hair.webp                 完整前发（含手臂下方长发丝，画在最上层）
        └── layers/
            ├── top-<id>-body.webp / top-<id>-sleeve.webp
            ├── dress-<id>-body.webp / dress-<id>-sleeve.webp
            └── bottom-<id>.webp
tools/
├── build_masks.py                    身体部件掩膜生成（arms/hair，带 --check 回归）
├── masks/<shape>/arms.png|hair.png   掩膜（1152×2048，RGBA，A 通道=掩膜）
├── masks/README.md                   掩膜算法 / 阈值 / QA / 已知误差
└── build_wardrobe.py                 v6 素材构建（mask → 部件层 / 袖身拆分 / manifest / QA）
```

## 1. 素体（Q版 / 少女版）

参考图：`ref-q3view.jpg`、`ref-girl3view.jpg` 等（见 `.scratch/feiyu-art/`）。

素体是**白色无肩带连体泳衣（bandeau）**——有肩带的连体衣会在抹胸礼服 /
无袖上衣的肩线处露出白色肩带。提示词：

```
参考图1的角色。请只改衣服：把她身上那件白色连衣裙换成一件白色无肩带连体泳衣
（bandeau 抹胸款：没有肩带、平口低胸、平角裤型），贴身剪裁。
其他所有部分保持完全不变：脸、表情、发型、发色、耳鳍、尾巴、姿态、位置、大小、纯白背景；
输出画布与参考图1完全一致，不要放大缩小或移动角色；无文字。
```

> 注意：**不要**尝试「肤色连体衣」——会被方舟判为敏感内容（实测 400）。

## 2. 单件穿着 look（12 张 = 2 身形 × 6 件）

以素体为参考图 1、三视图为图 2，只穿一件衣服：

```
参考图1是这个角色的素体（白色无肩带连体泳衣）。请只给她穿上衣：{描述}；
不穿裙子、不穿裤子，下半身保持白色连体泳衣、光脚；不戴头饰。
保持与参考图1完全相同的角色外观（脸、蓝色渐变长发、呆毛圆环、鲸鱼耳鳍、鲸鱼尾巴）
和完全相同的Q版站姿、位置、比例；全身正面站立，纯白背景，平涂上色，深色描边，无文字。
```

- 上衣：`sweater` 白色高领毛衣 / `hoodie` 白色连帽卫衣（橙蝴蝶结）/ `sailor` 白色水手服（深蓝领 + 蓝鲸刺绣）
- 下装：`plaid` 蓝白格纹百褶裙 / `pleated` 深蓝百褶裙（白细条纹 + 腰间蝴蝶结）
  - **裙长要点**：单独画下装时 AI 会画成超短裙 → 组合模式里会被上衣下摆完全盖住。
    提示词必须写「**高腰，裙摆长度到大腿中部偏下（膝盖以上约 15cm）**」；
    构建时还会按「衣服顶部中点」锚定放大（chibi ×1.72 / girl ×1.40）再保险。
- 连衣裙：**只保留 1 套 `maid` 经典女仆装**（内容保守约束：抹胸礼服/蕾丝大裙摆等已移除）
  - **保守基调**：上衣全部带袖/有领，下装裙长做到**及膝**（构建时按顶部锚定放大约 1.7×/1.4×），不出现暴露款式

## 3. 白底单件图 whiteout（22 张）

为了让图层 alpha 干净（白衣服×白素体、头发遮挡处会糊），每张 look 再生成一张
「只留这件衣服、其余全涂纯白」的图：

```
参考图1是一个穿着{描述}的角色。请只保留这件衣服：把画面里其他所有东西
——脸、五官、头发、耳鳍、脖子、手臂皮肤、手、腿、脚、鲸鱼尾巴、白色连体泳衣——
全部涂成纯白色（#FFFFFF 平涂，不要任何阴影、渐变、轮廓线）；
衣服本身保持完全原样：位置、大小、朝向、颜色、纹理/图案、褶皱、深色描边都不变，
不要移动、不要缩放、不要重新居中；输出画布与参考图1完全一致；无文字。
```

> 实测 AI **不一定**保持位置/大小（白色上衣会被画得明显更大），所以构建时用
> **形状 IoU 配准**把 whiteout 单件图配回 look 坐标系（FFT 互相关做平移搜索 + 缩放扫描）。
> 水手服的深色领子/蝴蝶结比衬衫主体大，直接整体配准会把衣服拉小 → 只拿「浅色衬衫主体」做 probe 配准。
> 少女版卫衣的 whiteout 丢了橙色蝴蝶结 → 构建时从 look 的橙色像素补回（`patch_lost_bow`）。

## 4. 构建游戏素材

```sh
# 1) 身体部件掩膜（arms / hair，两身形；可加 --check 做逐字节回归）
python3 tools/build_masks.py
# 2) 素材 + manifest v6 + QA 拼图
python3 tools/build_wardrobe.py --src .scratch/feiyu-gen/raw12 --out docs/dress-up
```

依赖 `pillow + numpy + opencv-python`（仅构建用；游戏运行零依赖）。构建做这些事：

1. **部件层**：`body.webp`（素体，白底→透明，premultiplied 缩放到 675×1200）、
   `arms.webp`（body RGB + arms 掩膜 alpha）、`hair.webp`（body RGB + hair 掩膜 alpha）；
2. **衣服 body 层**：沿用 v0.8 的三种 matte 策略（whiteout 配准 / diff 主块 / flood 备用），
   得到整件 alpha 后**不挖头发洞**，premultiplied 缩放；
3. **衣服 sleeve 层**：`garment_alpha × dilate(arms掩膜, 6px)`，再用 look 的手部区域减掉手，
   羽化 1px；RGB 与 body 层相同 → 重叠处无接缝；
4. **manifest v6**：`drawOrder` + `shapes[].layers` + `items[].layers[shape][slot]`；
   水手服主体映射到 `topUnder`（下摆塞进裙子），其余上衣/连衣裙主体映射到 `topBody`；
5. **premultiplied 缩放**（避免半透明边缘把白色背景插值成灰边）+ **原子写**（先 `.tmp` 再 `os.replace`）；
6. `art/pet-default.webp`（按 drawOrder 合成的透明 184×327）+ QA 拼图
   （`--qa-dir`，默认 `.scratch/feiyu-art/v9-layers-<shape>.jpg`），以及
   `hand-in-front-skirt / hair-over-clothes / hair-ghost / bow / seam / magenta-holes` 等专项 QA 图。

## 5. 新增一件衣服

1. 用素体生成「只穿这一件」的 look（保持姿势一致），再生成对应的 whiteout 单件图；
2. 文件按 `<shape>-only-<cat>-<id>.png` / `<shape>-whiteout-<cat>-<id>.png` 放进源目录；
3. 在 `tools/build_wardrobe.py` 的 `DRESSES` / `TOPS` / `BOTTOMS` 加一行，
   在 `LAYER_PLAN` 里选 matte 策略（白色 → whiteout / 彩色 → diff），
   并在 `MAIN_SLOT` 里决定主体放 `topBody` 还是 `topUnder`（塞进裙子）；
4. 重建素材和 manifest（sleeve 层会自动从部件掩膜切出来，不用手工做袖子图）；
5. `npm run verify`（校验 manifest v6 契约、每个引用文件存在且是合法 WebP、槽位合法、bounds 合理）。

## 版权

- 立绘 / 服装：本项目用 Seedream 5.0（火山方舟）基于自建素体生成，不是任何现有画作的再分发；
- 角色概念参考：大肥鱼社区二创（上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘 的社区衍生形象），
  仅作风格与设定参考，未直接使用原画；
- 本项目免费开源、不商业化、不卖皮肤。
