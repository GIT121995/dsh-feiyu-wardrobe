# ADR-4.0-SLOTS · 4.0 槽位底座契约与 lazy 页分组泛化

> 状态：**已决策（Phase 0，2026-11-27）· 代码未实施（3.3.0）**
> 决策依据：[SLOT-REGISTRY.md](SLOT-REGISTRY.md)（契约正文）+ [`slot-registry.json`](slot-registry.json)（单一真相）
> + [PLAN-4.0-SLOTS.md](../PLAN-4.0-SLOTS.md) §11（用户已批准口径）+ Phase 0 可行性原型证据（§验证证据）。
> 基线：v3.2.1（资产 v26 / 页面 v29 / lo·hi 各 5 页 lazy / 线上生效）；当前代码 `MAX_ATLASES=6`、
> `MAX_PAGES=6`，**本 ADR 不改任何 tracked 代码**，实施版本 **3.3.0**（PLAN §10 契约预演）。
> 关联：[2.5D-RUNTIME.md](2.5D-RUNTIME.md) · [tools/art/README.md](../../tools/art/README.md) · `tests/slot-registry.test.mjs`

## 摘要（决策一览）

| # | 决策 | 结果 | 实施 |
|---|---|---|---|
| 1 | registry 形态 | **JSON 单一真相**（`slot-registry.json`，v1），构建期 Python、运行期/文档共用；不新增 JS 副本 | 3.3.0 读取 |
| 2 | lazy 页分组泛化 | **方案 A：base + 每 pre-composed outfit combo 一页（4.0 预算 5）+ 每非空 accessory 页组一页**；**不生成上衣×下装交叉组合页**（任意混搭 = 运行期页并集）；registry `pageGroups` 驱动；被否 B（配饰合并 1 页）/C（按造型动态打包） | 3.3.0 |
| 3 | 页数上限 | `MAX_ATLASES` / `MAX_PAGES` **6 → 12**（= registry `maxPages`）；容量 `1 base + ≤5 combo + ≤6 accessory = 12`（4.0 用满、无 reserve 页），见 §4 | 3.3.0 |
| 4 | z 表与锚定 | 槽位 z 全局唯一（配饰 z 按用户批准值）；配饰 = **socket 骨骼锚定**（pair/symmetry 两种 mirror 模式），服装 = **seat 蒙皮锚定**（权重已烘焙） | 契约即冻结；锚定实现 4.0 Phase 2 |
| 5 | 服装/配饰 2x | **4.0 硬需求**；hi 全 2x 显存预算 ~90–110MiB；设备门槛 Phase 0 定（§6 ADR-005）→ Phase 2 实现验证 → Phase 3 headless 实测校准 | 4.0 |
| 6 | 首屏预算 | 默认造型 lo **≤1.2MB = 1,200,000B（十进制硬门禁，≈1.14MiB）**；配饰允许**首帧后 200ms 补齐 + 200ms 淡入**；首帧不得裸脚/无配饰（用延迟呈现而非先裸再补） | 4.0 |
| 7 | 兼容/迁移 | 旧 rig 无 registry/`slots2` → **v3 行为**；旧存档/旧 DIY pack 迁移不抛错不丢件；官方 5 页逐字节不变；单 PR 可回滚 | 3.3.0 / 4.0 |

## 1. 背景：现状硬编码点清单（HEAD `4d57b38`，v3.2.1）

4.0 的「多槽位 + 配饰 + 2x」会同时撞上以下写死设计；它们就是 3.3.0 的实施面：

