# 4.0 槽位底座契约 · SLOT-REGISTRY

> 状态：**Phase 0 契约定稿（2026-11-27）**。单一真相文件：[`slot-registry.json`](slot-registry.json)
> （`format=feiyu-slot-registry`, `version=1`）。决策记录见 [ADR-4.0-SLOTS.md](ADR-4.0-SLOTS.md)，
> 执行计划见 [PLAN-4.0-SLOTS.md](../PLAN-4.0-SLOTS.md)，代码侧 lazy 页泛化在 **3.3.0** 实施。
> 基线：v3.2.1（资产 v26 / 页面 v29；lo/hi 各 5 页 lazy 图集；线上已生效）。
>
> **本文件是 4.0 槽位/配饰/页分组的契约文本**：构建期（`tools/art/*.py`）与运行期
> （`docs/dress-up/runtime-2d5-core.js`）都以 `slot-registry.json` 为单一真相；本文件负责把 JSON 的
> 字段、语义、取值、迁移与门禁写清楚。实现中若需偏离本契约，必须改 JSON + 本文件 + ADR，并同步
> `tests/slot-registry.test.mjs`；不允许只在代码里写死。
>
> **现状声明**：Phase 0 只交付契约与 ADR，**不改运行期/构建期代码**。当前 v3.2.1 仍是
> `MAX_ATLASES=6` / `MAX_PAGES=6` / 5 页写死分组；这些代码 3.3.0 才切到 registry 驱动。

## 0. 一句话

槽位（slot）= 可独立拆装的服装/配饰层；每个槽位有 **z 绘制层级**、**页面归属（pageGroup）**、**锚定方式**
（服装=seat 蒙皮锚定 / 配饰=socket 骨骼锚定）、**镜像规则**与**互斥规则**。registry 声明 13 个槽位
（7 服装槽 + 6 配饰槽）、8 个页组、12 页文件命名空间，供 3.3.0 构建/运行期读取。

## 1. registry schema

### 1.1 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `format` | string | ✅ | 固定 `"feiyu-slot-registry"`（消费方必须先校验 format） |
| `version` | number | ✅ | 固定 `1`；结构性变更（字段语义不兼容）才升 2，追加字段不升 |
| `status` | string | ✅ | `"phase0-contract"`；3.3.0 实现后改 `"active"` |
| `updated` | string | ✅ | 契约最后更新日期（`YYYY-MM-DD`） |
| `maxPages` | number | ✅ | 每身形图集页数上限 = **12**（= runtime `MAX_ATLASES` = build `MAX_PAGES`，3.3.0 同步） |
| `outfitPageBudget` | number | ✅ | **combo 页预算 = 5**：现有 4 套 pre-composed outfit（maid/hoodie-plaid/hoodie-pleated/sailor-plaid）+ 4.0 新增 1 套（日常通勤：白衬衫+藏青及膝裙作为**一套组合资产出一页**）。只为 pre-composed combo 各出一页，**不生成上衣×下装交叉组合页**（任意混搭在运行期取各槽位 drawable 所属页的并集）；`rig.outfits` 非空套数 > 此值 → 构建报错（扩页需另立 ADR） |
| `outfitPageBudgetNote` | string | ✅ | 说明 5 的来源、不生成交叉组合页、4.0 用满 12 页、4.1 需扩 maxPages |
| `pageBudgetNote` | string | ✅ | 页预算总口径：1 base + ≤5 combo + ≤6 accessory = 12 = maxPages（用满，无 reserve 页） |
| `zTableNote` | string | ✅ | 说明 legacy z 仅文档/新资产契约、旧 rig 以 `drawable.z` 为准 |
| `pageFiles` | string[12] | ✅ | 页文件命名空间（见 §1.2） |
| `basePage` | object | ✅ | base 页定义：`{id,file,pageGroup,slots[],rule}`；`basePage.slots` 是**素体层声明白名单** |
| `pageGroups` | object[] | ✅ | 页组声明与顺序（见 §1.3） |
| `reservedPages` | object[] | ✅ | **空表**：4.0 容量 `1+5+6=12` 用满 `maxPages`，无空闲页；4.1 批量穿搭/更多组合需扩 `maxPages`（另立 ADR） |
| `reservedPagesNote` | string | ✅ | 记录「4.0 无空闲页、4.1 扩页另立 ADR、裤装不占新页组」口径 |
| `futureSlots` | string[] | ⬜ | 预留未来槽位 id（只允许出现在 `conflict`/文档，不参与构建；当前 `headwearLarge`/`earringLarge`） |
| `slots` | object[] | ✅ | 槽位定义（见 §1.4） |
| `rules` | object | ✅ | 全局规则（见 §1.5） |

未知顶层字段消费方必须忽略（向前兼容，不报错）。

### 1.2 页文件命名空间 `pageFiles`

- 长度恒等于 `maxPages`；`pageFiles[0] = "atlas.webp"`，`pageFiles[i] = "atlas-{i+1}.webp"`。
- 页文件名**不是页身份**：实际发出的第 k 页（k 从 0 计）使用 `pageFiles[k]`。当前官方 rig 只发前 5 页
  （base + 4 套 outfit），与 v3.2.1 完全一致；配饰页 3.3.0 起按页组顺序追加。
- `maxPages=12` 是**构建期硬上限**：页数超限 → 构建退出码 1；不得靠截断/合并页绕过。

### 1.3 `pageGroups`（页组声明与顺序）

数组顺序即页组顺序（每项 `order` 必须等于数组下标）。规则：

1. **`base`（order 0）**：恒发第 0 页；包含所有 `basePage.slots` 的常驻 drawable（身体/发/脸/tail/seam-fill）。
2. **`outfit`（order 1）**：每套**非空 pre-composed outfit 一页**；页 id = outfit combo id（如 `maid`），
   页序 = `rig.outfits` 声明顺序（跳过 `base`/无 drawable 的套）；combo 页预算 = 5（现有 4 套 + 4.0 新增
   日常通勤 1 套）。**不生成上衣×下装交叉组合页**：任意混搭在运行期由「当前造型各槽位 drawable 所属页的
   并集」实现（泛化后的 `collectLookAtlasIndices` 天然支持，同页放不下就加载多页，无需构建交叉组合页）。
