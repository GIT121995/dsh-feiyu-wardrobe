# 4.0 槽位底座（Slot System）执行计划

> 状态：**Phase 0 计划稿（2026-11-13）**，未开工；新会话按本文档推进。
> 基线：v3.2.1（tag `v3.2.1`，资产 v26 / 页面 v29；v3.2.0 的 lazy 5 页 + rig.bin + brotli 不变）。
> 关联：[CHANGELOG](../CHANGELOG.md) · [2.5D-RUNTIME](dress-up/2.5D-RUNTIME.md) · [QA-REGISTRY](QA-REGISTRY.md) · [ART 管线](../tools/art/README.md)
> 备注：`.scratch/` 不计入仓库；本文件是 4.0 的唯一执行计划入口。

## 0. 一句话

把当前「4 套写死的整层 outfit + 5 页懒加载图集」升级为**通用槽位底座**：上衣/下装/鞋/袜/头饰/耳饰/项链/手持
可独立拆装、按槽位 z 规则与骨骼 socket 绑定，资产与 runtime 契约由 **slot registry** 驱动；
目标先交付 **1–2 套验证穿搭**，再进入 4.1「按上传图批量生成穿搭」。

## 1. 为什么现在做 / 已具备的前提

用户既定方向（2026-11-12 会话）：「先确定素体和资产 → 实验绑定 → 槽位更多（首饰、鞋、袜等）→ 贴近真人穿搭 →
前面批量按上传图生成」。当前前置已具备：

- 素体/骨架稳定：65 骨（59 前缀 + 6 legBones）、LBS 蒙皮、15 弹簧链；v3.0 起服装整层化（paper-doll）。
- 资产管线可复现：`tools/art/build_prod.py` + `build_2d5.py`、构建确定性双跑、官方 dist 逐字节校验。
- 性能底座：lazy 5 页图集 + `rig.bin` 二进制 + brotli；首屏 chibi 0.96MiB / girl 0.80MiB（≤1MB 达成）。
- QA 门禁：`verify:full` 332 tests、`visual:qa` 80 张 baseline（含 neck 区域）、`qa-load-timeline`。
- 兼容层经验：v2.1 / v2.2–2.7 旧存档与 DIY pack 迁移映射（`LEGACY_V21_BASE_REFS` / `LEGACY_V22_BASE_REFS`）。

## 2. 当前架构基线（3.2.0 事实，改 4.0 前必须知道）

| 项 | 现状 |
|---|---|
| 骨架 | 65 骨；`rig.bones` 65；shader `MAX_BONES=80` |
| drawables | chibi 48 / girl 49（每套 outfit = `{combo}-top`(slot topBody, z64) + `{combo}-skirt`(slot bottom, z30)） |
| 槽位 | `OUTFIT_SLOTS = ['topUnder','bottom','topBody','sleeve','sleeveUpper','sleeveFore','collar']`；v3 只用 topBody/bottom |
| 造型解析 | `resolveLook(rig, state)`：套装优先 → `<top>-<bottom>` 组合 → 旧 generic 回退 → 默认套装 |
| 图集页 | **写死 5 页**：`base` + `maid`/`hoodie-plaid`/`hoodie-pleated`/`sailor-plaid`；`build_prod.build_atlas_pages()` 按 `rig.outfits` 引用分组；每页文件名 `atlas.webp` / `atlas-2..5.webp` |
| 运行时页选择 | `MAX_ATLASES=6`；`collectLookAtlasIndices(rig, look)`（base 页恒选 + look 用到的套装页）；首帧后 220ms 空闲预取其余页；`setLook` 缺页时延迟应用 |
| rig 传输 | `rig.bin`（feiyu-rig-binary v1，flat-f32 零拷贝）+ `rig.bin.br`（构建期 q11）；JSON 回退 |
| 页面/资产版本 | 页面 `?v=29`、资产 `?v=26`（必须随 dist/页面变更递增；v3.2.1 起 UV 定点 1e-7） |
| 视觉门禁 | 2 身形 × 5 造型 × (full-1x + 7 个 2x 区域) = 80 张；区域由 rig 骨骼/rect 推导 |

**结论**：4.0 的「多槽位」会同时撞上两处写死设计：`resolveLook` 的 OUTFIT_SLOTS 语义、以及
`build_atlas_pages()` / `collectLookAtlasIndices` 的「base + 每套装一页」假定。这两处是 Phase 0 的核心决策。

## 3. 契约设计（草案，Phase 0 产出定稿）

### 3.1 Slot registry（新增 `docs/dress-up/slot-registry.js` 或 rig 内嵌 `slots2` 段）

