# 贴标工艺规范 (Label Process & Finish)

> 从 442 个真实标签识别的工艺实践。选工艺时：先定位 class (直接印刷 vs 贴标 vs 烫金)，再定 substrate/finish/tactile。

## 标签类型 label_type（本体）
| 类型 | 频次 | 适用/说明 |
|------|------|----------|
| direct_print 直接印刷 | 357 (81%) | 主流；印在瓶/管/盒本体，成本低、贴合曲面 |
| paper_label 纸标 | 54 | 高端/素雅（Aesop、K-beauty）；纸质感、人文 |
| foil_stamp 烫金标 | 16 | 奢华（口红、眼影、香水）；金属闪耀 |
| clear_label 透明标 | 7 | 空白区——"无感"标签，透出产品本体色 |
| bare_no_label 无标 | 6 | 极简/记忆点；靠印刷本体 |

## 印刷方式 print_method
- **screen_print 丝印（221）**：单色/少色、丝网、适合曲线、耐用 → 主选。
- **offset_print 平版（167）**：多色渐变、照片级 → mass/洗护/防晒信息页。
- **hot_stamp_foil 烫金（106）**：金属箔、奢华信号 → 高端 + 品牌/logo。
- **emboss（14）/ deboss（9）**：凹凸、触感 → 高端记忆点。
- **digital（1）/ cold_foil**：空白区（小量/定制）。

## 承印物 substrate / finish / tactile
- **substrate**：none（直接印本体 161）+ other（95）+ in_mold_plastic（79）+ paper_matte（60）+ foil（14）+ transparent_film（12）+ gloss（6）。纸标多 paper_matte 素纸；透明标 transparent_film。
- **finish**：matte 哑（228）+ gloss_varnish 亮油（132）+ metallic（57）+ soft_touch（9）。matte 高雅/高端；gloss 亮丽/市场醒目；metallic 奢华。
- **tactile**：smooth（421）主导；emboss_logo（17）触感 logo；deboss（4）。**凹凸触感是高端差异化**。

## 工艺选型速查
| 诉求 | 选 |
|------|-----|
| 大众/信息量大 | offset_print + gloss_varnish + 多色 |
| 高端/减色 | screen_print 少色 + hot_stamp_foil logo + matte |
| 奢华记忆点 | foil_stamp + emboss_logo + metallic |
| 贴纸素雅 | paper_matte + uncoated + 无 varnish |
| 无感透色 | clear_label / transparent_film + direct_print |
| 环保/植物 | paper_uncoated + screen_print 低 VOCs + 无覆膜 |

> 工艺为视觉近似识别；实际打样需验证附着/耐擦/模切/色差（ΔE<2）。


## 元素 → 工艺映射 (element→process matrix)
每一类标签元素推荐搭配的工艺，使规格可直接用于生产：

| 元素 | 主流工艺 | 替代/高档 |
|------|----------|-----------|
| 品牌徽记 (brand logo / emblem) | screen_print | hot_stamp_foil / emblem_medallion |
| 品牌字 (brand wordmark) | screen_print | hot_stamp_foil (烫金/银) |
| 产品名 | screen_print | hot_stamp_foil |
| 功效/卖点 | screen_print | paper_label 纸贴 |
| 核心成分 | hot_stamp_foil / paper_label | screen_print 小字 |
| 净含量 | hot_stamp_foil | screen_print |
| 分隔/几何条 | hot_stamp_foil 烫金线 | screen_print 专色 |
| 成分图标 (leaf/drop/flask…) | screen_print 单色 | hot_stamp_foil 浮雕 |
| 成分表 (背面) | offset_print 细字 | screen_print |
| 用法 | offset_print | screen_print |
| 备案号/法规 | offset_print 细字 | — |
| 条码 | offset_print | hot_stamp_foil 金属条码(高端) |
| 批号/限期 | 喷码 / offset_print | — |

> 同一元素可叠加工艺（如 brand_wordmark = emboss + hot_stamp_foil）；mockup 中用 `data-proc="hot_stamp_foil emboss"` 形式标注并由图例颜色区分。