| # | 文件:行 | 现状（写死点） | 3.3.0 改动 |
|---|---|---|---|
| 1 | `tools/art/build_prod.py:142` | `LAZY_OUTFIT_COMBOS = ('maid','hoodie-plaid','hoodie-pleated','sailor-plaid')` | 删除固定 combo 表，改按 `rig.outfits` 声明顺序 |
| 2 | `tools/art/build_prod.py:143` | `LAZY_ATLAS_FILES = ('atlas.webp','atlas-2..5.webp')` | 页文件改由 registry `pageFiles[已发出页计数]` 生成 |
| 3 | `tools/art/build_prod.py:2040`（`:2049`/`:2053-2057`） | `build_atlas_pages()` 固定生成 base+4 页；未知套装直接退出码 1 | 读 registry `pageGroups`：base → outfit（声明序、跳空）→ accessory（页组序、仅非空）；校验 drawable.slot 已声明、页组已定义、页数 ≤ `outfitPageBudget`/`maxPages`；registry 缺失回退仅 outfit 页 |
| 4 | `tools/art/build_2d5.py:65`（校验 `:235-236`） | `MAX_PAGES = 6`（「上限留 1 页余量」） | `MAX_PAGES = 12`，错误文案同步 |
| 5 | `docs/dress-up/runtime-2d5-core.js:255`（循环 `:263`） | `collectLookAtlasIndices` 只遍历固定 `OUTFIT_SLOTS` | 遍历 `look.slots` **全部槽位**（数组/单值兼容），按 `drawable.atlasIndex`→`atlas` id/file→base 0 聚合；DIY 跳过；旧单图集 rig 行为不变 |
| 6 | `docs/dress-up/runtime-2d5-core.js:522`（校验 `:547`） | `MAX_ATLASES = 6`；注释「预留 1 页余量」 | `MAX_ATLASES = 12`；`too_many_atlases` 文案/注释同步 |
| 7 | `docs/dress-up/runtime-2d5-core.js:512`、`runtime-2d5.js:1335`（`:1457` 预取延时） | `OUTFIT_SLOTS` 固定 7 槽；注释「base + 每套装一页，≤6 页」；`ATLAS_PREFETCH_DELAY_MS=220` | `OUTFIT_SLOTS` 保留作兼容导出（不删）；注释改 12 页/页组口径；预取延时不变 |
| 8 | `lib/webserver.js:110`（清单 `:131-132`） | `readAssetPrefetchInfo().files` 写死 `lo=rig.bin+atlas.webp+atlas-2..5.webp`、`hi=rig.bin+atlas.webp` | 从 `art/2d5/<shape>/rig.json` 的 `atlases[]` 派生（lo=rig.bin+全部页 / hi=rig.bin+首页）；读不到/非法回退旧清单；shape 列表仍来自 `manifest.json` |
| 9 | `docs/dress-up/index.html:106` | 首屏 preload 写死 `['rig.bin','atlas.webp']` | 语义不变（rig.bin+base 页），不加配饰页 preload（首屏预算由 runtime 懒加载控制） |
| 10 | `tests/cutout-runtime.test.mjs:146` | `assert.equal(MAX_ATLASES, 6)` | **必须同步改 12**（上限提升会破此断言；Phase 0 已发现并登记） |
| 11 | `tests/build-2d5-multi-atlas.test.mjs:245`（`:257`） | 「7 页输入必须失败（MAX_PAGES=6）」 | 改为「13 页失败 / 12 页通过」，保留官方 5 页显式回归；新增 synthetic outfit+accessory 页用例 |
| 12 | `tests/runtime-2d5-core.test.mjs:686`、`tests/dressup-client-config.test.mjs:87-98`、`tests/dressup-2d5-assets.test.mjs`、`tests/asset-build.test.mjs` | 页选择 5 页/6 上限/写死页表断言 | 保留官方 5 页显式断言；新增 ≥7 页/配饰页/12 页上限/回退用例（见 §10 验收） |

## 2. ADR-001：registry 用 JSON 单一真相（不新增 JS 副本）

**决策**：槽位/页组/规则只存在 `docs/dress-up/slot-registry.json` 一份；构建期 Python 直接 `json.load`，运行期/文档
（如需）读同一文件或读 rig 内嵌 `slots2` 快照。**不**新增 `slot-registry.js` ESM 副本（PLAN §3.1 的「JS 或 JSON」二选一）。

**理由**：① Python 构建期与 JS 运行期都能零依赖读取；② 单一文件 = 单点变更/单点测试，避免 JS/JSON 双份漂移；
③ `tests/slot-registry.test.mjs` 可直接读 JSON 做契约测试；④ 运行期浏览器实际只需要 rig 自带数据
（`drawable.atlas`/`atlasIndex`），无需加载 registry，不增加首屏请求。

**后果**：运行期不能动态读 registry 变更（需重建 rig/打包）；rig 内嵌 `slots2` 仅作快照，冲突时以 docs
registry 为准；新增字段不升 version（向前兼容），破坏性语义变更才升 version。

## 3. ADR-002：lazy 页分组泛化 = 方案 A「组页」（被否 B/C）

**决策**：`base 页 + 每 pre-composed outfit combo 一页 + 每非空 accessory 页组一页`；**不生成上衣×下装交叉组合页**
（Lead 2026-11-27 裁决）；页序确定规则：

1. 第 0 页 base（常驻素体层，`basePage.slots` 白名单）；
2. outfit 页：按 `rig.outfits` **声明顺序**，每套 pre-composed combo 一页（跳过 `base`/空套，页 id = combo id）；
   4.0 combo 页预算 = **5**（现有 4 套 + 新增日常通勤 1 套，白衬衫+藏青及膝裙作为一套组合资产出一页）；
