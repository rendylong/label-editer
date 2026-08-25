# 贴标内容规范 (Label Content & Hierarchy)

> 内容 = 标签上放什么、按什么顺序、多密。数据：brand_name 406 / product_name 371 / benefit_claim 203 / volume 171 / hero_ingredient 109 / brand_logo 107。

## 内容元素清单（放什么）
| 元素 | 频次 | 说明 |
|------|------|------|
| brand_name | 406 | 品牌名，几乎必在 |
| product_name | 371 | 产品名 |
| benefit_claim | 203 | 功效卖点句（美白/抗老/卷度…）|
| volume_size | 171 | 容量/净含量 |
| hero_ingredient | 109 | 核心成分（玻尿酸/视黄醇/雪松…）|
| brand_logo | 107 | 标志/徽记 |
| regulatory | 86 | 备案/法规/成分表 |
| number_shade | 84 | 色号（口红/美甲）|
| scent_variant | 34 | 香型（香水/手霜）|
| usage_directions | 34 | 用法 |
| tagline | 31 | Slogan |
| ingredient_list | 15 | 成分列表 |

> "铁三角" = brand_name + product_name + benefit_claim（+volume）。绝大多数标签至少这三样。

## 内容层级（排布顺序）
数据高频层级：
- brand logo > brand name > product name
- brand logo > product name > benefit claim > volume size
- brand name > product name > benefit claim > volume
- brand name > product name > scent variant / number shade
> 核心：**品牌第一**（logo/名），**产品名第二**，**功效/卖点第三**，容量/色号/法规兜底。

## 密度 density
- sparse 稀疏（284）—— 高端/极简，留白显贵。
- moderate 适中（145）—— 主流平衡。
- dense 密集（9）—— 信息型/药妆/成分党。
> 选 density 对齐 tier：luxury→sparse 大留白；mass/药妆→moderate/dense 信息前置。

## 要点
1. 品牌永远最强（字重/字号/位置最高）。
2. 功效卖点在高端可弱化（克制），在 mass 需前置放大。
3. 双语时主导语言（中文/英文）层级更高。
4. 色号/容量放次位，法规/成分表放背面或小字。
5. 无标签/仅一要素 = 记忆点（bare_no_label 6/442），适合差异化。
