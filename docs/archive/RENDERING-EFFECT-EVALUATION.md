> **📦 已归档（W0，2026-11-05）**：本文为历史文档，内容反映当时版本，不再维护；归档原因与现行替代文档见 [`docs/archive/README.md`](./README.md)。

# 换装间「效果上限」技术方案评估

> 触发：用户叫停当前实现改动，明确目标是**实现效果的上限**（不是低成本快速修补），要求先做技术方案评估。
> 本文只做评估与路线建议，不含实现代码。基线：v0.9「7 槽位纸娃娃」修好遮挡正确性后停在 `feat/layer-v6` 分支（未发版）。

---

## 0. 结论先行（TL;DR）

1. **「效果上限」不在渲染器，在「美术拆件/补画 + 绑定 + 动效设计」**。同一个渲染器，素材是"烘焙了遮挡的平面图"就只能做出静态纸娃娃；素材是"完整可动部件"才能做出 Live2D 级看板娘。
2. **本项目最合适的效果目标是 T2 档：2.5D 骨骼/网格看板娘**（保留现有 AI 插画风格，可眨眼/呼吸/转头/发丝裙摆物理/换装过渡/摸头反馈）。**不建议现在上 3D**：3D 的上限更高，但要把美术全部重做成 3D 资产（包体 +15–40MB、双身形×6 套衣服建模绑定、画风漂移），成本高一个数量级，且丢掉 Seedream 插画这一产品身份。
3. **推荐主路线：自研轻量 WebGL2 2.5D runtime（PixiJS v8 Mesh 或等价实现）+「共享骨架 + 服装部件」换装模型 + 拆件补画资产管线**。理由：MIT/离线/零许可风险，复用现有画风，运行时能力可达 Live2D 的约 9 成、最终观感手工调优 7–8 成（全自动 4–5 成）。
4. **备选/对照路线（许可核实后修正）**：
   - **纯 MIT 项目不能打包官方 Live2D Core/Framework**（Core 是专有 Redistributable Code，Live2D 协议明确把 MIT 列为 excluded license；Framework 是 Live2D Open Software License）——官方 Live2D 只能选「放弃纯 MIT」，或走「MIT 加载器 + 用户自备 Core」「复合许可包」等折中；
   - **Inochi2D（BSD-2）许可干净，但官方没有可用的 web runtime**：SDK 有 WASM 构建配置/预编译库，但无官方 JS runtime；第三方 `inochi2d-ts`（2023 停更）、`inox2d`（Rust WASM/WebGL 原型，缺动画/MeshGroup，官方称 prototype）都不达生产——选它 ≈ 自建 WASM runtime（+4–8 人周）；
   - **值得新增的候选：Purism Core**（MIT 的 clean-room Live2D Core 重实现，WASM viewer 可用，v1.1.0 2026-08；自称无需 Live2D 授权，**法律未证实**）——若成立，可「用 Live2D 资产 + MIT runtime」把效果上限推到约 9/10，但需 1 周技术 PoC + 法律评估；
   - **Iki**（MIT、WebGL2、`.iki` JSON、AI auto-rig）仍是"AI 生成角色"路线里最贴合的开源 runtime，但 0.x 早期；
   - 其余：Spine（runtime 需 Spine Editor 许可，$379 PRO，MIT 不成立）、DragonBones（runtime MIT 但编辑器停更/工具链死亡）、E-mote（闭源、企业 30 万日元/年/平台）——仅作参考/排除。
5. **建议下一步做 4–6 周 POC**：少女版 × 1 套衣服，约 22 层完整部件，跑通呼吸/眨眼/视线/转头 ±15°/发丝/裙摆/换装过渡，并与 Live2D/开源方案做同素材对照，再决定全量路线。

---

## 1. 「效果上限」到底是什么：四档目标