3. accessory 页：按 registry `pageGroups` **声明顺序**（= 首屏补齐优先级：shoes→socks→necklace→earring→headwear→handheld），
   仅非空页组各一页，页 id = 页组 id；
4. 页文件 = `pageFiles[已发出页计数]`（`atlas.webp` / `atlas-{i+1}.webp`）；每页非空、每个 drawable 恰好一页；
5. 4.0 容量用满 12 页（`1 base + 5 combo + 6 accessory`），**无空闲/预留页**；裤装属 `bottom` 槽位/preset
   组合，不新增页组；4.1 批量穿搭/更多 combo 需扩 `maxPages`（另立 ADR）。

| 方案 | 做法 | 结论 |
|---|---|---|
| **A（采用）** | base + 每 pre-composed outfit combo 一页 + 每配饰类别一页 | ✅ 语义清晰、切装按需加载、渲染顺序与页无关；页数 1+5+6=12（4.0 用满）；首屏可按需选页 |
| B（否） | base + 4 outfit 页 + 全部配饰合并 1 页 | ❌ 配饰页随配饰数量膨胀；首屏可能被迫整页拉取；单页更早撞 4096 上限 |
| C（否） | 按当前造型动态打包页 | ❌ 构建期无法穷举组合，缓存/确定性不可行（3.2.0 已用此思路做单套装页，但 4.0 需要配饰独立页） |

**选择 A 的关键收益（4.0 口径）**：配饰页可按首屏预算/首屏补齐优先级独立调度（§7）；2x 时可按页独立升降，
hi 显存/请求数可控；未来加配饰类别 = 加页组，不加「合并页」逻辑。

**为什么不做上衣×下装交叉组合页（Lead 2026-11-27 裁决）**：① 交叉组合 = top×bottom 的组合爆炸，会瞬间挤爆
12 页预算（4 top × 4 bottom = 16 页起）；② 4.0 的「日常通勤」是 wardrobe 的 pre-composed 套装口径（白衬衫+
藏青裙作为一套组合资产出一页），水手运动复用现有 `sailor-plaid` combo 页 + 新配饰，**无需**交叉页；
③ 任意混搭在运行期用「当前造型各槽位 drawable 所属页的并集」即可渲染（泛化后的 `collectLookAtlasIndices`
天然支持；Phase 0 运行期原型证据 B 已验合成 6 页 rig 选全 `[0..5]`、不做交叉页也能多页并集加载）。

**风险**：页数 = 1 + pre-composed combo 页数 + 非空配饰页组数。4.0 = **1+5+6 = 12 = `maxPages`（用满、无空闲页）**；
4.1 批量穿搭/更多 combo 需先扩 `maxPages`（另立 ADR，并重估显存/设备门槛）。页数多导致请求数升（12 页 vs 5 页），
但 lazy 首屏只拉 base+当前造型页，其余 220ms 后空闲预取。

## 4. ADR-003：上限 12 与容量守恒

**决策**：`maxPages=12`；`MAX_ATLASES`/`MAX_PAGES` 3.3.0 同步 6→12；**容量公式**：
`1(base) + ≤5(pre-composed combo 页) + ≤6(accessory 页组) = 12 = maxPages`。4.0 正好用满 12 页，
`reservedPages` 为空（裤装是 `bottom` 槽位/preset 组合，不新增页组）；4.1 批量穿搭/更多 combo 需扩
`maxPages`（另立 ADR）。

**理由**：① 方案 A 含 4.0 新增 1 套日常通勤 combo 后全开 = 12 页，正好用满；② WebGL 无硬页数限制，页数只影响
请求数/预取/显存，12 页在显存可估（§6）与请求数（首屏 4–6 页）之间平衡；③ 单页仍 ≤4096×4096
（`MAX_WIDTH`/`MAX_SIDE` 不变）；④ 不生成交叉组合页（§3）→ combo 页预算 5 足够覆盖 pre-composed 套装。

**实施边界**：上限提升必须与 `tests/cutout-runtime.test.mjs:146` 断言、`build-2d5-multi-atlas.test.mjs` 7 页失败用例
**同批**改，否则 3.3.0 必红（硬编码清单 §1 第 7/11 项）。当前 Phase 0 代码仍 6，`tests/slot-registry.test.mjs`
用范围断言（官网页数 ≤ cap ≤ maxPages）保持新旧都绿，3.3.0 再升级为相等校验。

## 5. ADR-004：z 表与锚定方式

**决策**：z 表见 [SLOT-REGISTRY.md §2](SLOT-REGISTRY.md)（配饰 z 为用户 2026-11-27 已批准值：
socks 18 / shoes 20 / necklace 64.5 / handheld 66 / earring 68 / headwear 72；服装 `bottom 30` / `topBody 64`；
legacy z 只作文档/新资产契约）。锚定：

