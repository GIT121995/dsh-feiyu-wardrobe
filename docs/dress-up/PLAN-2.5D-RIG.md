# 方案 3 详解：2.5D 网格绑定（Live2D-like）实施规划

> 目标：把换装间从「静态纸娃娃」升级为「活的 2.5D 看板娘」——近景呼吸、眨眼、视线跟随、±15–20° 转头、口型、发丝/裙摆弹簧物理、换装过渡、表情与触摸反馈。
> 本文是方案 3 的详细设计，不含实现代码。状态：**待用户拍板**；拍板后按 §6 的 POC 计划执行。
> 关联文档：`RENDERING-EFFECT-EVALUATION.md`（路线评估）、`LAYER-MODEL.md`（当前 v0.9 契约）。

---

## 1. 它是什么 / 不是什么

### 1.1 本质区别：换装单位从「图」变成「挂在骨架上的网格部件」

| | v0.9 纸娃娃（T0） | 方案 3 · 2.5D 绑定（T2） |
|---|---|---|
| 一件衣服是什么 | 一张与素体对好坐标的平面图 | 若干 ArtMesh（网格）+ 绑定到共享骨架上的部件 |
| 贴合靠什么 | 像素级配准（AI 出图 1–2% 误差就会露肩/错位） | 蒙皮权重/变形器：衣服跟着骨骼走，领口肩部由绑定定义 |
| 能不能动 | 只能整层位移/缩放 | 网格形变：呼吸/转头/点头/发丝裙摆物理/表情 |
| 换装 | 换图 + 调 z 序 | 换挂件/贴图组 + 切 drawOrder 参数 |
| 新问题怎么修 | 加层/修图/重配准（每件都要人工校准） | 修绑定/参数（一次模板，长期复用） |
| 效果上限 | 静态插画级 | 接近 Live2D 看板娘（商业 7–8 成，人工调优） |

**一句话**：方案 3 把「每件衣服都要和人体精确对齐」换成「衣服网格绑定在人体上」，从根上消除「露肩/错位/穿帮」这类由 2D 配准误差带来的问题。

### 1.2 效果目标（POC 验收时逐条对照）

**要做的**
- 待机：呼吸（胸/肩/头微起伏）、自然随机眨眼、视线跟随鼠标/互动位置、头部微转/点头/侧倾、身体重心轻摆；
- 说话：气泡 + 口型（开/半/闭/元音帧）+ 表情组合；
- 物理：发丝（2–3 段/束）、裙摆（6–8 链）、袖口、尾巴、耳鳍的弹簧惯性；风力/换装时惯性；
- 互动：摸摸头（眯眼+偏头+发丝反馈）、喂食（道具+吃相）、点击说话、心情/亲密度驱动表情；
- 换装：过渡动画（淡入/弹入 + 物理重算 + 特效），槽位替换不重建场景；
- 立绘卡/悬浮鲸鱼：从 canvas 导出，保持现有功能。

**不做（那是 T3 3D 的范围）**
- 全角度转身、真布料模拟、自由镜头、动态光影、全身 3D 动作。

---

## 2. 技术架构（五层）

```
┌─ 展示层：页面（canvas + DOM UI/气泡/衣柜）／DSH iframe／悬浮鲸鱼
├─ 动画层：参数系统 + 状态机（Idle/Talk/Interact/DressUp/Emote）+ 动作库
├─ 绑定层：骨架 / 网格 / 权重 / 变形器 / 表情 / 物理链 / 遮罩
├─ 渲染层：WebGL2 单 canvas（PixiJS v8 Mesh 或裸 WebGL2）+ 图集 + LBS 蒙皮 shader
└─ 数据层：换装槽位表 + `.feiyu.json` 模型/动作/表情/物理 + 部件图集
```

### 2.1 渲染层

- **单 canvas**：整角色收进一个 `<canvas>`，DOM 只留 UI/气泡/点击热区。避免多 `<img>` 叠加的层序问题。
- **引擎选择**：
  - **PixiJS v8（MIT，推荐 POC）**：`Mesh` 支持 Uint32 索引 + 自定义 shader（可做 LBS 蒙皮），生态成熟、开发快；包体约 840KB / 237KB gzip（可 tree-shake）。
  - **裸 WebGL2（正式版可评估）**：更小、更可控，但等于自写渲染器，工程量 +1–2 周。
