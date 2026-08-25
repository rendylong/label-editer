# Label Spec Sheet — 贴标规格书模板

**doc version:** `{doc_version}` · **mode:** `design|replicate|analyze` · **date:** `{date}`
**品牌:** `{brand}` · **产品:** `{product}` · **tier:** `{tier}`

---

## 1. 排版 Layout
| 项 | 值 |
|----|----|
| 布局图案 layout_pattern | `minimal_centered|stacked_full_wrap|badge_seal|split_band|left_aligned|asymmetric|bare_no_label|other` |
| 位置 label_position | `front_center|front_lower|front_upper|wrap_around|neck_band|back|side|other` |
| 形状 label_shape | `rectangle|square|rounded_rect|oval|full_wrap|die_cut|band|other` |
| 层级线索 | + 一图看懂主次（见 label_content.md）|

## 2. 字体 Typography
| 项 | 值 |
|----|----|
| class | `sans_geometric|serif_display|sans_humanist|script|mixed|other` |
| weight | `light|regular|medium|bold|mixed|other` |
| case | `all_caps|title|sentence|lowercase|mixed` |
| letter_spacing | `tight|normal|wide|very_wide|other` |
| font_pairing | `single_face|two_face_serif_sans|two_face_display_sans|other` |
| 双语 | `主语言 + 次语言`（如 中文主导 + 拉丁辅注）|
| 气质 | `(设计关键词, 如 editorial serif / clinical minimal / k-beauty pastel)` |


## 2.5 图形与几何元素 (Graphic & geometric elements)
| 元素 | 值 | 工艺 |
|------|-----|------|
| logo_emblem (徽记/印章) | 圆/方/异形(描述形状) | emblem_medallion+emboss+hot_stamp_foil |
| wordmark | 品牌字 | hot_stamp_foil / screen_print |
| geometric_divider | 直线/弧线/色块/几何条 | hot_stamp_foil / screen_print spot |
| 成分图标 icon | leaf/drop/flask/seed(自选或 brand 资产) | screen_print / hot_stamp_foil 浮雕 |
| image | 摄影图/插画/底纹(可选) | offset_print / hot_stamp_foil |
| geometric_pattern | 网格/点阵/纹饰 | screen_print / 浮雕 |

## 3. 工艺 Process & Finish
| 项 | 值 |
|----|----|
| label_type | `direct_print|paper_label|foil_stamp|clear_label|in_mold|bare_no_label|other` |
| print_method | `screen_print|offset_print|hot_stamp_foil|emboss|deboss|digital|cold_foil|other (max 4)` |
| substrate | `paper_matte|paper_gloss|paper_uncoated|transparent_film|foil|in_mold|none|other` |
| finish | `matte|gloss_varnish|uv_gloss|soft_touch|metallic|uncoated|none|other` |
| tactile | `smooth|emboss_logo|deboss|raised|none|other` |

## 4. 内容 Content
| 项 | 值 |
|----|----|
| 元素 content_elements | `brand_logo|brand_name|product_name|benefit_claim|hero_ingredient|volume_size|number_shade|scent_variant|usage|ingredient_list|regulatory|tagline (按需)` |
| 层级顺序 | `brand > product > benefit > volume/color/regulatory`（按需定）|
| 密度 content_density | `sparse|moderate|dense`（对齐 tier：luxury=sparse, mass/药妆=moderate/dense）|


## 4.5 占位内容 (Mandatory placeholders)
即便客户未提供真实内容，下列法规字段也必须输出可替换的占位：
- 备案号 → `国妆网备进字（沪）2024 XXXX 号` 之类格式占位
- 成分 → 通用 INCI 占位列表 (Aqua, Glycerin, …)
- 条码 → CSS 假条码 + `0 000000 000000` 占位码
- 用法 → 短句占位 (如 "湿发取适量按摩，冲洗")
- 批号 / 限期 / 净含量 → "见包装" + 标注 PLACEHOLDER
- 产地 → 占位 (如 "中国·上海")

## 5. 差异化 / 改编对照（replicate 模式）
| 元素 | 处理 | 说明 |
|------|------|------|
| 排版/字体/工艺 | 自由演绎 | typography/layout/process 可借鉴（非保护）|
| 商标 logo/wordmark | **Avoid** | 商标不复制 |
| 记忆点 | + 选 1–2 个**空白区**做法 | 见 label_patterns_by_category.md |

## 6. 自检 QC
- [ ] 四维齐全 · [ ] 层级顺序明确 · [ ] 双语/语言已确认 · [ ] ≥2 基准案例 · [ ] mockup 自包含/对比度 · [ ] 打印前打样（ΔE<2, 附着, 模切）

> ⚠️ internal-reference-only · 屏显近似，打印前须打样验证。