- **配饰 = socket 骨骼锚定**：`parentBoneMatrix × localOffset`，每帧骨骼更新后计算；不烘焙蒙皮。
  - `mirror:true` + 2 socket（鞋 footL/footR、袜 shinL/shinR）= **pair**：资产一侧、运行时镜像出另一侧；
  - `mirror:true` + 1 socket（耳饰 head）= **symmetry**：绕锚点 X 轴镜像对偶；
  - 单 socket 无 mirror（项链 chest / 头饰 head / 手持 handR）= 单实例。
- **服装 = seat 蒙皮锚定**：继续用现有整层 mesh + LBS 权重（v3 已烘焙），registry `seat` 只做语义/适配校验，
  不新增运行时绑定路径。

**Phase 0 spike 补充（耳鳍左右不对称）**：真实耳鳍/头部美术轮廓左右不完全对称（chibi 耳鳍下方轮廓最大 Δ≈27px、
耳翼尖 Δx≈8px/Δy≈14px；girl 同区 ~9–11px；纯镜像变换误差 0px），纯 symmetry 单 offset 镜像会让一侧耳饰偏离。
因此 **symmetry 配饰允许资产元数据按侧覆盖锚点**
（`rig.items.<id>.anchor = { socket, offsetL, offsetR, geometryFrame:"canvas" }`；几何仍单侧、由运行时镜像，
位置按侧取；**offset 为 socket 骨局部 px**（`world = base + R(angle)·offset`），canvas pivot 换算
`offset = R(−angle)·(pivot−base)`，见 SLOT-REGISTRY §3.1），registry 的 `mirror`/socket 声明不变。
证据见 §9.3 与 `.scratch/p0-slot-spike/REPORT.md` / `out/RESULTS.md`。

**理由**：① 配饰（<18px 耳饰、鞋袜、项链）不需要蒙皮，socket 绑定实现最小、可复用现有 collider 绑骨几何思路；
② 服装整层已稳定（v3.0 起）且 z 由资产烘焙，4.0 不重做权重；③ 两种 mirror 模式覆盖已批准 6 个配饰槽的全部形态，
资产只需单侧，省美术量；④ 全局唯一 z + 硬关系（`headwear > hairFront 70`、`handheld > hand 65`、
`necklace > topBody 64`、`socks < shoes < bottom`）在契约测试里锁死，避免运行期偷偷改层级。

**后果/边界**：旧 rig 渲染层级以 `drawable.z` 为准，registry z **不反改旧资产**；legacy 槽 z 仅文档契约
（历史对齐：collar56/sleeveUpper60/sleeveFore62/bottom30 = 2.5D-RUNTIME §6.5；topUnder 历史 20 与 shoes=20 冲突取 20.5；
topBody cutout 40 → v3 整层 64；sleeve 取 50）。配饰锚点局部偏移属资产元数据（未来 `rig.items.anchor`），
Phase 2 门禁校验合理范围（耳饰单侧 ≤18px、项链落锁骨、鞋袜贴轮廓、头饰不遮眼）。

## 6. ADR-005：服装/配饰 2x 与设备门槛（Phase 0 定稿）

**已批准口径（不得改）**：服装/配饰 2x = 4.0 硬需求（D-005）；hi 显存预算重估上限 ~90–110MiB；
设备门槛/降级策略 Phase 0 定；D-008 真机不做（wontfix，headless SwANGLE 为准，发布措辞保留「未真机验证」）。

**hi 显存估算**（基于 v3.2.1 hi build-report 页面像素；详见 SLOT-REGISTRY.md §7.2）：
base 2x ~38MiB + outfit 2x×4 ~16–18MiB + accessory 2x×6 ~8–14MiB ≈ raw 62–70MiB → ×4/3 mipmap + 打包/驱动余量
≈ **90–110MiB**（已批准预算）。硬门禁：单页 ≤4096²；hi 全页驻留估算 >110MiB → 构建失败/裁剪配饰页。

**设备门槛提案**（Phase 2 实现，Phase 3 headless 校准；详见 SLOT-REGISTRY.md §7.3）：

| 档位 | 资产 | 预算 | 条件 |
|---|---|---:|---|
| `hi-full` | base+outfit+accessory 全 2x | ~90–110MiB | DPR≥2 且 MAX_TEXTURE_SIZE≥4096 且 **deviceMemory≥8 且 cores≥8**（现行「任一满足」不适用于 hi-full）且非 saveData |
| `hi-base` | base 2x + 服装/配饰 1x（= v3.2.1 hi） | ~55–60MiB | 现有门槛：DPR≥2 且（deviceMemory≥4 或 cores≥4）且 MAX_TEXTURE_SIZE≥4096；deviceMemory 不可用（Safari/iPadOS）只到 hi-base |
| `lo` | 全 1x | ~15–18MiB | 其余/未知 |

