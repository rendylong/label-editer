# 贴标实践 · 按品类惯例与差异化 (Label Patterns by Category)

> 基于 442 个真实化妆品包装的贴标识别（kb_version label-v1.0.0）。
> **惯例** = 该品类多数怎么排（贴标主流做法）。**差异化空白** = 少数/稀缺的做法（做记忆点的机会）。

## 全局惯例（跨品类）
- **排版**：minimal_centered 居中极简（375/442）压倒性；front_center 正面居中（368/442）；rectangle 矩形（244/442，其余 full_wrap 47/rounded 20）。
- **字体**：sans_geometric（201）> serif_display（95）> sans_humanist（69）> mixed（66）；weight 常 mixed（203）/regular（177）；case all_caps（208）+ mixed（175）；字距 normal（277）+ wide（130）；font_pairing 单字体（330/442）。
- **工艺**：label_type direct_print 直接印刷（357/442）> paper_label（54）> foil_stamp（16）；print_method screen_print（221）+ offset_print（167）+ hot_stamp_foil（106）；finish matte（228）+ gloss_varnish（132）+ metallic（57）；tactile 绝大多数 smooth（421）。
- **内容**：brand_name（406）+ product_name（371）+ benefit_claim（203）+ volume_size（171）为铁三角；density sparse（284）+ moderate（145）；双语 210/442（≈48%）；主体为拉丁（417）。

## 差异化空白（跨品类稀缺，做记忆点/避竞争）
- **排版**：left_aligned（15）、badge_seal（6）、split_band（5）、asymmetric、die_cut。满墙"居中极简"时换不对称/竖排/分带即跳脱。
- **字体**：sans_humanist（69）温和、script_calligraphic（1）几乎空白、two_face pairing（85+17）、very_wide 字距（25）、light 字重（31）。中文/韩文字体主导极稀缺（korean 2）→ **中文大字主导的编辑排版是空白**。
- **工艺**：clear_label（7）、emboss_logo 触感（17）、deboss（4）、cold_foil/digital、裸金属/磨砂局部。直接印刷红海，贴纸/透明标/浮雕是差异化。
- **内容**：中英/中法双语（210）接近均衡但中文主导稀缺；hero_ingredient（109）+ benefit_claim（203）做"功效/成分前置"是当前主流，可反向做"极简信息/无标签"。

## 各品类惯例速查（排版/类型/工艺/字体/内容）
| 品类 | 排版 | 标签类型 | 工艺 | 字体 | 内容特色 |
|------|------|---------|------|------|---------|
| perfume | minimal_centered | direct+paper | screen+foil | sans+serif | brand/product/scent/tagline |
| shampoo | minimal_centered+full_wrap | direct | offset+screen | mixed+serif | brand/volume/benefit/hero |
| conditioner | minimal+left | direct+paper | offset+screen | sans+mixed | brand/product/volume/regulatory |
| serum | minimal+full_wrap | direct+paper | screen+foil | sans+humanist | brand/product/logo/benefit/hero |
| face_cream | minimal+full_wrap | direct+paper | screen+foil | sans+serif | brand/product/logo/benefit/hero |
| toner | minimal+left | direct+paper | screen+offset | sans+mixed | brand/product/benefit/hero/volume |
| lipstick | minimal+full_wrap | direct+foil | hot_stamp+screen | sans+serif | brand/logo/product/number_shade |
| eyeshadow | minimal | direct+foil | hot_stamp+offset | sans+serif | brand/number_shade/product |
| sunscreen | minimal+full_wrap | direct | offset+screen | mixed+humanist | brand/product/benefit/volume/regulatory |
| makeup_remover | minimal+left | direct+clear | offset+screen | sans+humanist | brand/product/benefit/volume/regulatory |
| hand_cream | minimal+full_wrap | direct+paper | screen+offset | serif+humanist | brand/product/usage/volume/scent |
| nail | minimal+bare | direct+paper | screen+offset | serif+mixed | brand/product/number/benefit |

## 用法
查询真实案例用 `query_labels.py --category X --tier T --layout L --typo C --print P`。本文件是快照；生产关键前重查。