3. **accessory 页组（order 2…7）**：每个**非空**配饰页组一页；页 id = 页组 id = `pageGroup`；
   页组顺序 = **首屏补齐优先级**（见 §4.2）：`shoes → socks → necklace → earring → headwear → handheld`。
4. 空组不占页；**每页非空**（构建断言）；每个 drawable 必须恰好归属一页（构建断言）。
5. 配饰页组与配饰槽一一对应（`group.slots` 只能含 1 个同类槽位）；服装/legacy 槽统一 `pageGroup="outfit"`。

当前全量页表（**所有组非空时的 4.0 目标布局 = 12 页用满**；3.3.0 前官方仍是前 5 页）：

| 页序号 | 页文件 | 页 id | 页组 | 内容 | 首屏 |
|---:|---|---|---|---|---|
| 0 | `atlas.webp` | `base` | base | 常驻素体层（body/hair/face/tail/seam-fill） | 恒含 |
| 1 | `atlas-2.webp` | `maid` | outfit | maid 套装 2 个整层 drawable | 当前造型命中时 |
| 2 | `atlas-3.webp` | `hoodie-plaid` | outfit | hoodie-plaid 套装 | 当前造型命中时 |
| 3 | `atlas-4.webp` | `hoodie-pleated` | outfit | hoodie-pleated 套装 | 当前造型命中时 |
| 4 | `atlas-5.webp` | `sailor-plaid` | outfit | sailor-plaid 套装（水手运动复用） | 当前造型命中时 |
| 5 | `atlas-6.webp` | `commute`（Phase 1 定名） | outfit | **4.0 新增**日常通勤 pre-composed 套装（白衬衫+藏青及膝裙，一套组合资产） | 当前造型命中时 |
| 6 | `atlas-7.webp` | `shoes` | accessory | 鞋（非空时） | 默认造型必含（不得裸脚） |
| 7 | `atlas-8.webp` | `socks` | accessory | 袜（非空时） | 默认造型必含（不得裸脚） |
| 8 | `atlas-9.webp` | `necklace` | accessory | 项链 | 默认造型必含（日常通勤含细项链） |
| 9 | `atlas-10.webp` | `earring` | accessory | 耳饰 | 默认造型必含（日常通勤含珍珠耳钉） |
| 10 | `atlas-11.webp` | `headwear` | accessory | 头饰 | 水手运动含发带；非默认造型按预算 |
| 11 | `atlas-12.webp` | `handheld` | accessory | 手持 | 水手运动含小鲸鱼挂件；非默认造型按预算 |

> 页序号规则：实际序号 = 已发出页计数（非空组才占位）。3.3.0 前官方 = base+4 outfit = 5 页；
> 4.0 全量 = `1(base) + 5(combo: 现有 4 + 新增日常通勤 1) + 6(配饰页组) = 12 = maxPages`（**用满，无空闲页**）。
> 不生成上衣×下装交叉组合页；任意混搭加载多页由运行期页并集实现。4.1 批量穿搭/更多组合必须扩 `maxPages`
> （另立 ADR，并重估显存/设备门槛），不得挤占既有页或靠截断绕过。

### 1.4 `slots` 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 槽位 id，全局唯一；= 后续 `look.slots` / `state.accessories` 的键、`drawable.slot` 的合法值 |
| `z` | number | ✅ | 槽位基准绘制层级；**全局唯一**（同 z 需要拆层时用小数，如 64.5）。见 §2 z 表 |
| `kind` | `"outfit"｜"accessory"｜"legacy"` | ✅ | `outfit`=4.0 活跃服装槽（整层 paper-doll）；`legacy`=v2.x 兼容槽（保留解析语义、无 4.0 资产计划）；`accessory`=配饰槽 |
| `group` | string | ✅ | 语义/衣柜分类：`under｜top｜bottom｜sleeve｜collar｜shoes｜socks｜necklace｜earring｜headwear｜handheld` |
| `pageGroup` | string | ✅ | 所属页组 id（必须在 `pageGroups` 声明）：服装/legacy 槽=`outfit`；配饰槽=自身页组 |
| `seat` | string | 服装/legacy 必填 | 主蒙皮锚定骨骼（`a/b` 斜杠分隔多骨）；实际权重由资产烘焙，seat 用于文档/适配校验 |
| `socket` | string | 配饰必填 | 锚定骨骼（`a/b` 斜杠分隔多骨）；配饰以「父骨矩阵 × 局部偏移」绑定，见 §3 |
| `mirror` | boolean | ✅ | 镜像规则；语义见 §3.2（`symmetric` / `pair`） |
| `physics` | `"skirt"｜"hair"｜"tail"` | ⬜ | 4.0 只沿用现有三类；配饰默认静态（跟随 socket 骨），飘动列为 4.1 可选 |
| `required` | boolean | ✅ | 是否必须非空才能构成完整造型；4.0 全部 `false`（允许素体/局部造型），由默认造型保证观感 |
| `maxPerSlot` | number | ✅ | 单槽最多穿戴件数 = 1（= `rules.maxPerSlot`） |

`shoes`/`socks` 的 `mirror:true` + 双 socket 表示**左右成对**；`earring` 的 `mirror:true` + 单 socket
表示**绕锚点 X 轴对称对偶**（左耳饰镜像出右耳饰）。

### 1.5 `rules`

```jsonc
{
  "maxPerSlot": 1,
  "conflict": [["headwear", "headwearLarge"], ["earring", "earringLarge"]], // 互斥二元组；id ∈ slots ∪ futureSlots
  "hideBase": [],                     // 预留：隐藏素体某层（4.0 空表；结构 [{slot, hideOptional}]）
  "slotAliases": { "arms": "sleeve", "arm": "sleeve", "sleeves": "sleeve" }, // DIY 旧别名 → canonical
  "pageSelection": {
    "firstFrame": "…",                // 首屏页集合（见 §4.2）
    "outfitPage": "…", "accessoryPage": "…",
    "accessoryPriority": ["shoes", "socks", "necklace", "earring", "headwear", "handheld"],
    "accessoryDelayMs": 200,          // 用户已批准：配饰允许首帧后 200ms 补齐
    "accessoryFadeInMs": 200,         // 补齐后淡入时长
    "prefetchDelayMs": 220,           // 沿用 v3.2.0 首帧后 220ms 空闲预取
    "prefetch": "…", "missingPage": "…", "noBareFirstFrame": "…"
  },
  "anchoring": { "socketSyntax": "…", "mirrorModes": { "symmetry": "…", "pair": "…" }, "seatSyntax": "…" }
}
```