运行期降级触发：显存超预算、MAX_TEXTURE_SIZE 不足、context lost、后台内存压力 → 降一档并保留造型；
首帧仍沿用 v3.1.0「lo 先出帧 → hi 后台热切换」，4.0 hi-full 的 2x 页在 lo 首帧后再切。

## 7. ADR-006：首屏预算 ≤1.2MB + 首帧后 200ms 补齐 + 淡入（用户已批准口径）

**决策**：默认造型（日常通勤：白衬衫+藏青及膝裙+乐福鞋+白短袜+珍珠耳钉+细项链）lo 首屏 payload
**≤1.2MB = 1,200,000B（十进制硬门禁，≈1.14MiB；不得按 1.2MiB 放宽）**。参照基线：现有 chibi 默认 maid
首屏 ≈0.96MiB（1,009,691B）。
首屏页集合 = `base` + **当前造型各槽位 drawable 所属页的并集**（combo 页 + 非空配饰槽的页组页）：
4.0 默认造型 = base + commute combo 页 + `shoes/socks/necklace/earring` 4 个配饰组页；`shoes`/`socks` 必须进
首屏（不得裸脚），且至少一件配饰（默认含项链+耳钉）在首帧；配饰页按 `accessoryPriority` 加载，缺页允许
**首帧呈现后 ≤200ms 补齐 + 200ms 淡入**（水手运动的发带/手持同理）。

**关键实现约束（用户原话口径）**：首帧不得出现裸脚/无配饰画面 —— 用「**后补 + 淡入**」而不是「**先裸再补**」：
配饰页未就绪时允许延迟呈现（加载态/上一造型帧），不得先画裸脚再弹配饰；切装缺页仍走 v3.2.0「保留旧造型，补页后自动应用」。
超预算降级顺序：`handheld → headwear → earring` 移到 200ms 后补；`shoes/socks/necklace` 不得移出。`prefers-reduced-motion` 不做淡入。

**测算（Lead 2026-11-27 实测口径）**：当前 chibi 默认 maid 首帧 = base 674,382B + maid 199,592B +
`rig.bin.br` 135,717B ≈ **0.96MiB**；4.0 默认造型 = base + 1 combo 页（新 combo 页约同量级）+ 4 个默认配饰组页
（鞋/袜/耳饰/项链，矢量页预计每页几 KB–几十 KB）+ rig → **预计 ≈1.0MiB（1,048,576B）≤ 1,200,000B ✓**。
Phase 1 出资产后按同口径
实测；超出即按降级顺序（先把 `handheld/headwear` 移出首屏）或资产矢量压缩返工（预算为硬门禁）。

## 8. ADR-007：兼容、迁移与回滚

- **旧 rig（v3.2.1 / 旧单页 / v2.2–2.7 cutout）**：无 `slots2`/`items`/registry 时走 **v3 行为**（OUTFIT_SLOTS +
  `rig.outfits` + `rig.slots`；配饰槽空）；不删任何现有导出/字段（`OUTFIT_SLOTS`/`MAX_ATLASES`/
  `collectLookAtlasIndices`/`getState().look.slots` 旧 4 键语义）。
- **官方 5 页逐字节不变**：3.3.0 分组泛化对当前 4 个 rig（chibi/girl × lo/hi）必须页 id/file/顺序/逐 drawable 归属
  与现实现完全一致（原型已证，见 §验证证据）。
- **存档**：`normalizeState` 新增 `accessories`（缺省 `{}`；未知槽/未知 item → null + warning，不抛错、不丢其它字段）；
  旧存档不写回不报错；配饰与套装正交；4.0 前版本读到新字段会忽略 → 回滚安全（详见 SLOT-REGISTRY.md §6）。
- **DIY pack**：旧 pack 槽位/别名/auto-pair 全不变；新配饰 pack 只允许 registry `kind=accessory` 槽位，z/socket/mirror
  由 registry 决定，pack 不得覆盖（详见 SLOT-REGISTRY.md §8）。
- **回滚**：3.3.0 的页面泛化是纯读契约 + 同输出重构，可单 PR revert，无数据迁移；4.0 配饰功能失败时
  `accessories` 置空即回 v3 观感（旧版本忽略字段）。

## 9. 验证证据（Phase 0 原型，`.scratch/` 不进 git、不改 tracked 文件）