- **图集**：所有部件打 2–3 张 2048² 图集（RGB + alpha；可 2× 源分辨率 → 4096）；图片超分（realesr-animevideov3 之类）作为可选增强。
- **蒙皮 shader**：顶点属性 = position/uv/boneIndex(boneWeights)；每帧按骨骼矩阵 LBS 变换；2D 骨骼一般每顶点 ≤4 权重。
- **遮罩**：alpha mask 纹理（片元采样，软边、可反相）优于 stencil；注意 mask 切换的填充率开销。
- **性能预算**：40–80 drawable、≤5 万三角形、2–3 张图集、1080p 集显 60fps、低端手机 30–60fps、显存 50–100MB。

### 2.2 绑定层

**骨架（每身形一套，Q版/少女版各一）**
```
root → hips → spine → chest → neck → head
                ├→ shoulderL → upperArmL → forearmL → handL
                └→ shoulderR → upperArmR → forearmR → handR
腿（可选，裙下遮挡）：hips → thighL/R → shinL/R
物理链：hairBack / hairFront×N 束、skirt×6–8、sleeve×2、tail×2–3、earFin×2
```

**网格与权重**
- 网格生成：alpha 轮廓三角化（marching squares + ear-clipping），关节处加密；每个 drawable 约 50–500 顶点；
- 权重：2D 上用「骨段距离 + Laplacian 平滑」或**从模板身形迁移权重**（同一角色两身形共用比例模板），比 bone heat 更稳；关节/发根/裙腰处人工微调；
- 变形器：warp deformer（参数网格）+ rotation deformer；表情用 blendshape（顶点位移）或纹理切换；
- 眨眼/口型：**纹理帧切换 + 网格辅助**（睁开/半闭/闭三帧 + 眼睑网格）；口型 4–6 帧。

**物理（spring bone）**
- 采用 VRM SpringBone 同款算法：stiffness / gravity / drag / 半径 / 碰撞体；
- 头发每束 2–3 段、裙摆 6–8 条链（前后片分开）、袖口/尾巴/耳鳍各 1 链；
- 碰撞：头部球、身体胶囊、腿胶囊、裙摆互撞可简化或忽略；
- 固定 60Hz 子步；低配降级：关物理或降低链数。

**遮罩/穿插**
- 每个 drawable 有 alpha mask 纹理（如头发盖脸、裙摆盖腿、袖口盖手）；
- 手臂前后关系（arm switch）：长袖/短袖/无袖按衣服套配置手臂 draw order 参数——这是 Live2D 处理「手在裙前/袖在臂上」的标准做法，也是方案 3 相对纸娃娃的根本优势。

### 2.3 数据格式（自定义 `.feiyu.json`）

```jsonc
{
  "version": 1,
  "canvas": { "width": 1350, "height": 2400 },
  "atlas": ["atlas-0.webp", "atlas-1.webp"],
  "skeleton": [ { "id": "head", "parent": "neck", "pos": [ ... ] }, ... ],
  "parameters": [ { "id": "HeadAngleX", "min": -1, "max": 1, "default": 0 }, ... ],
  "deformers": [ { "type": "warp", "id": "...", "grid": [...], "parent": "head" }, ... ],
  "drawables": [
    { "id": "dress-maid-body", "atlas": 0, "mesh": {...}, "bones": [...],
      "deformer": "...", "drawOrder": 30, "masks": [...], "bindings": [...] }
  ],
  "slots": {
    "bottom": ["bottom-plaid", "bottom-pleated"],
    "topBody": ["top-sweater", "top-hoodie", ...],
    "hair": ["hair-0"]
  },
  "physics": [ { "chain": ["hair-1","hair-2"], "stiffness": 0.6, ... } ],
  "expressions": { "smile": { "EyeOpenL": 0.7, ... } },
  "motions": { "Idle": [...], "TouchHead": [...] }
}
```
- 格式是自研的（MIT），JSON 可读、可脚本生成、可 diff；后续可考虑兼容 Iki `.iki` 轻量格式。
- 换装 = 按 `slots` 替换 drawable 集合 + 每套衣服的 drawOrder/物理参数 override，不重建场景、不重载引擎。

### 2.4 动画/交互层