原则：**registry 是数据的单一真相**，构建期（Python 读同一份 JSON/JS 可导出为 JSON）与运行期（ESM import）共用。

```json
{
  "format": "feiyu-slot-registry", "version": 1,
  "slots": [
    { "id": "topBody", "z": 64, "kind": "outfit", "group": "top",
      "seat": "body", "required": false, "sockets": [] },
    { "id": "bottom", "z": 30, "kind": "outfit", "group": "bottom", "physics": "skirt" },
    { "id": "shoes", "z": 20, "kind": "accessory", "group": "shoes", "socket": "footL/footR", "mirror": true },
    { "id": "socks", "z": 22, "kind": "accessory", "group": "socks", "socket": "shin" },
    { "id": "headwear", "z": 72, "kind": "accessory", "group": "headwear", "socket": "head" },
    { "id": "earring", "z": 68, "kind": "accessory", "group": "earring", "socket": "head", "mirror": true },
    { "id": "necklace", "z": 58, "kind": "accessory", "group": "necklace", "socket": "neck/chest" },
    { "id": "handheld", "z": 66, "kind": "accessory", "group": "handheld", "socket": "handR" }
  ],
  "rules": {
    "conflict": [["headwear", "headwearLarge"]],
    "hideBase": [{ "slot": "shoes", "hideOptional": false }],
    "maxPerSlot": 1
  }
}
```

- 每个 drawable 增加 `slot`（已有）与可选 `socket` / `mirrorOf` / `physics` 元数据；兼容旧 rig（无 registry 时用现有 OUTFIT_SLOTS 行为）。
- 配饰的「锚定」两类：**骨骼 socket**（耳饰→head、项链→neck/chest、鞋→footL/R、袜→shinL/R、手持→handR）
  与**槽位 seat**（服装沿用现有 skinning 权重）；socket 绑定在运行时以「父骨矩阵 × 局部偏移」实现（新增 `socketBind` 工具，
  可复用 `runtime-2d5-core` 的 collider 绑骨几何思路）。
- 镜像：`mirror: true` 的配饰可只提供一侧 PNG，运行时按 x 轴镜像（UV 翻转 + 另一侧 socket），构建期也允许直接出双件。
- 物理：4.0 只要求现有 `skirt`/`hair`/`tail` 三类；耳饰/项链/发饰可先静态（跟随 socket 骨），飘动物理列 4.1 可选项。

### 3.2 资产契约（rig）

- `rig.slots2`（registry 引用 + 每 slot 的 drawable 白名单）+ `rig.outfits` 保持向后兼容（4.0 起 outfit 可只定义 topBody/bottom）；
- 配饰独立成 outfit-like 条目：`rig.accessories = { "ribbon-red": { name, slot: "headwear", drawables: ["acc-ribbon-red"], ... } }`；
  或统一为 `rig.items`（推荐，供衣柜 UI/DIY/存档统一读取）。
- 存档状态：`state = { shape, outfit, top, bottom, accessories: { headwear, shoes, ... } }`；`normalizeState` 加校验 + 旧存档迁移（无 accessories → 空）。
- DIY pack 兼容：旧 pack 的 `topBody/bottom/sleeve/topUnder` 映射不变；新配饰 slot 允许写入 pack（`slot` 白名单校验）。

## 4. 关键决策 1：lazy 页分组泛化（3.2.0 架构债）

候选方案：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A（推荐） | **base 页 + 每个「内容组」一页**：outfit 组仍按 combo（4 页），配饰按类别（headwear/shoes/socks/necklace/earring/handheld 各 1 页） | 语义清晰、切装按需加载、渲染顺序无关 | 页数变多（~10），`MAX_ATLASES` 需提升；首屏可能要 2–4 页（base+top+bottom+shoes） |
| B | base 页 + 全部配饰合并 1 页 + 4 outfit 页 | 页数少（6） | 配饰页随配饰增多膨胀，首屏可能整页拉；单页 4096 上限更早触发 |
| C | 按「当前造型」动态打包页（构建期不可能穷举） | 最优首屏 | 构建/缓存不可行 → 否决 |

**建议**：A + 运行时页选择规则升级：
1. `rig.slots2` 标记每组的页 id；`collectLookAtlasIndices` 改为「base 页 + look 中每个非空槽位所属页」；
2. `MAX_ATLASES` 6 → **12**（构建 `MAX_PAGES` 同步；单页仍 ≤4096×4096；WebGL 无硬限制，页数只影响请求数/预取/显存）；
3. 预取策略：首帧后预取「当前身形全部剩余页」（现有逻辑泛化即可），切装缺页仍走延迟应用；
4. 首屏预算重估：4.0 引入配饰后首屏 = base + top + bottom（+ 若默认穿鞋/袜）≥ 3 页；
   若同时要求服装/配饰 2x（D-005），首屏会显著上升 —— **需要用户拍板新的预算口径**（建议：默认造型 lo ≤1.2MB，或允许 4.0 首帧只拉 base+当前核心服装，配饰在首帧后 200ms 内补齐并做淡入，避免「裸脚/无耳饰」帧）。