- `conflict` 是**对称互斥**（顺序无关）；两个槽位不得同时非空。`futureSlots` 只作占位，构建期忽略。
- `hideBase` 4.0 恒为空：不得通过隐藏素体层来掩盖穿模；穿模由 §2 z 表 + §3 锚定 + §7 门禁解决。
- `rules.pageSelection` 的 200/220ms 是**已批准口径**（PLAN §11 #3 + v3.2.0 现状），不得实现时改值。

## 2. 槽位 z 表（canonical）

绘制顺序 = z 升序；`z` 全局唯一，新增槽位只能取未占用值。配饰 z 是 4.0 已批准口径，服装/legacy z
为 4.0 canonical（v3 生产资产实际只有 `topBody=64` / `bottom=30` 两个整层，z 由资产烘焙，契约不改旧资产）。

| z | 槽位 | kind | 绘制语义 / 锚定 |
|---:|---|---|---|
| 18 | `socks` | accessory | 袜；`shinL/shinR`，在鞋/裙之下（裙摆可盖袜口） |
| 20 | `shoes` | accessory | 鞋；`footL/footR`，在袜之上、裙之下 |
| 20.5 | `topUnder` | legacy | 内搭/内衬（v2.1 语义，v3 生产无 drawable；历史 z20 与 4.0 `shoes=20` 冲突，canonical 微调 20.5） |
| 30 | `bottom` | outfit | 下装整层（裙，physics=skirt） |
| 50 | `sleeve` | legacy | v2.1 整层袖（兼容槽；v2.2 起由 sleeveUpper/Fore 取代） |
| 56 | `collar` | legacy | 领/胸饰独立层（v2.2 cutout） |
| 60 | `sleeveUpper` | legacy | 上臂袖段（v2.2 cutout） |
| 62 | `sleeveFore` | legacy | 前臂袖段（v2.2 cutout；手 z65 在袖口外） |
| 64 | `topBody` | outfit | 上衣整层（衣身+袖+领一体，单张全画布纹理） |
| 64.5 | `necklace` | accessory | 项链；`chest`，压在衣身之上、手/发之下 |
| 66 | `handheld` | accessory | 手持；`handR`，画在手（z65）之上 |
| 68 | `earring` | accessory | 耳饰；`head`，在刘海（z70）之下 |
| 72 | `headwear` | accessory | 头饰；`head`，在刘海（z70）之上（最顶层） |

### 2.1 槽位总表（registry 字段直读）

| id | z | kind | group | pageGroup | seat / socket | mirror | physics |
|---|---:|---|---|---|---|---|---|
| `socks` | 18 | accessory | socks | socks | socket `shinL/shinR` | pair ✅ | — |
| `shoes` | 20 | accessory | shoes | shoes | socket `footL/footR` | pair ✅ | — |
| `topUnder` | 20.5 | legacy | under | outfit | seat `chest` | ❌ | — |
| `bottom` | 30 | outfit | bottom | outfit | seat `hips` | ❌ | skirt |
| `sleeve` | 50 | legacy | sleeve | outfit | seat `upperArmL/upperArmR` | ❌ | — |
| `collar` | 56 | legacy | collar | outfit | seat `neck` | ❌ | — |
| `sleeveUpper` | 60 | legacy | sleeve | outfit | seat `upperArmL/upperArmR` | ❌ | — |
| `sleeveFore` | 62 | legacy | sleeve | outfit | seat `forearmL/forearmR` | ❌ | — |
| `topBody` | 64 | outfit | top | outfit | seat `chest` | ❌ | — |
| `necklace` | 64.5 | accessory | necklace | necklace | socket `chest` | ❌ | — |
| `handheld` | 66 | accessory | handheld | handheld | socket `handR` | ❌ | — |
| `earring` | 68 | accessory | earring | earring | socket `head` | symmetry ✅ | — |
| `headwear` | 72 | accessory | headwear | headwear | socket `head` | ❌ | — |

（`required` 全部 `false`；`maxPerSlot` 全部 1；`mirror` 语义见 §3.2。）

**硬关系**（`tests/slot-registry.test.mjs` 断言）：`socks < shoes < bottom`；`topUnder < bottom < sleeve`；
`sleeve < collar < sleeveUpper < sleeveFore < topBody`；`topBody < necklace < handheld < earring < headwear`；
`headwear(72) > base 页最高层（hairFront z70）`，`handheld(66) > hand(z65)`。
**不得改口径**：`socks=18 / shoes=20 / necklace=64.5 / handheld=66 / earring=68 / headwear=72` 为用户已批准
4.0 槽位表；只有新增槽位可取未占用 z。

> **legacy z 的边界（重要）**：`topUnder/sleeve/sleeveUpper/sleeveFore/collar` 在 v3 production rig **已无
> drawable**，registry 里的 z 只是**文档/新资产契约**；旧 rig 的实际渲染层级以 `drawable.z` 为准，
> registry **不反改任何旧资产**。历史对齐依据 `docs/dress-up/2.5D-RUNTIME.md` §6.5（cutout 槽位 z 表：
> legs 9 / body 10 / armUpper 45 / armFore 48 / hand 65 / collar 56 / sleeveUpper 60 / sleeveFore 62）：
> `bottom=30`（v2.7/v3）、`collar=56`、`sleeveUpper=60`、`sleeveFore=62` 直接对齐；`topBody` 历史 cutout 40 →
> v3 起整层 canonical **64**（在 hand 65 之下、hairFront 70 之上）；`topUnder` 历史 20 与 4.0 `shoes=20` 冲突，
> canonical **20.5**（仍在 bottom 30 之下，语义不变）；`sleeve` 历史无独立 z，canonical **50**（armFore 48 之上、
> collar 56 之下，对应 v2.1 drawOrder body→topUnder→bottom→topBody→arms→sleeve→hair 的相对位置）。
> 素体层（非 registry 槽位）的实际 drawable z 供参考：`body-torso 10 / body-head 11 / legs 9.1 / armUpper 45 /
> armFore 48 / hand 65 / hairFront（刘海）70 / seam-fill 7.6`（runtime 只读 drawable.z，不受本表约束）。

