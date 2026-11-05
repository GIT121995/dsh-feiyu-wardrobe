# 已知缺陷登记表（QA Registry）

> 维护者：每次发版前更新；新增缺陷给唯一 ID，修完后回填「修复版本/证据」，**不得删除条目**（`wontfix` 也保留）。
> 关联文档：[`docs/VISUAL-QA.md`](VISUAL-QA.md)（1x/2x 视觉门禁清单与 baseline 流程）、[`CHANGELOG.md`](../CHANGELOG.md)（发布记录）。
> 严重级：**P0** = 崩溃/功能不可用/数据损坏；**P1** = 1x 常规显示下用户可见的明显缺陷；**P2** = 特定场景/2x/高 DPI 可见，或工程卫生与未验证风险；**P3** = 细节/4x 才可见/低影响。
> 状态：`open` = 已确认未修复；`fixing` = 修复中/已有部分缓解；`fixed` = 已验证修复（需填回归证据）；`wontfix` = 明确不修（需写理由）。

## 登记表

| ID | 标题 | 严重级 | 状态 | 发现版本 | 验收标准 | 回归方式 | 关联任务 |
|---|---|---|---|---|---|---|---|
| D-001 | 膝盖/踝关节接缝 + 双色（1x 可见） | P1 | fixing（v2.6 修复） | v2.5.0 | 1x 600–900px 显示下膝/踝无肉眼可见接缝、无双色块；2x 允许 ≤1px AA 过渡，不允许 ≥2px 连续色带/断层 | `npm run visual:qa` 2x 局部 knee/ankle 与 baseline 对比；4x 抓帧人工复核；静置洋红洞 0 | v2.6 素体 B / 腿件重构；W0-c 视觉门禁 knee/ankle crop |
| D-002 | 服装件 1–2px 接缝白线（2x 可见） | P2 | open（v2.6/后续） | v2.5.0 | 2x 下服装拼缝（袖/衣身/裙头/领口）无 ≥2px 连续白线；允许 ≤1px AA；2 身形 × 5 造型组合均满足 | `npm run visual:qa` 2x 局部（肩/袖/腰/裙头/领）× 5 造型对比；4x 抓帧人工复核 | v2.6 / 后续服装拆件；W0-c 视觉门禁 |
| D-003 | 手部线稿粗糙（1x 可接受，4x 简） | P3 | fixing（v2.5 已部分修复） | v2.2.0（cutout 沿用旧线稿） | 1x 手部无肉眼可见粗糙/断线；4x 五指轮廓与指缝连续、细节接近腿/脚件水平；若重绘，轮廓 IoU ≥0.98 且 alpha 不劣化 | `npm run visual:qa` 2x hand 局部 × 2 身形；4x 抓帧人工复核；如换新素材需补充 IoU 指标 | v2.5 T2（interior-only 细节精修，收益温和）/ v2.6 候选 |
| D-004 | tail 527px old-white-hair 垫层（静置被遮，尾摆可能露出） | P3 | open | v2.4.0（v2.5.0 tail 审计纠正） | 尾摆 ±25°/±40° 动作下白发像素不露出：洋红洞 0 且尾摆区无白发像素 diff；rest 合成与当前一致；删除后需记录 atlas 产物契约（drawables/尺寸/显存） | 尾摆洋红洞 QA + 4x 尾摆抓帧；`npm run visual:qa` 2x 尾摆 crop | v2.6 候选（HANDOFF §24 下一步 2） |
| D-005 | 高 DPI（DPR≥2）下 1x 素材发虚 | P2 | open（远期，需单独立项） | v2.5.0（2x 手部实验无收益，全资产 2x 未做） | DPR≥2 下 2x 局部（膝/手/肩/脚/腹/发）肉眼无发虚/锯齿；锐度不劣于当前 baseline；显存/图集体积增量如实记录并评估可接受性 | `npm run visual:qa` 2x crop（DPR2 截图）与 baseline 对比；真机高 DPR 抽样 | 独立立项（HANDOFF §24 下一步 4）；依赖 D-008 真机数据 |
| D-006 | npm 包混入 dev HTML（与预览/打包清单不一致） | P2 | fixing（W0 修，随 v2.6.0 生效） | v2.4.0/v2.5.0（`npm pack` 含工作区 gitignored `docs/preview/*.html`） | `npm pack --dry-run --json` 清单不含 `docs/preview/*.html`、不含 `screenshots.json`、无重复 `files` 条目；`docs/preview` 仅 5 张正式 png | 发布 checklist：`npm pack --dry-run --json` 断言 + `scripts/release.mjs`（W0-c）打包检查 | W0-a task-6（package.json `files` 修正）/ W0-c |
| D-007 | README 失效 `.scratch` 路径与过期构建说明 | P2 | fixing（W0 修） | v2.0.0+ | `grep -n '\.scratch' README.md` 为空；README 内相对链接全部可解析；构建说明只引用仓库内现行文档（`tools/art/README.md` + `assets-src` 获取流程） | 发布 checklist 链接检查（`scripts/release.mjs`，W0-c）+ 手工 grep；Lead 合入前复核 | W0-b task-7 |
| D-008 | 真机性能/显存/稳定性未测 | P2 | open | v2.2.0 起（所有数字来自 headless SwANGLE） | ≥1 台真实移动设备按 P4 矩阵跑：进换装间 60s 无 crash/context lost；自动降级档下 FPS ≥30（记录实际值）；记录显存/内存峰值；页面 v21 / 资产 v17 | P4 真机矩阵（人工回传数据，见 HANDOFF §24 下一步 3）；headless 数据不作发布依据 | P4 真机测试；影响 D-005 决策 |
| D-009 | 素体无露脐设计（产品要求变更中） | P2 | open（目标 v2.6） | v2.5.0 | 若产品要求生效：v2.6 素体 B / 短上衣造型下腰腹拆分件可见、肤色连续、无缺画/接缝，2x 腹部 crop 无露底；若不做则改 `wontfix` 并写明理由 | `npm run visual:qa` 2x 腹部 crop + 短上衣组合换装测试（2 身形） | v2.6 素体 B（规划） |