### 9.1 运行期原型：`.scratch/phase0-prototype/runtime/`（`EVIDENCE.md` + `run.mjs`，**26/26 断言 PASS**）

- **真实官方 rig 一致性（最关键）**：chibi/girl 各 9 个真实 look 状态（4 套装 + 3 上衣×下装组合 + 默认 + bare）上，
  原型与 tracked `collectLookAtlasIndices` 页选择**逐项一致**：maid→[0,1]、hoodie-plaid→[0,2]、
  hoodie-pleated→[0,3]、sailor-plaid→[0,4]、bare→[0] ⇒ 泛化对线上 5 页行为**零变化**。
- **现状缺口**：合成 6 页 rig（base+outfit+4 配饰页）时现实现只选 `[0,1]`（只遍历 OUTFIT_SLOTS，**漏 2,3,4,5**），
  原型选全 `[0..5]`；单值/数组槽位、未知 id、空 look、DIY 跳过均正确。该「页并集」行为正是 ADR-002
  「不生成上衣×下装交叉组合页、任意混搭运行期多页加载」成立的依据。
- **上限**：合成 12 页 rig 通过、13 页报 `too_many_atlases`；全槽位 look 恰好选满 `[0..11]`；
  今日 tracked `MAX_ATLASES=6` 对 12 页仍报错 → 3.3.0 必须同步提升。
- **prefetch**：真实 dist 上「从 `rig.json.atlases[]` 派生」清单与现硬编码**逐项一致**
  （lo=rig.bin+5 页 / hi=rig.bin+atlas.webp）；合成 7/12 页正确派生；缺 rig.json 回退旧清单（兼容静态托管）。
- **3.3.0 联动项（运行期原型发现）**：`tests/cutout-runtime.test.mjs:146` 的 `assert.equal(MAX_ATLASES, 6)`
  必须同批改 12，否则上限提升即红。

### 9.2 构建期原型：`.scratch/phase0-prototype/build/`（`atlas_pages.py` + `evidence-run.log`，**121/121 断言 PASS**，Lead 裁决后已重跑）

- **零变化**：registry 模式与「无 registry 回退模式」对 4 个 rig（chibi/girl × lo/hi）产出的页分组
  与现有 `build_prod.build_atlas_pages` **JSON 逐字节一致**（pages sha256 相同；每页 drawable 数/归属一致）；
  官方 4 个 rig 的页表/逐 drawable 归属与现网 `build-report`/`rig` 完全一致（5 页，sha 不变）⇒ `atlasPages`
  输入不变 ⇒ **官方 dist 字节不变**（推导，未重建；最终由 `verify:full` 实测确认）。
- **泛化（新口径）**：synthetic rig 覆盖 outfit 页按声明序（sailor 先于 maid、跳过空 base）、accessory 页按
  `pageGroups` 顺序（shoes→socks→…，空页组不占页）、文件名连续 `atlas.webp/atlas-2…`；**C14**：5 个
  pre-composed combo 页（= `outfitPageBudget 5`）通过、**C14b**：6 个 → `outfitPageBudget` 硬错；
  **C16**：4.0 容量恰好用满 12 页通过（1 base + 5 combo + 6 accessory 组 = `maxPages=12`、`reservedPages=[]`，
  页序 base→5 combo→shoes/socks/necklace/earring/headwear/handheld，`atlas.webp…atlas-12.webp`）；
  13 页仍按 `上限 12` 失败。
- **registry 校验**（3.3.0 可直接落地的错误面）：`format` 非法、`pageFiles` 命名不合法、`maxPages` 与
  `build_2d5.MAX_PAGES` 不同步、accessory slot 的 `pageGroup` 未声明、`drawable.slot` 未在 registry 声明、
  同一 drawable 被两个 outfit 引用、combo 页数超 `outfitPageBudget`（C14b）、容量超限（**C15**：新口径
  `1+5+13+0 = 19 > 12` → registry 容量报错）、`crossCombinationPages=false` 语义落实为「outfit 页 id 恒 ⊆
  `rig.outfits` 声明的 pre-composed combo（不建交叉组合页）」→ 全部按退出码 1 拒绝。
- **C18 真实 registry 对拍**：真实 `slot-registry.json` 与 fixture 输出一致（含容量满额 rig），4/4 PASS；
  原型已按 Lead 2026-11-27 裁决同步 fixture（旧「内容上限 11 / atlas-12 预留」用例删除）。
- **hi**：hi tier 复用同一 `build_atlas_pages`，页 id/file/顺序/归属与 lo 一致。