## 3. socket → 骨骼映射表（真实 rig 校验）

两个生产 rig（`docs/dress-up/art/2d5/{chibi,girl}/rig.json`）**65 骨同名同父链**，registry 引用的骨在
两者中均存在（`tests/slot-registry.test.mjs` 逐身形断言）。锚定 = 运行时每帧在骨骼更新后取
`parentBoneMatrix × localOffset`；`mirror:true` 时按 §3.2 生成对偶。

### 3.1 配饰 socket 表

| 槽位 | socket 骨 | 父链 | 镜像 | 锚定语义 / 参考局部偏移（画布 675×1200，rig space） |
|---|---|---|---|---|
| `shoes` | `footL/footR` | foot→shin→thigh→hips | pair | 每只脚一个实例；锚点 ≈ 踝/脚背（foot 骨 base：chibi `[278,1135]`/`[396,1135]`，girl `[280,1128]`/`[402,1128]`）；贴合脚踝轮廓，不盖袜口 |
| `socks` | `shinL/shinR` | shin→thigh→hips | pair | 每侧小腿一个实例；锚点 ≈ 小腿中段（shin 骨 base：chibi `[284,995]`/`[391,995]`，girl `[286,905]`/`[396,905]`）；袜口在下装之下、鞋之上 |
| `necklace` | `chest` | chest→spine→hips | symmetry=off | 单实例；锚点 ≈ 锁骨上缘（chest 骨 base：chibi `[337.5,640]`，girl `[337.5,500]`）；不得盖住露颈区（D-017 颈区门禁） |
| `earring` | `head` | head→neck→chest | symmetry | 单侧资产 → 绕 head 骨 X 轴镜像出另一侧；单侧 ≤18px 画布；不得遮眼/遮脸 |
| `headwear` | `head` | head→neck→chest | off | 单实例；锚点 ≈ 头顶/发顶（head 骨 base：chibi `[337.5,540]`，girl `[337.5,385]`）；不得遮挡刘海/眼睛/耳朵 |
| `handheld` | `handR` | handR→forearmR→upperArmR | off | 单实例，右手（handR base：chibi `[460,835]`，girl `[455,680]`）；画在手之上、可越界出画布（bbox 允许） |

- socket 列表用 `/` 分隔，**首个为主动锚点**（主实例）；`pair` 模式第 2 个为对偶锚点。
- 局部偏移/旋转/缩放属于**资产元数据**（未来 `rig.items.<id>.anchor`），不属于 registry；registry 只锁
  骨名与镜像模式（见 §5）。
- **`anchor.offset` 语义（Phase 0 spike 澄清，必须按此实现）**：offset 为 **socket 骨干局部 px**，
  世界坐标 = `bone.base + R(bone.angle) · offset`（与 runtime 骨骼矩阵 `M = T(base)·R(theta)` 同式；
  参考实现见 `.scratch/p0-slot-spike/run.mjs`）。**几何朝向**默认 `geometryFrame:"canvas"`（配饰全画布层以
  675×1200 canvas 坐标作者化，运行时绕锚点施加 `R(theta_now − theta_bind)` 旋转，rest 下与 canvas 完全一致）。
  若把 canvas 坐标偏移 `c = pivot_canvas − bone.base` 当 local 用会错位（head.angle=−90° 时 earring 会落到躯干）——
  canvas 偏移 → 骨局部 offset 的换算：`offset = R(−angle) · c`（spike 已验往返 0px）。
  已验证候选值（**骨局部 offset**；pivot canvas 见括号）：chibi 对称内缩 L`[111,−254]`/R`[111,254]`（pivot
  `(83.5,429)`/`(591.5,429)`）、按侧美术锚定 L`[95,−262.5]`/R`[109,251.5]`（pivot `(75,445)`/`(589,431)`）；
  girl 对称内缩 L`[76,−173]`/R`[76,173]`（pivot `(164.5,309)`/`(510.5,309)`）、按侧 L`[68,−189.5]`/R`[67,199.5]`
  （pivot `(148,317)`/`(537,318)`）。
- 偏移合理性由 Phase 2 门禁校验（§7）：单侧耳饰 ≤18px、项链落锁骨、鞋袜不越出肢体轮廓、头饰不遮眼。

### 3.2 mirror 语义（两种模式，由 socket 数量决定）

| socket 数量 | `mirror` | 模式 | 实例化规则 |
|---:|---|---|---|
| 2 | `true` | `pair` | 每个 socket 渲染一个实例；第二实例做 **UV/几何 X 镜像**（资产只提供一侧） |
| 1 | `true` | `symmetry` | 单实例 + 绕锚点局部 X 轴镜像对偶（耳饰左右各一） |
| 1 | `false` | 单例 | 正常单实例（项链/头饰/手持） |

构建期也允许直接出双件（`mirror:false` 的成对资产不进 4.0 首批）；运行时必须以 registry 的
`mirror`+socket 数量为准，不允许资产自带覆盖。

> **Phase 0 spike 修正（2026-11-27，见 `.scratch/p0-slot-spike/REPORT.md` + `METRICS.json`）**：真实耳鳍/头部
> 美术轮廓左右不完全对称（chibi 耳鳍下方轮廓最大 Δ≈27px、耳翼尖 Δx≈8px/Δy≈14px；girl 同区 ~9–11px；
> 纯镜像变换本身误差为 0px）。纯 symmetry 单 offset 镜像会让一侧耳饰偏离耳鳍。因此 **symmetry 配饰允许按侧
> 覆盖锚点**：`rig.items.<id>.anchor = { socket:"head", offsetL:[dx,dy], offsetR:[dx,dy], geometryFrame:"canvas" }`
> （几何仍单侧 + 运行时镜像；位置按侧取 **骨局部** offset，见 §3.1 语义；spike 候选 chibi L`[95,−262.5]`/
> R`[109,251.5]`、girl L`[68,−189.5]`/R`[67,199.5]`；对称内缩摆法 L/R 完全在轮廓内，作为美术备选）。
> registry 的 `mirror`/socket 声明不变。

### 3.3 服装 seat 表（蒙皮锚定）

