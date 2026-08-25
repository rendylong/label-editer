# 贴标字体规范 (Typography Guide)

> 从 442 个真实标签识别的字体实践。选字体时先定 class/weight/case/spacing/pairing，再对品类惯例（见 label_patterns_by_category.md）。

## 字体 class 分布与用法
| class | 频次 | 适用 |
|-------|------|------|
| sans_geometric | 201 (46%) | 现代/科技/护肤/功能性主流；干净、可读 |
| serif_display | 95 (21%) | 高端/奢华/优雅（香水、高端面霜、口红）；品牌厚重感 |
| sans_humanist | 69 (16%) | 温和/自然/植物系（Aesop、K-beauty、护手霜）；人文气息 |
| mixed | 66 (15%) | 双字体系统（serif 品牌 + sans 信息）；最常见品牌系统 |
| script_calligraphic | 1 (~0%) | 空白区——复古/浪漫/奢华记忆点 |

## 字重 / 大小写 / 字距
- **weight**：mixed（203，品牌字重 + 信息细体）> regular（177）> light（31）。高端常用 light/regular 大标；mass 用 bold 强调功效。
- **case**：all_caps（208，干净/高端）> mixed（175）> title（24）> sentence（12）。香水/高端喜全大写宽字距；护肤喜 title/sentence 更亲和。
- **letter_spacing**：normal（277）> wide（130）> very_wide（25）。**wide/very_wide 全大写 = 高端奢华信号**；normal 小字信息。
- **font_pairing**：single_face（330）占绝对主流；two_face serif+sans（85）用于品牌字/信息分职；two_face display+sans（17）。

## 层级与主次（信息排版核心）
1. 品牌（Brand）—— 最强权重/最大字或标志。
2. 产品名（Product）—— 次级。
3. 功效/核心成分（Benefit / Hero ingredient）—— 卖点行。
4. 规格/其他（Volume / regulatory / usage）。
> data 佐证：内容层级 top 多为 "brand logo > brand name > product name > benefit claim/volume"。品牌是绝对第一。

## 双语与字体搭配
- 双语 210/442（≈48%）。外扩/出海几乎必双语。
- **中文主导编辑排版是空白区**（korean 2、mixed 13 极稀缺）——中文大字 + 小号拉丁辅注可做记忆点。
- 中英搭配：中文用宋体（serif 感）/黑体（geometric 感），拉丁用同气质 sans/serif；避免"中文字体硬套拉丁"。

## 选型速查
| 品类 | 推荐 |
|------|------|
| 高端香水/面霜 | serif_display 全大写 + very_wide 字距 + single_face |
| 护肤/精华 | sans_geometric + title/sentence + 双字体(brand serif/info sans) |
| 修护/植物 | sans_humanist / 中文宋体 + 左对齐 + 诗性 density |
| 大众洗护 | sans_geometric bold all_caps + normal 字距 + 功效大字 |

> 注：字体识别是视觉近似（class/气质），不是精确字体名；量产前用文字稿 + 实际字体匹配验证。