| 档位 | 能力 | 代表产品 | 对本项目 |
|---|---|---|---|
| **T0 静态纸娃娃** | 固定站姿、按 z 序叠图；只有整层位移/缩放动画 | QQ秀（Flash 时代）、4399 换装、暖暖环游世界、Picrew、**当前 v0.9** | 只解决"穿对"，人物是"静态立绘" |
| **T1 分层 + 轻动效** | 呼吸、眨眼（贴图切换）、视差、点头、刚体摆动；无网格形变、无体积感 | 早期"伪 Live2D"微件、Anime2.5DRig 的深视差 demo | 2–4 人周，能"活一点"，但一转头就平 |
| **T2 2.5D 骨骼/网格（推荐目标）** | 网格蒙皮形变 + 参数/状态机：±15–20° 转头、眨眼、口型、视线跟随、发丝/裙摆弹簧物理、换装过渡、表情与触摸反馈 | Live2D 看板娘（碧蓝航线/少女前线）、厘米秀 2D（Spine）、奇迹暖暖特殊套装 | 6–10 人周出 POC；**近景"养女儿"体感的上限档** |
| **T3 全 3D** | 全角度、真布料近似、动态光影、全身动作、自由镜头 | 闪耀暖暖（Unity 定制，3 年美术、包体 2GB+）、超级QQ秀（UE4） | 上限最高，但要重做全部美术；本项目不做主路径 |

**结论**：用户说"追求实现效果的上限"，落到本项目最合理的是 **T2**；T3 是另一个量级的产品决策。

---

## 2. 业界是怎么做的（经典网页换装 → 现代）

### 2.1 经典网页换装 = 2D 分层 sprite 纸娃娃

- **QQ秀（2003）**：Flash 时代，客户端按层叠图、服务端存形象配置（"配置码"记录每层图），z 序按部位固定（下装→上装→发型→帽子）。移动端不是直接迁移而是重做：**厘米秀 2D 官方用 Spine**——基础骨架 `role.json` + 装扮 `dress.json`，按 FaceSuit/HairType/TopSuit/BottomSuit 等 **slot 装配，装扮是 skinnedmesh，运行时动态加载**；2022 超级QQ秀转 3D（UE4）。
- **4399/7k7k**：Flash AS3 + MovieClip 分层，衣服/身体独立元件，按 layerIndex/z 序与注册点对齐，时间轴补间做淡入滑动；`cacheAsBitmap` 缓存。Flash 停用后迁 H5/Canvas/WebGL（Laya/Egret/Cocos），老内容靠 Ruffle。
- **暖暖环游世界**：拆包是每件衣服带偏移的 PNG（`part` 1–2 张、身体图集分开），固定站姿按部位叠图，无骨骼。
- **奇迹暖暖**：主换装仍是 2D 分层纸娃娃；**特殊套装用 Live2D**（集齐部件才动、可随点击变化）。
- **Picrew / Pony Town**：分层 PNG + 位移/缩放/旋转/换色（Picrew），或 HTML5 像素 avatar 社交（Pony Town）。

**启示**：经典"网页换装小游戏"的技术本质就是我们现在这套 T0 纸娃娃；它的效果上限就是"漂亮的静态立绘"。

### 2.2 效果拐点：2D 骨骼/网格（T2）

- **厘米秀 2D（Spine）**：共享基础骨架 + 装扮 skinnedmesh 挂载 —— 这是"换装 + 骨骼"的成熟产品化形态，正好可作为我们"共享骨架 + 服装 attachment"的参照。
- **Live2D**：PSD 分层 → ArtMesh → 变形器/参数/物理；日本 galgame、VTube、国产二次元看板娘主流方案；Web SDK 可离线跑。
- **E-mote**：拖拽部件 + 物理（刚度/重量/弹跳/风），galgame 常用，效果接近 Live2D。
- **Inochi2D / Iki / Rev2D**：开源/开放格式的 Live2D 替代（见 §3）。

### 2.3 真 3D（T3）的代价（闪耀暖暖复盘，2019）

- 初期曾尝试 **基于 Spine 做 360° 旋转**，很快放弃转 3D；
- Unity 定制：多层 UV/多层贴图（渲染 +26%）、程序化材质/闪点、自定义光照/阴影、链式质点布料 + 胶囊/网格碰撞 + RBF 修形、每套衣服挂点/部件组合；
- 包体 2GB+（3D 占一半，贴图又占 3D 一半）；移动端无法全布料模拟，只能近似；
- **3 年美术制作周期**。

**启示**：3D 换装的上限确实最高，但它是"重做产品"的量级，不是给现有 2D AI 插画"加个引擎"。

---

## 3. 候选技术方案对比