| 槽位 | seat 骨 | 说明 |
|---|---|---|
| `topUnder` | `chest` | 内搭跟随胸腔 |
| `bottom` | `hips` | 裙/下装以 hips 为主并叠加 15 弹簧链（skirt 物理） |
| `topBody` | `chest` | 整层上衣已烘焙 LBS 权重，seat 仅语义/适配校验 |
| `sleeve` | `upperArmL/upperArmR` | 双侧袖层 |
| `sleeveUpper` | `upperArmL/upperArmR` | 上臂袖段 |
| `sleeveFore` | `forearmL/forearmR` | 前臂袖段 |
| `collar` | `neck` | 领/胸饰，避开短脖子 chibi 高领（D-017） |

### 3.4 素体层声明（`basePage.slots`）

`["body","legs","armUpper","armFore","hand","hairBack","strands","hairFront","face"]`。

构建期校验口径：`rig.drawables[].slot` 必须 ∈ `basePage.slots ∪ slots[].id`（覆盖当前 4 个 rig 全部
drawable；`seam-fill` 的 slot 是 `body`）。新增素体层槽位必须同 步改 `basePage.slots` + 本表。

## 4. lazy 页分组新契约（3.3.0 实施；本文为契约）

> 现状（v3.2.1）：`build_prod.build_atlas_pages()` 写死 `LAZY_OUTFIT_COMBOS` 4 套 + `LAZY_ATLAS_FILES`
> 5 页；runtime `collectLookAtlasIndices` 只遍历固定 `OUTFIT_SLOTS`；`MAX_ATLASES=6` / `MAX_PAGES=6`。
> 4.0 契约把它泛化为「registry 页组驱动 + ≤12 页」，**3.3.0 实施**（不升资产版本、官方 5 页逐字节不变）。

### 4.1 构建分组规则（`build_prod.build_atlas_pages` 泛化目标）

1. 读 `docs/dress-up/slot-registry.json`；缺失时优雅回退「仅 outfit 页」（旧源包/旧测试可用）。
2. 页序：`base`（未被任何 outfit/accessory 引用的 drawable）→ 按 `rig.outfits` 声明顺序的 **pre-composed
   combo 页**（跳过 `base`/空套，页 id=combo；4.0 预算 5 = 现有 4 + 新增日常通勤 1；**不为上衣×下装交叉组合
   生成页**）→ 按 registry `pageGroups` 顺序的非空 accessory 页（页 id=页组 id）。
3. 页文件 = `pageFiles[已发出页计数]`；每个 drawable 恰好一页、每页非空、页 ≤4096×4096、页数 ≤12。
4. 校验：drawable.slot ∈ registry 声明；accessory 页组必须已定义；combo 页数 ≤ `outfitPageBudget`（4.0 = 5，
   超预算即需按 ADR 风险项决策：扩 `maxPages` 另立 ADR，构建不得静默通过）。
5. hi tier 复用同一分组（页 id/file/顺序必须与 lo 一致）；`build-report` 记录页组/2x 元数据。

### 4.2 首屏页集合与 200ms 补齐 + 淡入（用户已批准口径）

- **首屏页集合（lo，默认造型）** = `base` + 当前造型各槽位 drawable 所属页的并集（combo 页 + 非空配饰槽
  的页组页）——**4.0 默认造型 = base + commute combo 页 + shoes/socks/necklace/earring 4 个配饰组页**；
  总 payload（brotli 传输字节）**≤ 1.2MB = 1,200,000B（十进制硬门禁，≈1.14MiB；不得按 1.2MiB 放宽）**。
  参照：现有 chibi 默认 maid 首屏 ≈0.96MiB（1,009,691B）；Phase 1 实测按 1,200,000B 硬校验。
- **实测口径（Lead 2026-11-27）**：当前 chibi 默认 maid 首帧 = base 674,382B + maid 199,592B +
  `rig.bin.br` 135,717B ≈ **0.96MiB**；4.0 默认造型 = base + 1 combo 页（新 combo 页预计与 maid 同量级）
  + 4 个默认配饰组页（鞋/袜/耳饰/项链，矢量页预计每页几 KB–几十 KB）+ rig → **预计 ≈1.0MiB
  （1,048,576B）≤ 1,200,000B ✓**。
- **首帧不得裸脚/无配饰**：默认造型的 `shoes` + `socks` 页必须进首帧（不得裸脚），并至少保证一件配饰
  （默认造型含 `necklace` + `earring`）在首帧呈现；配饰页按 `accessoryPriority` 加载，缺页允许**首帧呈现后
  ≤200ms 补齐 + 200ms 淡入**（水手运动的发带/手持等非默认造型配饰同理）。
- **不是「先裸再补」**：若配饰页未就绪，允许延迟呈现（保持加载态/上一造型帧）而不是先画裸脚再弹配饰；
  已有造型切装时继续沿用 v3.2.0「缺页保留旧造型，补页后自动应用」。
- **超预算降级顺序**：`handheld → headwear → earring` 移入 200ms 后补集合；`shoes/socks/necklace` 不得移出
  （否则违反「不得裸脚/无配饰」）。若仍超预算 → 构建/Phase 1 资产返工（鞋袜/项链矢量页必须控制在预算内）。
- **预取/缺页**：首帧后 220ms 空闲预取当前身形**全部剩余页**（现有逻辑泛化，不逐页写死）；
  `setLook` 缺页延迟应用不变；`setShape(shape,{look})` 首帧期望造型语义不变。
- `prefers-reduced-motion: reduce` 时配饰补齐直接切换、不做淡入（不新增动画）。

### 4.3 页选择伪代码（运行期目标，3.3.0）

```js
// collectLookAtlasIndices(rig, look)：base 恒含 0；遍历 look.slots 的**全部槽位**（数组/单值兼容），
// 按 drawable.atlasIndex 聚合，DIY drawable 跳过；不假设槽位集合（旧 rig 行为不变）。
const indices = new Set([0]);
for (const slot of Object.keys(look.slots || {})) {
  for (const id of asArray(look.slots[slot])) {
    const d = drawableById.get(id);
    if (!d || d.diy) continue;
    indices.add(d.atlasIndex ?? 0);
  }
}
return [...indices].sort((a, b) => a - b);
```

