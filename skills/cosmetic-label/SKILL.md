---
name: cosmetic-label
description: Designs and analyzes the label / 贴标 (printed area, paper label, direct print, in-mold decoration) of cosmetics packaging. Covers four dimensions — 排版 layout, 字体 typography, 工艺 print/process, 内容 content hierarchy. Three modes — Design (new label), Replicate (deconstruct a reference label into an adapted spec), Analyze (label report). First clarifies the user's brand, product, positioning, design strategy, and label content/language requirements. Grounds every decision in compiled label-convention and whitespace analysis of real product packaging. Use when asked to design, redesign, analyze, or prepare an editor handoff for the label, sticker, typography, or printed content of a cosmetics bottle, jar, tube, lipstick, or compact.
---

# cosmetic-label — Cosmetics Label / 贴标 Design Skill

Guide your Agent to produce **label (贴标) 设计**: 排版 (layout)、字体 (typography)、工艺 (print/process)、内容 (content hierarchy)，for cosmetics packaging — bottle, jar, tube, lipstick, compact. Grounded in real-label conventions and whitespace analysis.

**Modes (auto-detected):**
- **Design (A)** — design a new label for a given product/tier.
- **Replicate (B)** — deconstruct a reference label → adapted, differentiated label spec.
- **Analyze (C)** — label CMF/design report on an existing design.

**Rules (do not skip):**
1. All label patterns come from compiled real-label conventions (queryable via `scripts/query_labels.py`; verify with `--check`). Present conclusions as "category conventions" and "differentiation whitespace" — not as a corpus to inspect.
2. **Ask before designing** — never assume brand, product, positioning, or content.
3. If a dimension is ambiguous, output `other`/`none`/`uncertain` — never invent specifics.
4. Fonts/typography/layout are **free to interpret** (design freely); only trademarks (logo/wordmark) are off-limits.
5. Screen preview is approximate; label finish/print must be sample-checked (ΔE<2, adhesion, die-cut) before production.

---

## Plugin workflow boundary

When this skill is bundled with `$cosmetic-label-editor`, the required end-to-end order is:

`cosmetic-label -> cosmetic-label-editor`

This skill owns design intent and approval. Complete the four design dimensions, exact copy or marked placeholders, and the visual mockup before GLB production begins. Then produce an **Editor Handoff** using `references/editor_handoff.md`.

- If the user wants a review checkpoint, stop after the design directions and continue only after one direction is approved.
- If the user explicitly asks for a fast uninterrupted run, select the strongest direction, mark the handoff `assumed_for_fast_run`, list every assumption, and continue.
- Never invent mesh names, `stableSelector` values, or UV ranges. Those are model-specific production decisions owned by `$cosmetic-label-editor` after `inspect_model`.
- A supplied, already-approved design spec may be normalized into the Editor Handoff without redesigning it.

---

## STEP 1 — Clarify with the user (ALWAYS, needs-driven)
Never assume brand, product, positioning, or label constraints. Only ask what the brief doesn't already give.
Ask in 2 stages, one question per real design decision. If the user wants speed, default to a reasonable
value, label it as an assumption, and move on.

**Stage 1 · 定位与边界** (决定贴标方向是否可行):
1. **品牌 + 产品 + 范围** — 品牌名？产品(品类+名)？单一 SKU 还是**系列**(多色号/多香型/多容量)？
   → 决定要不要做**可复用的贴标系统/模板**。
2. **市场 & 语言** — 目标市场(国内/出海/某区)？主语言、是否双语？→ 决定语言与**法规区**(备案/成分表/净含量)。
3. **定位 & 个性** — tier(价位档) + 品牌个性(2–4 词)。→ 决定留白/字体气质/工艺档次。
4. **渠道** — 电商主图 / 线下货架 / DTC / 展会？→ 决定远距辨识与信息密度。
5. **预算 & 工艺可达** — 成本敏感度(丝印少色 / 多色平版 / 烫金 / 浮雕 / 贴纸)？有无既有标签尺寸/模具或允许新开？→ 决定工艺。