### 9.3 假耳饰 spike：socket 锚定 + mirror + lazy 页选择（`.scratch/p0-slot-spike/`，**35/35 断言 PASS**）

> 独立 spike（不改 tracked 文件、不 commit）：`spike.py` 可复跑；产物 `METRICS.json` / `REPORT.md` /
> `earring-preview-chibi.png` / `dist/chibi/`（由 `tools/art/build_2d5.py` 真实构建的 6 页图集）。

- **socket 数学（语义已澄清）**：`anchor.offset` = **socket 骨局部 px**，`world = base + R(angle)·offset`；
  几何 `geometryFrame:"canvas"`（全画布层 canvas 坐标作者化、运行时绕锚点旋转），canvas pivot 与骨局部 offset
  严格换算往返 0px；`parentBoneMatrix(base+angle) × localOffset` 往返误差 0px；与运行时顶点着色器
  LBS/headWarp **同式误差 0px**（head roll/yaw/pitch ±25° 下 socket 相对脸锚点漂移 0px）；真实 rig socket 骨
  `head/chest/handR/footL/footR/shinL/shinR` 在 chibi/girl 均存在；耳饰 18×22（宽 ≤18px）左右锚点
  完全落在 body-head alpha 内、眼/眉遮挡 0px、刘海覆盖 ≤2%。独立验证：`.scratch/p0-slot-spike/out/RESULTS.md`
  （run.mjs，硬断言全 PASS）。
- **真实构建**：假珍珠耳饰 drawable（12×12，肤色像素取自 `body-head`）+ 第 6 页 `earring` → `build_2d5.py`
  成功产出 6 页（base+4 outfit+earring，每页非空、pixelEqual True、UV/atlasRect 正确），**当前 6 页上限即可容纳**。
- **页选择缺口实测**：look 含配饰槽时参考泛化实现选 `[0,1,5]`，当前 v3.2.1 tracked 只选 `[0,1]`（漏配饰页）；
  跨 combo 混搭 `[0,1,2]` = 页并集（验证 ADR-002「不生成交叉组合页」成立）；旧单图集 rig 回退 `[0]`。
- **发现并处置**：① 耳鳍左右美术不对称（chibi Δx=27px）→ symmetry 配饰需 per-side anchor（§5，Phase 2 落地）；
  ② 耳饰 z68 < hairFront z70，但实测 bangs 在耳鳍/耳翼锚点区域 alpha 覆盖 ≤2% → 可见性可用，Phase 1 需把耳饰
  画在「耳鳍底缘外侧露出带」，Phase 3 门禁加「bangs 高覆盖区禁止放耳饰」像素断言；③ GL socket 绑定/逐帧矩阵
  尚未实现（Phase 2 范围），本 spike 验证数学/构建/页选择层，GL 行为需 Phase 2 视觉门禁补验。

## 10. 3.3.0 实施计划（本 ADR 范围：只做页泛化，不做配饰资产）

**前置**：本 ADR + registry 定稿；资产包/构建环境不变（`.cache/assets-src` 已在）。

| 步 | 工作 | 文件 | 估计 |
|---|---|---|---|
| 1 | 构建侧读 registry：`build_atlas_pages` 数据驱动 + 校验面（页组/槽位/预算/容量/pageFiles）+ registry 缺失回退；`MAX_PAGES=12` | `tools/art/build_prod.py`、`tools/art/build_2d5.py` | 0.5d |
| 2 | 运行期 `MAX_ATLASES=12` + `collectLookAtlasIndices` 泛化（遍历全部槽位/atlasIndex/legacy 回退）；`tierLoadPlan`/注释口径 | `docs/dress-up/runtime-2d5-core.js`、`runtime-2d5.js` | 0.5d |
| 3 | prefetch 清单数据驱动 + 回退 | `lib/webserver.js` | 0.5d |
| 4 | 测试同步：`cutout-runtime` 断言改 12；`build-2d5-multi-atlas` 改 13 页失败/12 通过 + synthetic outfit+accessory；`runtime-2d5-core`/`dressup-client-config`/`dressup-2d5-assets`/`asset-build` 保留官方 5 页显式回归 + 泛化用例；`slot-registry.test.mjs` cap 断言升级为 `=== maxPages` | `tests/*.test.mjs` | 0.5d |
| 5 | 验证：官方 5 页逐字节不变（`verify:full` + `FEIYU_ASSET_VERIFY_DIST=1`）+ `npm test`/`typecheck` | 命令 | 0.5d |