配饰页是否在首屏/后补由 §4.2 预算规则决定（runtime 选页后按 `accessoryPriority` 截断），
但**所有非空槽位所属页最终都会被预取**，不存在「穿了但永不加载」的状态。

## 5. 未来 rig 内嵌 schema 与向后兼容

### 5.1 `rig.slots2`（registry 引用 + 槽位元数据，Phase 2 起可选内嵌）

```jsonc
"slots2": {
  "registry": "feiyu-slot-registry@1",          // 版本引用；与 docs 侧 version 不同 → 只读兼容模式
  "slots": {
    "topBody":  { "kind": "outfit",    "pageGroup": "outfit" },
    "headwear": { "kind": "accessory", "pageGroup": "headwear", "socket": "head", "mirror": false },
    "shoes":    { "kind": "accessory", "pageGroup": "shoes",    "socket": "footL/footR", "mirror": true }
  }
}
```

- `rig.slots2.slots` 是**内嵌快照**，不替代 `slot-registry.json`；两者冲突时以 docs registry 为准（测试/CI 校验）。
- 运行期可不读 docs registry（浏览器只加载 rig）；`drawable.atlas`/`atlasIndex` 已携带页归属，
  因此 slots2 只用于槽位元数据/UI/DIY 白名单。

### 5.2 `rig.items`（统一单品表，推荐；不再引入 `rig.accessories`）

```jsonc
"items": {
  "acc-earring-pearl": {
    "id": "acc-earring-pearl", "name": "珍珠耳钉", "slot": "earring",
    "drawables": ["acc-earring-pearl"],            // 通常 1 个（配饰整层），允许 >1
    // symmetry 配饰（耳饰）可给左右两套 offset（耳鳍/头部美术左右不完全对称时按侧覆盖）；
    // offset = socket 骨局部 px（world = base + R(angle)·offset）；geometryFrame=canvas 表示几何按
    // 全画布坐标作者化、运行时绕锚点旋转。spike 候选 chibi L[95,-262.5]/R[109,251.5]。
    "anchor": { "socket": "head", "offsetL": [95, -262.5], "offsetR": [109, 251.5],
                "geometryFrame": "canvas", "pivotCanvasL": [75, 445], "pivotCanvasR": [589, 431],
                "rotation": 0, "scale": 1 },
    "mirror": true, "physics": null,
    "colors": ["white", "gold"], "source": "vector"
  },
  "acc-loafer-navy": {
    "id": "acc-loafer-navy", "name": "藏青乐福鞋", "slot": "shoes",
    "drawables": ["acc-loafer-navy"],
    "anchor": { "socket": "footL", "offset": [0, 6], "mirrorSocket": "footR" },
    "mirror": true, "physics": null, "colors": ["navy"], "source": "vector"
  }
}
```

- `item.slot` 必须 ∈ registry `kind="accessory"` 槽位；`item.mirror` 必须与 registry 一致（不一致 → 拒绝该 item）。
- `anchor.offset` 为 **socket 骨局部 px**（world = base + R(angle)·offset，见 §3.1）；`pair` 模式用
  `mirrorSocket` 指定对偶骨；`symmetry` 模式可用 `offsetL/offsetR` 按侧覆盖锚点（耳鳍不对称时；见 §3.2）；
  `geometryFrame:"canvas"`（默认）表示全画布层几何按 canvas 坐标作者化，运行时绕锚点旋转 `R(θ_now−θ_bind)`。
- `rig.outfits` **保持不变**（整层服装 = `{combo}: {topBody:[...], bottom:[...]}`）；4.0 不把配饰塞进 outfits。

### 5.3 向后兼容矩阵（不得破坏 v3 行为）

| 输入形态 | 行为 |
|---|---|
| v3.2.1 rig（无 `slots2`/`items`，有 `atlases`/`drawables[].atlas`） | **v3 行为**：OUTFIT_SLOTS + rig.outfits + rig.slots；配饰槽解析为空 |
| 旧单页 rig（`rig.atlas`，无 `atlases`） | 历史单页路径完全不变（`normalizeAtlases` legacy） |
| 旧 v2.2–2.7 cutout rig（有 sleeveUpper/Fore/collar drawable） | 仍按 OUTFIT_SLOTS 解析；z/页由旧资产自带；配饰槽为空 |
| 有 `slots2`/`items` 的新 rig | 配饰槽可解析；未知 slot/item → warning + 忽略，不抛错 |
| docs registry 缺失（源包/旧测试） | 构建回退仅 outfit 页；运行期不依赖 docs registry |
| 旧存档/旧 DIY pack | 见 §6/§8，迁移不抛错、不丢件、不裸装 |

**硬约束**：不删除任何现有 API 字段与导出（`OUTFIT_SLOTS`/`MAX_ATLASES`/`collectLookAtlasIndices` 等）；
`getState().look.slots` 旧 4 键语义不变；无 registry 的旧 rig 永远走 v3 行为。

## 6. 存档 `state.accessories` 迁移规则

### 6.1 目标形状

```js
state = {
  shape: 'chibi',
  outfit: 'maid',            // 或 'none' + top/bottom
  top: 'hoodie', bottom: 'plaid',
  accessories: {             // 4.0 新增；缺省等价全 null
    shoes: 'acc-loafer-navy',
    socks: 'acc-sock-white',
    necklace: 'acc-necklace-fine',
    earring: 'acc-earring-pearl',
    headwear: null,
    handheld: null,
  },
  // 其它旧字段（bg/effect/…）保持不动
}
```

- 未穿 = 键不存在或值为 `null`；写回时只写非空槽（减小体积），读取两者等价。
- 配饰与套装/上下装**正交**：`outfit` 模式下配饰仍可叠加；互斥只由 `rules.conflict` 决定。

### 6.2 迁移规则（`normalizeState` 扩展，Phase 2）

1. 旧存档无 `accessories` → 归一为 `{}`（全空），**不写回、不报错**；旧 `shape/outfit/top/bottom/bg/effect` 原样保留。
2. `accessories` 非对象 → `{}`；值为非字符串/未知槽键 → 丢弃该键（记 warning，不抛错，不阻塞启动）。
3. 值不在当前身形 manifest/`rig.items` 白名单 → 该槽归一为 `null`（下架/跨身形单品不崩）；其它槽与字段不丢。
4. 槽位合法性 = registry `kind="accessory"` 槽位集合；**不得**把配饰写进 `outfit/top/bottom` 或 `look.slots` 的服装槽。
5. 迁移是**纯函数**、幂等；不产生 `localStorage` 写放大；DIY 静态模式下配饰仍按 socket 静态渲染（Phase 2 验证）。
6. manifest 版本 8→9（新增配饰分类）由 app 负责；`normalizeState` 必须先于渲染执行。

