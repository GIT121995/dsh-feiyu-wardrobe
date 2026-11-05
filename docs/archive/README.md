# 历史文档归档

本目录存放**已退役的历史文档**，仅作决策/实现记录参考，**不参与当前构建、渲染与发布**。

- 归档时间：W0 工程债改造（2026-11-05，分支 `chore/w0-workflow`）。
- 归档背景：v2.0.0 起换装间收敛为 **2.5D-only**，DOM 分层纸娃娃（v6/v7 的 `drawOrder`/`layers`/B1-lite 脸部补丁）及旧素材管线（`tools/build_masks.py`、`tools/build_wardrobe.py`、`tools/masks/`）已删除；这些文档随之退役，但保留作为历史决策依据。
- 归档方式：`git mv` 自 `docs/dress-up/` 移入本目录（git 历史随 rename 保留），文首加归档 banner，**正文内容不改写**。
- 路径变化：原 `docs/dress-up/<文件名>.md` → 现 `docs/archive/<文件名>.md`；仓库内引用已改指本目录或现行文档（CHANGELOG 历史条目保留原文，见文首说明）。

## 归档清单

| 文档 | 原用途 | 为什么归档 | 现行替代文档 |
|---|---|---|---|
| [LAYER-ARCHITECTURE.md](./LAYER-ARCHITECTURE.md) | v0.9 技术选型：为什么用 DOM + CSS 多槽位纸娃娃，而非 Canvas/WebGL/骨骼 | DOM 分层渲染已在 v2.0.0 删除；选型结论被 2.5D 路线取代 | [docs/dress-up/2.5D-RUNTIME.md](../dress-up/2.5D-RUNTIME.md)（现行运行时接入说明） |
| [LAYER-MODEL.md](./LAYER-MODEL.md) | v6 分层契约：7 槽位 `drawOrder` / manifest `layers` / 素材构建与验收 | manifest 升 **v8**（删除 `drawOrder`/`layers`/`shapes[].layers`），DOM 纸娃娃退役；本文所述槽位/构建流程已失效 | [docs/dress-up/manifest.json](../dress-up/manifest.json)（v8 数据）、[docs/dress-up/2.5D-RUNTIME.md](../dress-up/2.5D-RUNTIME.md)（rig/atlas 契约）、[DIY-PACK.md](../dress-up/DIY-PACK.md)（`.dshskin` 格式） |
| [RENDERING-EFFECT-EVALUATION.md](./RENDERING-EFFECT-EVALUATION.md) | 「效果上限」技术路线评估：Live2D / Inochi2D / PixiJS / VRM 等对比，结论 T2 2.5D 骨骼看板娘 | 路线已拍板并落地（自研 WebGL2 2.5D runtime 自 v1.0.0 起），评估完成，外部链接/价格信息会过时 | [docs/dress-up/2.5D-RUNTIME.md](../dress-up/2.5D-RUNTIME.md)（现行架构）、[PLAN-2.5D-RIG.md](./PLAN-2.5D-RIG.md)（本目录，历史规划） |
| [PROMPTS.md](./PROMPTS.md) | v0.9 纸娃娃素材管线：素体/服装 look 提示词、`build_wardrobe.py`/`build_masks.py` 构建流程与验收 | 旧 DOM 分层素材管线已于 v2.0.0 删除；现行管线改为 `build_prod.py`（绑定/拆件）→ `build_2d5.py`（图集打包） | [tools/art/README.md](../../tools/art/README.md)（现行资产管线：源素材获取/构建/校验） |
| [PLAN-2.5D-RIG.md](./PLAN-2.5D-RIG.md) | 方案 3「2.5D 网格绑定（Live2D-like）」实施规划：POC 计划、骨架/部件/物理设计、风险 | 2.5D 已实施完成并演进到 cutout 拆件 + 65 骨（v2.5），规划文档完成使命 | [docs/dress-up/2.5D-RUNTIME.md](../dress-up/2.5D-RUNTIME.md)（现行运行时）、[tools/art/README.md](../../tools/art/README.md)（现行资产管线） |
| [DIY-UPLOAD.md](./DIY-UPLOAD.md) | DIY 上传 M1 契约（v0.11.0）：宿主代理/预算/内容守卫/浏览器成层/IndexedDB 本地衣柜/`.dshskin` | v2.1.0 起 DIY 升级为 agent 可调用宿主管线（S2）+ 可动增量 pack（S3），M1 静态贴片路径仅保留为 fallback；费用/守卫边界已并入现行文档 | [DIY-PIPELINE.md](../dress-up/DIY-PIPELINE.md)（宿主生成管线 `plan/generate/split/bind/qa/install`）、[DIY-PACK.md](../dress-up/DIY-PACK.md)（增量 pack 格式、`.dshskin` v1、runtime API） |

## 使用注意

- 本目录文档中的 `.scratch/...` 路径是**当时工作区的证据快照**，仓库内不存在，仅作来源说明。
- 文档中提到的 `tools/build_wardrobe.py`、`tools/build_masks.py`、`tools/masks/`、`art/diy/masks/`（旧 DOM 资产路径）等已在历史版本中删除/迁移，**不要按这些文档执行构建**。
- `docs/dress-up/` 只保留现行文档与前端代码；新增/修改文档请放到现行路径，不要再写回 `docs/archive/`。
- 本目录不随 npm 包分发（`package.json` 的 `files` 只包含 `docs/dress-up`）。