**Stage 2 · 设计驱动** (决定方向、硬约束、交付):
6. **内容硬约束** — 标签**必须**含哪些(备案号/成分表/净含量/双语/条码/批次/用法/色号)，哪些可省？→ 合规是最大硬约束。
7. **贴标专属** — 贴哪(front/back/full-wrap/neck/band)、有无异形/模切需求、需不需要背标(成分表/法规)。
8. **参考/对标** — 有无参考图/竞品标签要对齐还是避开？→ 决定"贴惯例"vs"差异化避撞"。
9. **设计取向 + 自由度** — 按惯例(稳妥) vs 差异化(记忆点)？改动幅度偏好(小改 vs 大胆)？
10. **交付物 & 节奏** — 概念 moodboard / 评审稿 / 供应商-ready 文件？何时要、给谁批？

> 铁律：① 只问缺失的；② 一次一个诉求、别连环轰炸；③ 用户要快就默认合理值并**显式标注假设**；
> ④ 未确认合规/预算等硬约束前，不直接出最终方案。差异化方向由你(agent)列 2–3 个，用户挑一个。

## STEP 2 — Ground in label conventions & whitespace
1. Query real-label conventions internally:
   ```
   python3 scripts/query_labels.py --category <CAT> --tier <T> --layout L --typo C --print P --script S
   python3 scripts/query_labels.py --stats
   ```
2. Identify the **dominant** label type / layout / typography class / print method (conventions) and the
   **under-used** values (whitespace → differentiation).
3. Pick the whitespace axes the label will occupy (layout pattern, type class, process, content emphasis).


## Step 2.5 — Proto-type & placeholder protocol
- 渲染规格书时，参考 references/label_spec_template.md，明确标注 **样机尺寸(mm) + 标签尺寸(mm) + 比例尺**。
- 每个元素写明 `data-proc="工艺1 工艺2"`，对应元素→工艺映射见 references/label_process.md。
- 即便用户未提供 备案号/成分/条码/用法 等内容，**也必须输出可替换的占位**（格式真实、明确标 PLACEHOLDER），不能留空。
- 视觉板使用 references/label_mockup.html，按 `--px-per-mm` 渲染，默认 5px/mm ≈ retina life-size。

## STEP 3 — Produce the deliverable

### Mode A — Design
1. Anchor on the category × tier label conventions; differentiate on whitespace axes.
2. Give 2–3 directions (or 1 + a convention control if the user chose convention); each differs on ≥3 axes
   (layout pattern, typography class/case/spacing, print/process, content hierarchy).
3. Output a **label spec sheet** (排版/字体/工艺/内容, see `references/label_spec_template.md`) + a
   **label mockup HTML** (front + back view, style reference `references/label_mockup.html`).
4. For GLB production, output an **Editor Handoff** (`references/editor_handoff.md`) for the selected direction.

### Mode B — Replicate
1. **Deconstruct** the reference label into 4 layers (排版 / 字体 / 工艺 / 内容).
2. Map the same category's conventions vs whitespace (differentiation + avoid copying trademarked logo).
3. Output an **adapted** label spec: keep the learnable layer, replace the distinctive execution; fill a
   Borrow/Adapt/Avoid table.

### Mode C — Analyze
Output the structured label report (reuse Mode B deconstruction, no adaptation).

## STEP 4 — Self-check (QC)
- 排版/字体/工艺/内容 four dimensions all filled; no empty required field.
- 排版 = layout + position + shape + hierarchy stated; 字体 = class + weight + case + spacing + pairing (bilingual note).
- 工艺 = label type + print method + substrate + finish + tactile; 内容 = elements + density + hierarchy order.
- ≥2 benchmark-case references per decision. Content language confirmed with user.
- Label mockup renders self-contained (no CDN), contrast ≥4.5:1, no trademarked logo copied.
- **internal-reference-only** notice; print must be sample-checked before production.

## Outputs
- Label spec sheet (`references/label_spec_template.md` filled).
- Label mockup HTML (front + back), tier-mirrored.
- Editor Handoff for `$cosmetic-label-editor` when the work will be produced on a GLB.
- Benchmark list + honest data-gap notes (never invent a benchmark).
- `internal-reference-only` notice.

## Notes
- Reference imagery is for internal design research only — NOT for redistribution/commercial asset libraries.
- Conventions/whitespace are directional; re-query before production-critical advice.