- **参数**：EyeOpenL/R、GazeX/Y、HeadAngleX/Y/Z、BodyAngleZ、Breath、MouthOpen/Form、BrowL/R、ArmL/R、HandL/R、HairWind、SkirtWind、Mood 等。
- **程序化常驻**：呼吸（正弦+噪声）、眨眼（随机 2–5s + 双眨）、视线跟随（目标位置→平滑弹簧）、头部微转、重心摆；
- **动作库**：idle 循环、点头、摇头、侧倾、挥手、摸摸头反应、吃、开心/害羞/困/惊讶（参数关键帧 JSON）；
- **状态机**：Idle ↔ Talk（口型+表情）↔ Interact（触摸/喂食）↔ DressUp（换装过渡）↔ Emote（心情）；
- **视线**：鼠标/触控位置映射 Gaze；触摸区域（头/手/身体）触发不同反馈；
- **换装过渡**：旧件淡出/新件弹入 + 物理重置 + 渐变/粒子；<300ms，无闪白；
- **与养成系统接口**：鱼粮/亲密度/心情 → 表情与动作选择；互动事件 → 动画状态。

### 2.5 与 DSH 宿主集成

- 页面仍是 `docs/dress-up/index.html`，`.figure` 的 DOM 图层栈替换为 `canvas`；`app.js` 的渲染路径切到 runtime；衣柜/背景/特效 UI 不变。
- `lib/client.js` 的 iframe / 悬浮鲸鱼逻辑不变；悬浮鲸鱼小图改为从主 canvas 异步截取（保留 `toBlob` + idle 合成纪律）。
- 立绘卡：canvas 合成 900×1350 导出（现有逻辑迁移）。
- **离线/零外呼**：runtime 打包进插件（Pixi 或裸 WebGL2），素材本地；无网络依赖。
- **降级**：低配/兼容模式保留 v0.9 DOM 纸娃娃渲染（feature flag），或纯静态帧；出问题可回退。

---

## 3. 美术资产管线（决定成败，比 runtime 更重）

### 3.1 每身形需要的部件（约 25–35 层）

| 组 | 部件 |
|---|---|
| 头/脸 | 后发、前发（多束可动）、呆毛、耳鳍、脸、眼白、虹膜 L/R、眼睑（开/半/闭）、睫毛、眉、嘴（4–6 口型帧）、腮红（可选） |
| 身体 | 颈、胸/腰、左右上臂、左右前臂、左右手、腿（裙下）、尾巴（2–3 段） |
| 每套衣服 | 衣身（槽位化）、左右袖、裙（前后片/物理链）、领子/领结/围裙等附件、**被衣服遮挡的身体补片**（内衬/腋下/裙内） |
| 特效 | 气泡、立绘卡装饰、粒子（可复用现有 canvas 特效） |

**要求：完整部件**——衣服下的身体、头发背面、袖内手臂、裙下腿都要补画；否则网格一形变就露空。

### 3.2 现有 v0.9 素材的迁移（可复用一部分）