5. 版本化页文件名/序号契约保持不变（`atlas.webp`, `atlas-2.webp`…），页 `id` 改为 registry 组 id。

## 5. 运行时改造清单（Phase 2）

1. `runtime-2d5-core.js`
   - `resolveLook`：输入 state 支持 `accessories`；输出 `slots` 扩展为 registry 槽位全集（旧 4 键语义不变）；
   - 新增 `resolveAccessories(items, state)` / `composeLook`（服装 + 配饰合并、冲突规则、缺件回退）；
   - `collectLookAtlasIndices` 泛化（按 registry group→page 映射）；
   - `normalizeState`（wardrobe-core）：accessories 校验/迁移；旧存档不丢。
2. `runtime-2d5.js`
   - 新增 socket 绑定工具（父骨矩阵 × 局部偏移，含 mirror 翻转；每帧在骨骼更新后计算）；
   - drawable 增加 `socket`/`mirror` 支持；VAO/VBO 复用（同一几何镜像）；
   - `addOutfitPack/removeOutfitPack` 支持配饰 pack；`getState().look` 扩展但仍保留旧键；
   - `applyLook` 的缺页延迟逻辑保持；配饰页缺页同样延迟应用。
3. `app.js` / `wardrobe-core.js` / `manifest.json`
   - 衣柜 UI 增加配饰分类（头饰/耳饰/项链/鞋/袜/手持），状态持久化，图标；
   - 21 件原创 SVG 单品（报告卡）不受影响；换装间 manifest 版本递增（v8→v9）。
4. `diy-layers.js / diy-store.js / diy-*.js`：配饰类 DIY pack 的槽位白名单与 auto-pair 规则。

## 6. 构建管线改造（Phase 2）

- `tools/art/build_prod.py`：`build_atlas_pages()` 改为读 slot registry：
  - 页分组 = base + 每个非空 group；group→page id；
  - 断言：每个 drawable 恰好一页、每页非空、每页 ≤4096、页数 ≤`MAX_PAGES`；
- 配饰资产路径：源包 `art/accessories/{shape}/{group}/{item}/layer.png`（整层 PNG，alpha bbox trim）；
  binder 复用 v3 整层 outfit 的「全画布单网格」路径（`build_v3_outfit` 泛化）或矢量参数化（首饰/鞋袜优先矢量：
  线稿+纯色填充，避免 AI 细节在 1x 下糊）；建议**鞋/袜/发饰走矢量参数化**（可批量生成颜色变体），
  **耳饰/项链走矢量或简单 AI 精修**；
- 2x 策略（D-005）：4.0 起 hi tier 的**服装/配饰页也出 2x**（服装整层 675×1200 → 1350×2400）；hi 页数 = base(2x) + top/bottom(2x) + 配饰(2x)；
  纹理显存需重估：当前 hi ~54–56MiB（≤60 预算），服装 2x 后预计 **~90–110MiB** → 需重新评估 DPR/设备门槛与 hi 降级策略
  （建议：hi 服装 2x 仅对 deviceMemory≥6 且硬件并发≥6 的设备开启，或采用「hi 服装 1.5x」折中）。
- 构建确定性/官方 dist 校验延伸到新增页；`build-report` 增加页组/2x 元数据。

## 7. 美术 brief（Phase 1 前置，必须写进 `ART-BRIEF.md`）

- 继承现有规范：内容保守（长袖/有领/及膝裙，禁露肩露背/蕾丝抹胸/超短裙）；短脖子 chibi **禁高领/紧口**（D-017 教训）；
- 配饰比例：头饰不得遮挡刘海/眼睛，耳饰单侧 ≤18px 画布，项链落锁骨上缘（不得盖住露颈区域），鞋/袜贴合脚踝/小腿轮廓；
- 颜色：与现有 8 套服装色板协调（奶白/藏青/格纹/水手蓝），提供 2–3 个颜色变体；
- 生成：Seedream 局部生成 + 确定性后处理（抠图/trim/alpha 清理），每件需 G1 用户确认；
- 成本预估（需用户批准）：鞋/袜/发饰走矢量几乎 0 成本；耳饰/项链 AI 约 4–8 张图（¥0.3/张≈¥1.2–2.4/轮）。