### 6.3 回滚

4.0 之前版本读到带 `accessories` 的存档：会忽略未知字段（现有 normalizeState 行为），造型回退 v3 观感，
**不丢**服装/套装选择 —— 回滚安全。

## 7. 2x / hi tier 策略与设备门槛（Phase 0 定稿 → Phase 2 实现 → Phase 3 headless 校准）

### 7.1 已批准口径（不得改）

- **服装/配饰 2x 是 4.0 硬需求**（D-005 结论）：hi tier 的 base/outfit/accessory 图集页全部出 2x
  （服装整层 675×1200 → 1350×2400）；hi 显存预算重估上限 **~90–110MiB**；设备门槛/降级策略 Phase 0 定。
- 首屏预算见 §4.2（lo 默认造型 ≤1.2MB = 1,200,000B 十进制硬门禁，配饰 200ms 补齐+淡入）。
- 真机验证 D-008 **wontfix**：所有数字以 headless SwANGLE 为准，发布说明保留「未真机验证」措辞。

### 7.2 hi 显存估算（基于当前 v3.2.1 hi 构建报告的页面像素，headless，MiB）

| 组成 | chibi | girl | 说明 |
|---|---:|---:|---|
| hi base 页（2x 素体/发/脸/tail + 1x seam-fill） | ~38.0 | ~36.8 | 现状单页 raw 像素 |
| hi outfit 页 ×4（4.0 起 2x） | ~15.9 | ~17.9 | 现状 1x 页 ~4.0/4.5MiB ×4 |
| hi accessory 页 ×6（4.0 起 2x） | ~8–14 | ~8–14 | 矢量小件 2x，单页上限按 2048² 卡 |
| 合计 raw | ~62–68 | ~63–69 | 像素量估算 |
| + mipmap ×4/3 | ~83–91 | ~84–92 | 纹理 mipmap 链 |
| + 打包/驱动余量 ~8–18% | **≈90–107** | **≈90–108** | 落在已批准 **~90–110MiB 预算上限**内 |

- 硬门禁：单页 ≤4096×4096；hi 全页驻留估算 > **110MiB**（已批准预算上限）→ 构建失败或裁剪/合并配饰页（不准静默超预算）。
- Phase 3 用 headless `getMemory()`/`qa:load` 实测替换本表数字（估算 → 实测校准）；真机仍未测（D-008）。

### 7.3 设备门槛与降级策略（Phase 0 定稿，Phase 2 实现验证）

| 档位 | 资产内容 | 显存预算 | 启用条件（Phase 2 实现） |
|---|---|---:|---|
| `hi-full` | base 2x + outfit 2x + accessory 2x | ~90–110MiB | `DPR ≥ 2` **且** `MAX_TEXTURE_SIZE ≥ 4096` **且** `navigator.deviceMemory ≥ 8` **且** `hardwareConcurrency ≥ 8` **且** 非 `saveData` |
| `hi-base` | base 2x + outfit/accessory 1x（= v3.2.1 hi 语义） | ~55–60MiB | 现有门槛：`DPR ≥ 2` 且（`deviceMemory ≥ 4` 或 `cores ≥ 4`）且 `MAX_TEXTURE_SIZE ≥ 4096`；**deviceMemory 不可用（Safari/iPadOS）时只到 hi-base** |
| `lo` | 全 1x | ~15–18MiB | 其余/未知设备 |

- **不得只凭估算开 hi-full**：`hi-full` 必须同时满足内存与核数（现行 v3 的「任一满足」只用于 hi-base）。
- 降级触发（运行期，Phase 2）：估算/实测显存超预算、`MAX_TEXTURE_SIZE < 4096`、WebGL context lost、
  后台标签页内存压力 → 降一档（hi-full → hi-base → lo），重载目标 tier 页并保留造型/参数/物理状态。
- 首帧策略沿用 v3.1.0：hi 设备先 lo 出帧，再后台热切换 hi；4.0 hi-full 的 2x outfit/accessory 页也在
  lo 首帧之后再切，避免首屏等待大页。
- 允许调试覆盖（`?feiyuTier=lo|hi` / localStorage）不变；QA 静态模式必须可完全复现档位。

### 7.4 首屏 payload 预算测算（lo，默认造型，headless 传输字节）

| 项 | 当前 v3.2.1 chibi（默认 maid） | 4.0 默认造型（日常通勤，估算） |
|---|---:|---:|
| `rig.bin.br` | 135,717B | 不变（rig 结构不变） |
| base 页 | 674,382B | ~674KB |
| 当前 combo 页 | 199,592B（maid） | commute combo 页 ~150–230KB（与 maid 同量级） |
| 鞋/袜页 | — | ~30–65KB（矢量，2 页） |
| 项链/耳饰页 | — | ~13–35KB（矢量，2 页） |
| **合计** | **≈0.96MiB（1,009,691B）** | **预计 ≈1.0MiB（1,048,576B）≤ 1,200,000B ✓** |

- Phase 1 出资产后实测；超预算按 §4.2 降级顺序把 `handheld/headwear/earring` 移到 200ms 后补。
- 数字口径：lo tier、brotli 传输字节、headless 构建产物；不含 HTTP 头/JS 模块（与现有 0.96MiB 同口径）。

## 8. DIY pack 槽位白名单兼容

- **旧 pack（v2.1–3.2）完全不改**：`topUnder/bottom/topBody/sleeve/sleeveUpper/sleeveFore/collar` 语义不变；
  别名 `arms/arm/sleeves → sleeve`（`rules.slotAliases`）；旧 base 引用 auto-pair 迁移逻辑不变（v3 只补 1 个整层）。
- **新增配饰 pack（4.0 Phase 2）**：仅允许写入 registry `kind="accessory"` 槽位；每层必须满足
  `maxPerSlot=1`；socket/mirror/z 由 registry 决定，**pack 不得自带 z / 不得覆盖锚定**；未知 slot → 拒该层
  （现有 diy 校验风格），不影响 pack 其它层与用户自绘数据。