现有 `body/arms/hair + 衣身/袖` 拆分是 2.5D 的**起点**，但不够：
1. **复用**：衣身/袖拆分、身体部件层、drawOrder/槽位概念；
2. **补全**：脸部件（眼/眼睑/口/眉目前烘焙在 body 里）、发束（当前 hair 是整张）、袖/裙内侧、被头发遮住的身体；
3. **拆件工具**：
   - 参考 [See-through](https://github.com/shitagaki-lab/see-through)（SIGGRAPH 2026，Apache-2.0，单图→最多 23 层语义 PSD，含遮挡补画）；
   - 兜底 SAM2 / anime-seg + 手工修；
4. **补画隐藏区**：Seedream 图像编辑（项目已有客户端）/ FLUX.1 Fill / SD inpainting；同角色参考图 + 只补「会被运动暴露」的区域，减少风格漂移；
5. **人工修**：1–3 天/身形套（接缝、线宽、色差、发丝连贯性）——这是观感的关键，AI 补完必须人看。

### 3.3 新衣服流程（模板化后）

1. 用素体生成「只穿这一件」look + whiteout（现有管线，几分钟）；
2. 拆件：衣身/袖/裙/附件 + 隐藏区补画（AI 补 + 人工修 ~1–3 小时/套）；
3. 自动 mesh + 权重（从模板迁移）；物理参数（模板 + 2–3 个参数微调）；
4. drawOrder/槽位配置 + QA（约 0.5–1 小时）；
5. **诚实预期**：新衣服从「生成几分钟」变成「**每套数小时**」；两身形 × 6 套 + 后续更新是持续成本。

### 3.4 一致性风险

- AI 补画的风格/线宽/光照漂移 → 运动时接缝可见；用参考图 + 固定风格描述 + 人工修；
- 两身形比例（Q版/少女版）——共用骨架模板、按比例缩放权重；
- 建议先做「角色 Bible」（色卡/线宽/眼睛画法/发束规范），所有补画按它来。

---

## 4. 工具链选型（方案 3 内部还有 4 条路线）

| 路线 | 说明 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **3a 自研 WebGL2 + PixiJS + 自研 JSON** | 自己写 runtime/绑定/物理/换装 | MIT 干净、完全可控、可定制换装/物理/表情；和现有工程/素材衔接好 | runtime 4–8k 行 TS + 工具链自建；无现成社区 | **推荐主路线（POC 先做）** |
| **3b Purism Core + Live2D 资产** | 用 Cubism Editor 做资产/绑定，MIT 的 Purism Core 播放 | 资产/绑定可用成熟工具；runtime 许可干净（若法律成立） | Purism 为 clean-room 重实现、**法律未证实**；需 1 周法律+技术 PoC | **并行做 1 周 PoC**，成立则大幅省绑定成本 |
| **3c Iki**（`@ikijs/engine`，MIT，`.iki` JSON，AI auto-rig） | 开源 Live2D 替代，专为「AI 生成角色」设计 | MIT、WebGL2、有 AI auto-rig/MCP；省 runtime 工程 | 0.x 早期（2026-06 起，~29★），格式可能变，质量未知 | 观察 + POC 对照 |
| **3d Inochi2D（BSD-2）+ Inochi Creator** | 开源绑定工具/格式 | 许可干净、有编辑器 | **官方无可用 web runtime**（第三方不达生产）→ 自建 WASM runtime 4–8 人周 | 备选/参考 |
| Live2D 官方 | 行业标准 | 效果/工具最成熟 | 专有 SDK、纯 MIT 不可打包 Core、PRO 订阅 + 发布许可 | 仅作效果基准；纯 MIT 下排除 |

> 推荐组合：**3a 为主**（可控、MIT、能贴合现有换装系统），**3b 花 1 周验证**（若成立，绑定质量/速度可能提升一个档），3c 观察。

---

## 5. 为什么它能解决「露肩/穿帮」

- 衣服不是「一张和素体对坐标的图」，而是**绑在骨架上的网格**：肩部/领口覆盖由网格顶点和绑定决定，不依赖 AI 出图的 1–2% 像素级对齐；
- 换装时 drawOrder/arm switch 由参数控制（长袖/短袖/无袖切换手臂前后），这类「夹心遮挡」在绑定阶段就是显式配置的，不需要再拆 z 槽位；
- 形变时衣服随身体走，不会因为「身体动了、衣服没动」而露肤；
- 代价：每套衣服要完整部件 + 绑定/物理参数（见 §3 成本）。

---

## 6. 实施计划

### Phase 0 · 准备（3–5 天）
- 定效果指标/验收（§7）；选 1 身形（建议**少女版**：细节多、看板娘卖点强）+ 1 套衣服（建议**水手服**，正好验证这次露肩问题）+ 1 个参考 Live2D 样本；
- 搭 Pixi/WebGL 最小骨架 + 参数滑条 demo（用占位纹理验证蒙皮/变形/物理）；
- 定资产规范：层名、尺寸、图集、JSON schema、命名约定。

### Phase 1 · POC（4–6 周，gate 决定是否全量）
- **资产**：该套衣服 × 1 身形约 22–35 层完整部件（眼/口帧、发束、袖/裙物理链、身体补片）；人工修 1–3 天；
- **Runtime**：LBS 蒙皮 + warp deformer + 参数系统 + 眨眼/视线/转头 + 发丝/裙摆 spring + 换装 slot 替换 + 立绘卡导出；
- **集成**：页面切 canvas（保留 DOM fallback）；悬浮鲸鱼/导出；性能测试；
- **对照**：与 v0.9 静态版并排录屏/截图；记录工时与观感差距；
- **并行 spike（1 周内）**：Purism Core 法律/技术验证（能否 MIT 分发 + 播放 Live2D 资产）。

### Phase 2 · 全量（2–3 个月）
- 两身形 × 6 套完整资产 + 物理参数；表情/动作库；互动（摸摸头/喂食/心情/亲密度）；换装过渡/特效；图集/性能优化；低配降级；全量回测；发版 v1.0.0（大版本，按纪律）。

### Phase 3 · 可选
- 若 3b 成立 → 用 Live2D 资产/绑定管线替换自研绑定（保留 MIT runtime），大幅提升观感上限；
- 配饰层（头饰/鞋子/手持，复用同一套 drawable slot）；
- AI 视频特殊演出（喂食/生日等预渲染短片，作为"高光时刻"补充）。

---

## 7. POC 验收标准（gate）

| 维度 | 标准 |
|---|---|
| 视觉 | 近景 2x 无接缝/穿模；转头 ±15° 肩颈/领口不露肤；眨眼无跳变；发丝不穿脸；裙摆无穿腿 |
| 动画 | 呼吸/眨眼/视线/转头自然；口型同步；换装过渡 <300ms 无闪白 |
| 性能 | 1080p 集显 60fps；低端手机 ≥30fps；内存 <256MB；包体增量 ≤3MB（图集压缩后） |
| 集成 | 立绘卡/悬浮鲸鱼/背景/特效仍工作；离线；npm 包无网络依赖 |
| 可维护 | 新衣服 ≤3 小时/套（模板化后）；自动测试覆盖参数/槽位/物理合理性 |
| 决策 | 与 v0.9 并排"明显活了"；工时/成本报告可接受 → 进入 Phase 2 |

---

## 8. 诚实成本与风险

- **工作量**：POC 4–6 人周（美术拆件修图 1–2 周 + runtime/绑定 2–3 周 + 集成 QA 1 周）；全量 2–3 人月（不含外部画师/绑定师）。
- **观感预期**：全自动管线约为商业 Live2D 的 4–5 成；人工修图/调参 7–8 成；要接近商业天花板需要熟练绑定师——**这可能是比 runtime 更硬的瓶颈**。
- **风险清单**：补图风格漂移；权重鬼影（关节"糖纸"）；物理穿模；每套衣服 drawOrder/物理手调；图集显存；双身形成本翻倍；自研编辑器范围失控（POC 只做"够用"，不做通用工具）；Purism 法律风险。
- **AI 成本**：Seedream 出图约 ¥0.3/张；POC 约 50–100 张 ≈ ¥15–30；人工修图/绑定若外包另计。

---

## 9. 与现有版本的关系

- **复用**：v0.9 的 body/arms/hair/衣身/袖拆分、槽位概念、QA/回测体系、构建管线思路；
- **迁移**：页面从 DOM img 切 canvas；`manifest` 概念映射到 drawable slot；保留 v0.9 作为低配 fallback；
- **回退**：2.5D 上线出问题可切回 DOM 纸娃娃（feature flag）；
- **版本**：v1.0.0（大版本；发版纪律：verify + 回测 + tag + npm + release + profile + 重启）。

---

## 10. 参考

- 厘米秀 2D（Spine 共享骨架 + 装扮 skinnedmesh）：[QQ 厘米秀 2D 文档](https://q.qq.com/wiki/develop/game/API/cm-show/2d.html)
- Live2D ArtMesh/变形器/物理：[ArtMesh 概念](https://docs.live2d.com/4.2/en/cubism-editor-manual/concept-of-artmesh/)
- VRM SpringBone（物理参考）：[VRM doc](https://vrm.dev/en/univrm/springbone/univrm_secondary/)
- PixiJS v8 Mesh：[guide](https://pixijs.com/8.x/guides/components/scene-objects/mesh)
- See-through（单图拆层）：[GitHub](https://github.com/shitagaki-lab/see-through)
- Anime2.5DRig（浏览器端 2D 自动绑定参考，MIT）：[GitHub](https://github.com/852wa/Anime2.5DRig)
- StretchyStudio（插画→网格形变角色，MIT）：[GitHub](https://github.com/MangoLion/stretchystudio)
- Iki（MIT，`.iki`，AI auto-rig）：[GitHub](https://github.com/zeikar/iki)
- Purism Core（MIT clean-room Live2D Core，法律未证实）：[GitHub](https://github.com/Sakuramotion/PurismCore)
- Inochi2D（BSD-2）：[GitHub](https://github.com/Inochi2D/inochi2d)
- Live2D 许可：[SDK Release License](https://www.live2d.com/en/sdk/license/) / [Editor FREE vs PRO](https://www.live2d.com/en/cubism/comparison/)