**合计 ≈ 2 人日**（与运行期原型 EVIDENCE 估算一致：运行时 0.5d + 测试 0.5d + 构建 0.5d + verify/回归 0.5d）。
不升资产版本（资产 v26 不变）、不发 npm 版本；官方 dist 逐字节不变是**硬验收**。若 3.3.0 还要按 PLAN §10 加
「1 新上衣/下装 + 鞋槽」资产，另计美术/管线 ~1 周，不在本 ADR 范围。

**验收标准（3.3.0）**：
1. `npm run typecheck` 0 error；`npm test` 0 fail；`npm run verify:full` 通过。
2. 官方 4 个 rig 的 `rig.json`/`rig.bin`/全部页 md5 与 v3.2.1 逐字节一致（`FEIYU_ASSET_VERIFY_DIST=1`）。
3. `collectLookAtlasIndices` 在 9 个真实 look 状态上与 v3.2.1 输出逐项一致（原型 A 组用例落成 tracked 测试）。
4. synthetic ≥7 页/配饰页：页选择、页序/文件名、每 drawable 恰一页、12 页上限、13 页失败、旧 rig/单图集回退。
5. `MAX_ATLASES`/`MAX_PAGES` = 12 = registry `maxPages`（`tests/slot-registry.test.mjs` 相等断言）；
   官方 4 套 + 4.0 新增 1 套 = 5 个 combo 页，cross-combination 页数 = 0（构建不生成）。
6. 无 tracked 行为变化（页面/资产版本不升），可按单 PR 回滚。

## 11. 未决 / 风险

| # | 风险 | 处置 |
|---|---|---|
| 1 | **4.0 用满 12 页（1 base + 5 combo + 6 accessory），无空闲页**；4.1 批量穿搭/更多 combo 会超限 | 4.1 前另立 ADR 扩 `maxPages` 并重估显存/设备门槛；不生成交叉组合页（§3）；registry 容量公式 + 构建校验兜底（§4） |
| 2 | hi 2x 显存 90–110MiB 是**估算**（headless 页面像素 + mipmap + 余量），真机不可测（D-008 wontfix） | Phase 3 headless `getMemory()`/`qa:load` 实测校准；超 110MiB → 裁剪/合并配饰页或提高设备门槛；发布保留「未真机验证」 |
| 3 | 首屏 1.2MB（1,200,000B 十进制硬门禁）预算依赖 Phase 1 资产体积（新 combo 页 + 配饰页） | Phase 1 出资产立即实测；超出按 §7 降级顺序（handheld→headwear→earring 后补）或资产矢量压缩返工 |
| 4 | `MAX_ATLASES` 6→12 与 `tests/cutout-runtime.test.mjs:146` 断言联动 | 3.3.0 同批修改（§1-10），避免红；已登记 |
| 5 | 配饰页依赖构建侧「每页非空、每 drawable 恰一页」断言；registry 与 rig 声明不一致会空页请求 | 构建期硬失败（原型 C8/C9 已证）；`tests/slot-registry.test.mjs` 锁声明完整性 |
| 6 | z 表/锚点在 4.0 Phase 2 实装时的穿模/遮挡未知 | Phase 2 视觉门禁（ear/necklace/wrist/shoes/hem 区域 + garment-hygiene 像素断言）；头饰不遮眼、项链不盖颈（D-017） |
| 7 | **耳鳍左右美术不对称**（chibi 耳鳍底缘 Δx=27px；spike 已量测）→ 纯 symmetry 镜像会让一侧耳饰悬空 | symmetry 配饰允许 `item.anchor.offsetL/offsetR` 按侧覆盖（Phase 2）；Phase 1 美术出耳饰时同时给左右 anchor；Phase 3 ear 区域 2x crop 目检 |
| 8 | 配饰可见性依赖「耳鳍底缘/侧发末端」露出带，bangs 覆盖区不可放置 | Phase 1 美术锁定露出带；Phase 3 门禁：耳饰 rect 内 bangs alpha 覆盖率 >50% 即失败（spike 实测锚点区域 0%） |

## 附：参考

- 契约：[SLOT-REGISTRY.md](SLOT-REGISTRY.md) · JSON：[`slot-registry.json`](slot-registry.json) · 测试：`tests/slot-registry.test.mjs`
- 计划：[PLAN-4.0-SLOTS.md](../PLAN-4.0-SLOTS.md) §3/§4/§6/§9/§10/§11
- 运行期原型证据：`.scratch/phase0-prototype/runtime/EVIDENCE.md`（26/26 PASS）
- 构建期原型证据：`.scratch/phase0-prototype/build/evidence-run.log`（121/121 PASS，Lead 裁决后重跑）
- 现行运行期口径：[2.5D-RUNTIME.md](2.5D-RUNTIME.md) §2/§6.5；构建口径：[tools/art/README.md](../../tools/art/README.md)