- DIY 静态贴片模式下配饰跟 socket 骨静态渲染；叠放顺序按 §2 z 表；DIY 记录仍只支持 chibi（现有提示不变）。
- 打包/上传/存储链路（`diy-pipeline.js`/`diy-store.js`/manifest v8）字段只增不改；配饰 pack 的
  manifest 版本递增由 Phase 2 统一处理。

## 9. 门禁与验收标准

### 9.1 Phase 0（本契约，立即）

- `node --test tests/slot-registry.test.mjs` 全绿（结构/骨骼/页命名空间/现行 cap 兼容/页选择行为不变/文档落盘）。
- 官方 rig（chibi/girl 4 个目录）**零改动**；`npm test` 不因新测试变红。
- 文档三件套齐备：本文件 + [ADR-4.0-SLOTS.md](ADR-4.0-SLOTS.md) + registry JSON。
- 假耳饰 spike 通过（`.scratch/p0-slot-spike/`，35/35）：socket 数学往返 0px、真实 `build_2d5` 6 页构建
  （假配饰页 pixelEqual）、页选择缺口（tracked 漏配饰页）、跨 combo 混搭页并集、旧 rig 回退。

### 9.2 3.3.0（页泛化实施，不进 4.0 资产）

- 构建：`build_prod.build_atlas_pages` 读 registry + `build_2d5.MAX_PAGES=12`；官方 5 页 id/file/顺序/
  逐 drawable 归属**逐字节不变**（`verify:full` + `FEIYU_ASSET_VERIFY_DIST=1`，`rig.json`/`rig.bin`/全部页 md5 一致）。
- 运行期：`MAX_ATLASES=12`；`collectLookAtlasIndices` 泛化（§4.3）后官方 rig 行为不变；
  `lib/webserver.readAssetPrefetchInfo` 改为从 `rig.json.atlases` 派生（回退旧清单）。
- 测试：`tests/slot-registry.test.mjs` 的 cap 断言升级为 `=== registry.maxPages`；新增 synthetic
  ≥7 页/配饰页用例（页选择、页序、每 drawable 恰一页、12 页上限）；官方 5 页显式回归不得放宽。
- 4.0 Phase 1/2 新增日常通勤 pre-composed combo 页后，官方基线 = **6 页**（base + 5 combo），配饰页按
  pageGroups 顺序追加，总 ≤12；**不生成交叉组合页**。
- 不升资产版本、不发 npm 版本（3.3.0 是契约预演；发版按 Lead 纪律）。

### 9.3 4.0 Phase 2（配饰 + 2x 落地）

- 配饰锚定：socket 骨存在（两身形）、局部偏移在合理范围、`pair/symmetry` 镜像对偶几何对称；
  **symmetry 配饰（耳饰）按侧 anchor（offsetL/offsetR）**——耳鳍左右美术不对称（spike chibi Δx=27px），
  不得只用单 offset 纯镜像位置。
- 穿模/遮挡：配饰不得遮挡 eye/face/neck 关键区（沿用 `garment-hygiene` 像素断言）；头饰不遮刘海/眼，
  耳饰单侧 ≤18px，项链落锁骨上缘；chibi 禁高领（D-017）不变。
- 存档迁移：旧 state（无 accessories）/旧 DIY pack（v2.2–3.2 refs）不抛错、不丢件、不裸装。
- 2x：hi 页 ≤4096、显存门禁 ≤110MiB（headless）、设备门槛按 §7.3；lo/hi 抓帧 1x/2x 通过视觉对比。
- `npm run typecheck && npm test` 全绿；`npm run verify:full` 通过。

### 9.4 Phase 3（发版门禁）

- 视觉 QA：baseline 80 → **~120 张**（新增 2x 区域：`ear`/`necklace`/`wrist`/`shoes`/`hem`；区域坐标从
  registry/socket 推导，不写死 canvas 坐标）。
- 首屏：`npm run qa:load` 通过；默认造型 lo payload ≤1.2MB（1,200,000B 十进制硬门禁）；首帧无裸脚/无配饰帧；
  配饰 200ms 补齐 + 淡入。
- 显存：headless hi 实测 ≤110MiB；设备门槛/降级实测记录进 CHANGELOG。
- 发布措辞保留「**未真机验证**（D-008 wontfix，headless SwANGLE 为准）」；发版三处同步按用户发版纪律。

## 10. 变更流程

1. 改 `slot-registry.json`（唯一允许的契约源头）→ 2. 同步本文件 + ADR（新决策另开 ADR 条目）→
   3. 同步 `tests/slot-registry.test.mjs`（结构/关系断言）→ 4. 3.3.0 起再同步构建/运行期读取方。
2. 以下变更必须 Lead/用户确认：已批准口径（z 表、200ms、≤1.2MB=1,200,000B、90–110MiB、槽位边界）、`maxPages`、
   删/改既有 slot id、`rules.*` 语义。
3. 纯追加（新槽位、新页组、新 futureSlots）可在 Phase 内按契约流程加，但必须保持 §2 硬关系与容量守恒
   （超 `maxPages` 必须先扩页上限并重估显存/设备门槛）。
4. 代码实现（3.3.0）只能「读契约」，不得在代码里再写一份槽位/页表；旧 rig 回退路径除外。

## 11. 术语表

| 术语 | 含义 |
|---|---|
| slot | 槽位：可独立拆装的层（服装/配饰）；drawable 的归属单位 |
| pageGroup | 页组：决定图集页归属与页序的组（base/outfit/配饰各类别） |
| base 页 | 第 0 页，常驻素体层；恒加载 |
| lazy 页 | 非 base 页，按当前造型懒加载/空闲预取 |
| socket | 配饰锚定骨骼（父骨矩阵 × 局部偏移） |
| seat | 服装主蒙皮锚定骨骼（权重已烘焙，seat 用于语义/校验） |
| pair | 左右成对镜像（鞋/袜）：两个 socket、第二实例 X 镜像 |
| symmetry | 绕单锚点对称镜像（耳饰） |
| z 表 | 槽位基准绘制层级表；全局唯一、决定叠放顺序 |