| 方案 | 效果上限 | 许可/开源兼容 | 离线/包体 | 工程/美术成本 | 主要风险 | 结论 |
|---|---|---|---|---|---|---|
| **A. 自研 WebGL2 2.5D**（PixiJS v8 Mesh + 自建骨骼/权重/物理/mask/表情/状态机） | 运行时 ≈ Live2D 90%；观感 70–80%（人工调优）/40–50%（全自动） | **MIT 干净**（PixiJS MIT、自研代码 MIT） | 纯离线；图集 2–3 张 2048²，显存 50MB 级、包体 +1–3MB | runtime 4–8k 行 TS；POC 4–6 周；全量 2–3 个月（含美术 QA） | 拆件质量、权重鬼影、每套衣服工时（数小时起）、自研编辑器范围失控 | **推荐主路线** |
| **B. Live2D 官方 Cubism** | **最高**（商业看板娘标准，10/10；呼吸/眨眼/口型/物理/表情/5.3 blend+offscreen） | ❌ **MIT 项目不可打包**：Core 是专有 Redistributable Code（只允许原样随衍生作品分发），MIT 被 Live2D 协议列为 excluded license；Framework 是 Live2D Open Software License（非 MIT/Apache/BSD）。个人/小规模（年销<1000 万日元）免发行许可但**不能 MIT 再许可**；Expandable App 需预批 | Web SDK 可离线；Core 207KB（61KB gzip） | 集成 1–2 人周 + 绑定 3–6 人周；Editor FREE 限制（1 张 2048 贴图/100 ArtMesh/30 参数/50 变形器/30 部件）→ 双身形×6 套需 **PRO 付费**；可用 [live2d-agent-kit] 的 AI-agent 流程辅助 | 许可/合规是硬阻断；PRO 订阅；人工绑定质量决定观感 | **纯 MIT 下排除；仅当愿放弃纯 MIT** |
| **C1. Purism Core**（MIT clean-room 重实现 Live2D Core） | 若成立 ≈ Live2D 9/10（可播放 Live2D 资产） | ⚠️ MIT（v1.1.0 2026-08，WASM viewer 可用）；**自称无需 Live2D 授权，法律未证实** | 纯离线 | 1 周技术+法律 PoC；资产仍按 Live2D 流程拆件绑定 | 法律风险（clean-room 是否成立未证实）；生态/工具未知 | **高杠杆候选，先 1 周 PoC + 法律评估** |
| **C2. Iki**（`@ikijs/engine`，MIT，`.iki` JSON，WebGL2） | 架构与 Live2D 同构（网格/变形器/物理/mask/表情/动作）；成熟度 0.x，效果未知 | ✅ MIT，无发布许可 | 纯离线 npm 运行时 | 借它的 AI auto-rig 与 MCP 流程；早期项目需自己兜底 | 早期（29★，2026-06 建；npm ~2.9k 下载/月），格式仍可能变，单维护者 | **POC 对比候选** |
| **C3. Inochi2D 0.8**（BSD-2） | 7.5/10（网格/参数/物理/动画齐，打磨与生态落后） | ✅ BSD-2，可随 MIT 分发（留声明） | 纯离线 | **官方无可用 web runtime**：SDK 有 WASM 构建/预编译库但无官方 JS runtime；`inochi2d-ts`（2023 停更）、`inox2d`（Rust WASM/WebGL 原型，缺动画/MeshGroup，官方称 prototype）不达生产 → 选它 ≈ **自建 WASM runtime +4–8 人周**；绑定 Inochi Creator 3–6 人周 | 运行时自建；官方 FAQ 称仍 WIP、不保证游戏生产可用 | **许可干净但 web 端成本高，降级为备选** |
| **C4. Spine 4.3** | 8/10（皮肤换装、物理约束、mesh/IK；头部 2.5D 需手工权重） | ❌ Runtimes License；PRO $379（Essential $69 无 mesh/权重/IK/物理）；作为库分发每个下游需 Editor 授权 | ✅ spine-webgl 251KB/76KB gzip | 绑定 3–5 + 集成 1 人周 | 费用 + 许可；MIT 不成立 | 排除（闭源商业可考虑） |
| **C5. DragonBones / E-mote** | DragonBones 6.5/10；E-mote 9/10（VN 级） | DragonBones runtime MIT 但编辑器停更（官网转商业 LoongBones）；E-mote 闭源、企业 30 万日元/年/平台、WebGL SDK 2018 | — | DragonBones 3–5 人周；E-mote 模板化 1–2 人周 | 工具链死亡 / 许可与费用 | 仅参考 / 排除 |
| **D. 3D（three.js + three-vrm）** | 最高（全角度/布料/光影/动作） | ✅ three-vrm MIT；VRM 生态许可友好 | ❌ 包体 +15–40MB；单角色 5–15MB 常见；VRM BlendShape 会膨胀 | 建模+绑定 2–4 周/角色；每套衣服 2–5 天；双身形近乎翻倍；AI 3D 尚不能产出可换装动漫服装 | 画风漂移、穿模、低端性能、美术重做 | **不做主路径**（触发条件见 §7） |
| **E. 静态微动效（现状+）** | T1 档 | ✅ MIT | +0.2–1MB | 2–4 人周 | 上限低，不满足"上限"目标 | 仅 fallback |