## 8. 两套验证穿搭（Phase 1 交付物，需用户拍板方向）

建议（用户可选）：
- **日常通勤**：白衬衫（新上衣）+ 藏青及膝裙（新下装）+ 乐福鞋（鞋槽）+ 白短袜（袜槽）+ 小珍珠耳钉（耳饰）+ 细项链（项链）；
- **水手运动**：水手服上衣（现有）+ 格纹百褶裙（现有）+ 帆布鞋（鞋槽）+ 发带（头饰）+ 手持小鲸鱼挂件（手持）。
验收：2 身形 × 2 套 × 1x/2x 抓帧 + 拆装组合 + 存档迁移 + DIY 叠穿不穿模。

## 9. QA 门禁扩展（Phase 3）

- 新增 2x 区域：`ear`（耳饰）、`necklace`（锁骨/项链）、`wrist`（手持/手饰）、`shoes`（脚踝/鞋口）、`hem`（裙摆/袜口）；
  baseline 张数 80 → ~120；区域坐标从 registry/socket 推导（不得写死 canvas 坐标）。
- 自动化断言（新增 `tests/slot-system.test.mjs`）：
  - registry 完整性：slot 唯一、z 有序、socket 骨存在、group→page 一一映射；
  - 每个 drawable 恰好一页、每页非空、页 ≤4096；
  - 配饰锚定：socket 父骨存在、局部偏移在合理范围；mirror 对偶几何对称；
  - 存档迁移：旧 state（无 accessories）/旧 DIY pack（v2.2–3.2 refs）不抛错、不裸装；
  - 穿模门禁：配饰不得遮挡 face/neck 关键区域（像素级断言，沿用 garment-hygiene 思路）；
  - 1x/2x 抓帧 + 视觉 compare；真机矩阵仍欠（D-008）。
- 兼容：旧存档/旧 DIY pack、旧 rig（无 registry）继续走 v3 行为；不删除任何现有 API 字段。

## 10. 版本 / 发布计划（建议，需用户确认）

- 建议分两段（降低一次性风险，符合「每天一个可发版增量」纪律）：
  1. **3.3.0（契约预演，~1.5 周）**：slot registry + lazy 页泛化 + 1 个新上衣/下装（沿用现有整层路径）+ 鞋槽 1 件；
     资产 v26 / 页面 v29；验证注册表与页面策略可行。
  2. **4.0.0（完整底座，~2 周）**：配饰全类别 + 2 套验证穿搭 + 2x 决策落地 + UI/存档/DIY 完整；
     资产 v27+ / 页面 v30+；tag/npm/GH/Release/profile 按发版纪律三处同步。
- 或者按用户偏好直接 4.0.0 一次发；但风险更高，不建议。

## 11. 风险与开放决策（需用户拍板）

| # | 问题 | 建议 / 备注 |
|---|---|---|
| 1 | 两套验证穿搭选哪两套 | 建议「日常通勤 + 水手运动」；也可「甜系女仆 + 日常通勤」 |
| 2 | 服装/配饰 2x 是否 4.0 硬需求 | 建议是（否则 DPR2 观感倒退）；代价 hi 显存 ~90–110MiB 上限与设备门槛重估 |
| 3 | 首屏预算新口径 | 引入配饰后是否接受默认造型 lo ≤1.2MB？或做「配饰首帧后补 + 淡入」 |
| 4 | 新槽位是否包含裤装/短袜以外的品类 | 内容基调限制：不出现超短裙/露肩露背；裤装可（需新美术） |
| 5 | 真机验证 D-008 | 需要用户 1 台手机数据；决定 hi 阈值与 2x 预算 |

## 12. 下一步执行清单（新会话 Phase 0）

1. 读本文档 + `docs/dress-up/2.5D-RUNTIME.md` §2/§6.5 + `tools/art/README.md`；
2. 读现有：`docs/dress-up/runtime-2d5-core.js`（resolveLook/visibleDrawables/collectLookAtlasIndices）、
   `runtime-2d5.js`（loadSceneAtTier/ensureAtlasPage/applyLook/uploadDrawable）、`tools/art/build_prod.py`
   （build_atlas_pages/build_v3_outfit）、`tests/dressup-2d5-assets.test.mjs`；
3. 产出 Phase 0 文档：`docs/dress-up/SLOT-REGISTRY.md`（契约定稿 + z 表 + socket 表 + 页组表）+ 决策记录（ADR）；
4. 小实验（不改 main）：用 1 个假耳饰 drawable（复用现有 body/face 纹理）验证 socket 绑定 + mirror + 页选择；
5. 向用户确认 §11 的 5 个开放决策后进入 Phase 1。