## v2.6 发版前必查

1. **D-001 / D-002 / D-009**：随素体 B / 拆件重做一起验收，1x/2x 证据附在 v2.6 发布报告。
2. **D-006 / D-007**：W0 已修但**未发版**——v2.6.0 的 `npm pack` 与 README 按验收标准重新核对后，状态改 `fixed` 并记录发布版本。
3. **D-003 / D-004 / D-005 / D-008**：可在 v2.6 之后处理，但需保持本条登记不丢；D-008 真机数据回来前，发布说明必须保留「真机未测」。
4. 发版时把本表「状态 + 修复版本」同步到 CHANGELOG 的「已知限制」小节。

## 与视觉门禁的关系

- [`docs/VISUAL-QA.md`](VISUAL-QA.md) 定义 **1x 全身 + 2x 关键局部**的截图 baseline 与像素对比阈值；本表每条可回归的缺陷都应在该门禁中有对应区域（knee/ankle、hand、尾摆、腹部等）。
- `npm run visual:qa -- --mode compare` 超阈值即失败：这只能证明「与 baseline 相比没有回归」，**不能证明 baseline 本身没有缺陷**。已知缺陷的关闭仍需人工 4x 复核 + 本表验收标准逐条确认。
- 新缺陷进入本表的条件：用户可见 或 发布报告「已知限制」/HANDOFF 明确记录 或 真机/高 DPI 场景复现；修复关闭需附证据路径（抓帧/指标/测试名）。

## 变更记录

- 2026-11-05（W0）：建表，首批登记 D-001 ~ D-009（来源：HANDOFF §17–§24 已知限制、v2.5.0 发布记录、用户反馈）。