**关键判断**：A/B/C 的运行时能力差距没有想象中大；**决定观感的是"拆件补画 + 绑定调参"质量**。对我们这种 MIT/离线/免费开源项目，**A（自研）+ PixiJS** 是唯一许可零风险的路线；Iki/Inochi2D 可作为 runtime 层面的加速或对照；Live2D 是"如果愿意放弃许可纯度"的最高天花板。

### 3.1 许可事实核实（2026-11，决定性）

**① MIT 项目能合法打包官方 Live2D Core 吗？→ 不能。** Core 是专有 Redistributable Code，只允许作为 `live2dcubismcore.js/.min.js/.d.ts` 原样随衍生作品分发（[RedistributableFiles.txt](https://github.com/Live2D/CubismWebSamples/blob/develop/Core/RedistributableFiles.txt)）；Live2D 专有协议明确把 MIT 列为 excluded license（§5.3.2/§6.8），Framework 又受 Live2D Open Software License 约束（非 MIT/Apache/BSD）。现实折中只有三种：MIT 加载器 + 用户自备 Core（如 [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)，MIT 但 PIXI v6、2024 后停更）、复合许可包（如 [charivo](https://github.com/zeikar/charivo)，整体不再是 MIT）、或 **Purism Core**（法律未证实）。**结论：坚持纯 MIT → 官方 Live2D 路线应排除。**

**② Spine runtime 能作为 MIT 打包吗？→ 不能。** runtime 是 source-available 的 Spine Runtimes License；随产品分发需附许可，开发者需 Editor 授权（PRO $379；Essential $69 无 mesh/权重/IK/物理）；作为库供下游二次开发时每个下游都需 Editor 授权（§2.4）。

**③ Inochi2D 有可用 web runtime 吗？→ 没有官方可用 runtime。** SDK 提供 WASM 构建配置/预编译库（0.9+），但无官方 JS runtime；第三方 `inochi2d-ts`（2023 停更）、`inox2d`（Rust WASM/WebGL 原型，缺动画/MeshGroup，官方称 prototype）不达生产。选 Inochi2D ≈ 自建 WASM runtime（+4–8 人周）。其 FAQ 亦明确项目仍 WIP、不保证游戏生产可用。

> 另：E-mote 闭源（企业 30 万日元/年/平台，WebGL SDK 2018）；DragonBones runtime MIT 但编辑器停更（官网转商业 LoongBones）；SkelForm（编辑器 GPL-3.0 / JS runtime MIT，v0.7）太新——均只作参考或排除。

### 补充：为什么"换 Canvas/WebGL 引擎"不是答案

v0.8→v0.9 的教训已经证明：缺陷根因是素材与遮挡数据（烘焙遮挡、缺部件），不是渲染器。同理，现在要冲效果上限，**正确顺序是：先重做美术资产（完整可动部件）→ 再定绑定/运行时**。

---

## 4. 推荐架构（若走 A：自研 2.5D）

> 参照厘米秀 2D（共享骨架 + 装扮 skinnedmesh）与 Live2D（ArtMesh/变形器/物理）的成熟形态，做一个"够用的轻量实现"。

### 4.1 渲染层

- **单 canvas**（PixiJS v8 + WebGL2；Mesh 支持 Uint32 索引与自定义 shader）：整角色一个画布，DOM 只留 UI/点击热区。跨层遮罩、描边、投影都烘进贴图，不用 CSS filter。
- **图集**：2–3 张 2048²（可走 2× 缩放 + anime upscale），显存 50–100MB 级；低端设备可降 1024²。
- **性能预算**：40–80 mesh、≤5 万三角、1080p 集显 60fps、低端手机 30–60fps；瓶颈在 mask/filter 切换与填充率。

### 4.2 绑定层（2.5D）

- **共享骨架**（chibi/girl 各一套）：root → hips → spine → chest → neck → head，双臂各 2–3 段，腿 2 段；头发/裙摆/袖口/耳鳍/尾巴挂物理链。
- **网格与权重**：alpha 轮廓三角化（marching squares + ear-clipping），关节处加密；权重用"骨段距离 + Laplacian 平滑"或**从模板身形迁移权重**（比 bone heat 更稳）。
- **形态键/变形器**：warp deformer（转头/身体扭动）+ 少量 blendshape（表情）；表情用贴图切换 + 交叉淡化（眼白/虹膜/睫毛/闭眼/眉/口型）。
- **物理**：spring bone（VRM SpringBone 模型）+ 头发 2–3 段/束、裙 6–8 条链 + 腿胶囊碰撞；固定 60Hz 子步；风力参数供"互动/场景"驱动。
- **遮罩**：alpha 蒙版纹理（片元采样，软边、可反相）优于 stencil（mask 数量多会拖慢，PixiJS 官方有性能警告）。

### 4.3 换装层（共享骨架 + slot）

参照厘米秀 2D 的 `role.json + dress.json` 与 v0.9 的 drawOrder 经验：

```
slot: backHair → skirtBack → legs → bottom → torso → top → armBack → armFront
      → neck → head → eyes → brows → mouth → frontHair → accessory
```

- 每套衣服 = **skinned mesh + 物理参数 + drawOrder override + 隐藏的身体补片**；换装 = 替换 slot 内容 + 过渡动画，不重建场景、不重载引擎。
- 双身形 = 两套骨架 + 两套部件；服装按身形各出资产（或让 AI 生成时直接按两身形各来一套）。
- 手臂前/后关系按套配置（Live2D 的 "arm change" 思路），解决"长袖/短袖/无袖"。
- 现有 v0.9 的 body/arms/hair/clothes 分层是很好的起点，但**需要补成"完整部件"**（§5）。

### 4.4 动效/互动层

- **常驻**：呼吸、眨眼（随机 2–5s）、视线跟随（鼠标/注意力）、头部微转/点头、发丝与裙摆惯性、待机小动作（转身、看别处、理头发）。
- **互动**：点击说话（口型+表情+气泡）、摸摸头（眯眼+偏头+头顶物理反馈）、喂食（道具 slot + 吃相）、换装过渡（1–2 帧特效 + 弹入）、心情/亲密度驱动表情与动作集。
- **状态机 + 参数**：Idle/Interact/Emote/DressUp/Bubble 状态；表情与动作可组合；鱼粮经济/亲密度作为解锁与情绪输入。

---

## 5. 真正的瓶颈：美术资产管线（拆件 + 补画）

### 5.1 现状问题

现有素材是 **AI 一次性生成的平面插画**，遮挡关系烘焙在图里：
- 手在衣服前、头发被身体/衣服切断（隐藏部分不存在）；
- 脸（眼/眼睑/嘴/眉）是整张脸，不能眨眼/口型；
- 手臂只到衣服覆盖处，不能"抬手"；衣服被头发盖住的部分没有画。

**这些不补全，任何绑定一动就穿帮。** "拆件 ≠ 绑定"，绑定/补画才是工时大头。

### 5.2 两条资产策略（可混用）

1. **现有立绘 → 拆件+补画**（最快复用现有画风）
   - 拆件：用 [See-through]（SIGGRAPH 2026，Apache-2.0，单图→最多 23 层语义 PSD，含被遮挡区域补画、深度排序；1280 分辨率需 12–16GB 显存，HF ZeroGPU 约 2–3 分钟/张）、SAM2/anime-seg 兜底；
   - 补隐藏区：FLUX.1 Fill / SD inpainting / LaMa，或项目已有 **Seedream 图像编辑**（同会话带参考图减少风格漂移）；只补"会被运动暴露"的区域；
   - 人工修：1–3 天/身形套（接缝、线宽、色差、发丝连贯性）；
   - 业界经验：**AI 平图→分层补图的美术返工约 3–6 人周**，往往高于 runtime 工程——这是所有路线的共同瓶颈。
2. **部件化重新生成**（上限更稳，成本更高）
   - 按部件（眼白/虹膜/眼睑/眉/口/前后发/身体各段/每件衣服）分别生成，保持同一角色参考与风格；
   - 需要角色 Bible + 参考图 + 多轮 QA；一致性风险高但可控；
   - 3D 只出姿态/深度，用 ControlNet 重绘回 2D（可选辅助）。

### 5.3 模板化（决定"新衣服"的单位成本）

- 固定角色骨架 + slot 表 + 权重模板 + 物理参数模板；
- 新衣服流程 = 生成/拆件/补画（数小时）→ 自动权重（模板迁移）→ 物理参数（模板 + 微调）→ drawOrder 配置 → QA；
- **诚实预期**：新衣服从"生成几分钟"变成"每套数小时"；双身形 ×6 套 + 后续更新，这是规模化的真实成本。

### 5.4 参考先例（AI 图 → 可动模型）

- [live2d-agent-kit]：AI 图（ChatGPT Image2.5 生成参考图）→ 30 源层 → psd2live → moc3 → WebGL；示例 41 参数 / 14 动作 / 8 表情 / 14 组物理；**明确说明被遮挡的眼皮、口腔、头发、衣服仍需补画**；代码 MIT/GPL 混合，依赖 Live2D Cubism Core。
- [See-through]：拆件论文/工具，明确"还不是 image-to-Live2D"。
- [Anime2.5DRig]（MIT，WebGL1，约 3k 行）：单图 → 视差/发丝/眨眼/口型的自动绑定参考实现（T1 上限样本）。
- [StretchyStudio]（MIT，523★）：静态插画 → 可网格形变角色的开源工具，可作 runtime/editor 参考。
- [Bunraku]：论文 demo（单图→可驱动 Live2D），**仓库无 license、近乎空仓，不可直接用**；也说明"全自动"在 A-pose/简单服装尚可、复杂组合会层裂。
- 结论：**有先例、无"全自动开源成品"**；我们这种 6 套衣服的量级，人工修 + 半自动完全可行。

---

## 6. 工作量 / 成本 / 风险（估算）

| 阶段 | 内容 | 估算 |
|---|---|---|
| **POC（4–6 周）** | 少女版 × 1 套衣服（约 22 层）：拆件补画 → 共享骨架 + 自动权重 + 手调 → runtime（呼吸/眨眼/视线/转头±15°/发丝/裙摆/换装过渡/表情）→ 性能与观感对照（vs Live2D/开源 demo） | 4–6 人周（含 2–3 天拆件修图）；每周出对比截图/视频 |
| **全量（2–3 个月）** | 双身形 × 6 套 + 互动（摸头/喂食/表情/心情）+ 换装过渡 + 图集/性能优化 + 保底回退 | 2–3 人月（不含请画师/绑定师）；主风险在美术 QA |
| **可选：Live2D 效果基准（仅评估，不发布）** | 同素材做一版 Live2D 模型作为"上限基准"（agent kit 辅助），量化差距；发布仍受许可阻断 | +2–4 周/模型 + PRO 订阅（评估用） |
| **可选：Purism Core 路线 PoC（1 周）** | 用 Purism Core MIT runtime 播放一版 Live2D 资产，验证"纯 MIT runtime + 最高效果资产"是否成立 + 法律评估 | 1 周（技术+法律）；风险：clean-room 合法性未证实 |
| **可选：3D 展示模式** | VRM 角色 + 3 套衣服 + SpringBone + MToon，720p/30fps 验证 | 3–6 人月 + 美术外包（$1k–2k+/角色，双身形翻倍） |

**风险清单（诚实）**：
1. 拆件/补画质量决定观感：AI 自动拆件+全自动绑定只能到 Live2D 商业作约 4–5 成观感；人工修图调参约 7–8 成；**要接近商业天花板需要熟练绑定师**（这可能才是"上限"的真实瓶颈）。
2. 权重鬼影、发根/关节破绽、接缝/线宽漂移、换装时遮挡错误——都需要逐套 QA。
3. 双身形 × 每套衣服成本翻倍；新衣服从分钟级变小时级。
4. 许可：Live2D 需 PRO 与发布许可/Expandable 审查；Spine runtime 要求用户自持 Spine Editor 许可，与 MIT 不兼容；Iki 早期 0.x 有格式变动风险；Inochi2D 生态小。
5. 包体/显存：2–3 张 2048² 图集 + 运行时约 +1–3MB（2D）或 +15–40MB（3D）。
6. 自研编辑器范围失控（POC 只做"够用"，不要做通用工具）。

---

## 7. 建议路线（分阶段 + 决策点）

### 7.1 推荐：先 POC 双轨对照（4–6 周），再全量

- **Track 1（主）**：自研 WebGL2 2.5D（PixiJS v8 + 自建 runtime），素材走"现有立绘 → See-through/Seedream 拆件补画 → 共享骨架/模板权重"。
- **Track 2（对照）**：同素材做一版 **Live2D（live2d-agent-kit 流程，仅作效果基准，不发布）**；另加 **1 周 Purism Core PoC**（MIT runtime 播 Live2D 资产，评估是否可绕过许可阻断）与 **Iki 自动绑定**对照，量化同素材下的观感上限差异。
- 同场景对比：转头 ±15°、眨眼、发丝/裙摆、换装过渡、摸头反应；记录 FPS/内存/工时/接缝问题。
- POC 验收：1080p 集显 60fps、低端手机 ≥30fps；转头/眨眼/发丝无穿帮；换装 <300ms 无闪白；和现有 v0.9 静态版并排能一眼看出"活了"。

### 7.2 3D 触发条件（满足 ≥2 条再评估）

1. 全角度转身 / 全身动作 / 布料物理成为核心卖点；
2. 愿意投 ≥3 个月 3D 美术或 ≥2 万元外包，并接受双身形翻倍；
3. 目标设备以桌面为主、可接受包体 +20MB；
4. 接受美术整体迁到 VRM/VRoid 风格（现有 AI 插画不再作主视图）。

### 7.3 现有 v0.9 的位置

v0.9（7 槽位纸娃娃）**不是"效果上限"，但它是必要的正确性基线**：手/前发/袖口不再穿帮，且 body/arms/hair/clothes 的拆分正好是 2.5D 绑定的起点。建议：
- 保留在 `feat/layer-v6` 分支；
- 若你希望先有一个"不穿帮"的稳定版本，可按发版纪律发 v0.9.0（小版本，已过 verify + 视觉 QA，只修 bug）；
- 若想直接冲 2.5D，v0.9 可先不发，作为 POC 的"保底回退版本"。

---

## 8. 需要你拍板的问题

1. **目标档位**：确认要冲 **T2（2.5D 看板娘，推荐）**，还是可以接受 T1 轻动效？3D 是否彻底放弃（除非满足触发条件）？
2. **许可取舍**：坚持 **MIT/纯开源**（→ 自研 A 或 Iki/Inochi2D）？还是允许 **Live2D 专有依赖 + PRO 订阅 + 发布许可**（→ 效果天花板最高，但破坏开源纯度）？
3. **投入**：接受 POC 4–6 周 + 全量 2–3 个月的 agent 工作吗？是否愿意引入人工画师/绑定师修图调参（**这决定观感能否从 7 成冲到 8 成以上**）？
4. **v0.9 是否先发**：先发一个"不再穿帮"的小版本，还是等 2.5D 一起大版本？
5. **POC 选材**：先做 Q 版还是少女版？（建议少女版：细节多、更接近看板娘卖点；Q 版更适合做第二版。）

---

## 9. 参考链接（评估依据）

- 经典网页换装：QQ秀 Flash 时代（[界面/Flash 报道](https://www.jiemian.com/article/1187027.html)、[分层仿制教程](https://www.ltesting.net/ceshi/ruanjianceshikaifajishu/rjcskfyy/java/2007/0701/105800.html)）、厘米秀 2D Spine（[QQ 厘米秀 2D 文档](https://q.qq.com/wiki/develop/game/API/cm-show/2d.html)）、超级QQ秀转 3D UE4（[ithome](https://m.ithome.com/html/601255.htm)）；4399 H5 迁移（[澎湃](https://www.thepaper.cn/newsDetail_forward_10654438)）
- 暖暖：环游世界拆包（[blog](https://blog.exz.me/post/nikki-up2u/)）、奇迹暖暖 Live2D（[kamigame](https://kamigame.jp/%E3%83%9F%E3%83%A9%E3%82%AF%E3%83%AB%E3%83%8B%E3%82%AD/%E6%94%BB%E7%95%A5%E3%82%AC%E3%82%A4%E3%83%89/Live2D.html)）、闪耀暖暖 3D 复盘（[游戏那点事](http://www.nadianshi.com/2019/05/241218)、[gameres](https://www.gameres.com/844271.html)）
- Live2D 许可：SDK Release License（[live2d.com/en/sdk/license](https://www.live2d.com/en/sdk/license/)）、Editor FREE/PRO 对比（[comparison](https://www.live2d.com/en/cubism/comparison/)）、Open Software License（[EULA](https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html)）
- 开源 puppet：Inochi2D（[repo BSD-2](https://github.com/Inochi2D/inochi2d)、[WASM SDK 说明](https://raw.githubusercontent.com/Inochi2D/inochi2d/main/README.md)）、Iki（[repo MIT](https://github.com/zeikar/iki)、[npm @ikijs/engine](https://www.npmjs.com/package/@ikijs/engine)）、inochi-avatar（[npm BSD-2](https://www.npmjs.com/package/inochi-avatar)）、Rev2D（[repo](https://github.com/revstudio/rev2d)）
- 运行时：PixiJS v8 Mesh（[guide](https://pixijs.com/8.x/guides/components/scene-objects/mesh)）、three-vrm（[MIT](https://github.com/pixiv/three-vrm)）、VRM SpringBone（[doc](https://vrm.dev/en/univrm/springbone/univrm_secondary/)）、MToon（[doc](https://vrm.dev/en/univrm/shaders/shader_mtoon/)）
- 许可（2026-11 核实）：Live2D 专有软件许可（[EULA](https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html)）、[Core 可再分发文件清单](https://github.com/Live2D/CubismWebSamples/blob/develop/Core/RedistributableFiles.txt)、[SDK Release License](https://www.live2d.com/en/sdk/license/)、[Editor FREE/PRO 对比](https://www.live2d.com/en/cubism/comparison/)、[Spine Editor 许可](https://esotericsoftware.com/spine-editor-license)/[价格](https://esotericsoftware.com/spine-purchase)、[DragonBonesJS](https://github.com/DragonBones/DragonBonesJS)、[E-mote](https://emote.mtwo.co.jp/about/)、[Purism Core](https://github.com/Sakuramotion/PurismCore)、[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)、[charivo 许可](https://github.com/zeikar/charivo/blob/main/packages/render-live2d/LICENSE.md)、[SkelForm](https://github.com/Retropaint/skelform-js)
- AI 资产管线：See-through（[GitHub](https://github.com/shitagaki-lab/see-through)）、Anime2.5DRig（[GitHub](https://github.com/852wa/Anime2.5DRig)）、StretchyStudio（[GitHub](https://github.com/MangoLion/stretchystudio)）、live2d-agent-kit（[GitHub](https://github.com/Ariakage/live2d-agent-kit)）、Bunraku（[项目页](https://bunraku-live2d.github.io/)）、LayerAnimate（[ICCV 2025](https://openaccess.thecvf.com/content/ICCV2025/html/Yang_LayerAnimate_Layer-level_Control_for_Animation_ICCV_2025_paper.html)）、SAM2（[GitHub](https://github.com/facebookresearch/sam2)）、FLUX.1 Fill（[doc](https://docs.bfl.ai/flux_1_fill)）、Seedream 4.0 图像编辑（[blog](https://seed.bytedance.com/zh/blog/)）
- 成本参考：VIVERSE VTuber 成本（[news](https://news.viverse.com/post/vtuber-cost-2025)）

> 说明：文中"观感百分比""工时/成本"为基于公开资料与工程经验的估算，已标注处为估算；未证实项已在正文标出。
