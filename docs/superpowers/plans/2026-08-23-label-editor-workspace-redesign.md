# Label Editor Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a light professional label-design workspace with a 60-font local catalog, reusable parameterized geometry elements, separated model/label navigation, contextual properties, and stable 2D/3D/export behavior.

**Architecture:** Preserve the existing React, Zustand, Konva, and Three.js pipeline while splitting the oversized panel module into focused workspace components. Add pure catalog, geometry, selection, and migration modules first; then connect them to the canvas and UI so every phase remains testable and old `.lbl` projects continue to open.

**Tech Stack:** React 19, TypeScript 5.9, Zustand 5, Konva 10, react-konva 19, Three.js 0.185, Vite 7, Vitest 3, local WOFF2 font assets, browser E2E/visual QA.

**Spec:** `docs/superpowers/specs/2026-08-23-label-editor-workspace-redesign-design.md`

## Global Constraints

- The editor is light-only for this delivery: application `#F4F6F8`, panels `#FFFFFF`, canvas workspace `#EEF1F4`, accent `#356AE6`.
- 2D remains the primary design surface; 3D validates the result and never becomes the source of label layout data.
- Label paper remains transparent unless the user explicitly enables a paper color.
- Font, shape, property, 2D, 3D, PNG, project, and GLB output all consume the same serialized layer state.
- Font assets are open-source, deployed with the application, lazy-loaded, and accompanied by license metadata.
- Old project versions 1 and 2 must remain importable; the new writer emits project version 3.
- UI animation may use only `transform` and `opacity`, and must respect reduced-motion preferences.
- Do not add a panel docking framework or a general SVG/path editor.
- The current directory is not a Git worktree. Do not initialize Git implicitly; replace commit checkpoints with explicit test/build evidence unless the user separately authorizes repository initialization.

---

## File Structure

### New domain modules

- `src/label/fontCatalog.ts` — curated font metadata, categories, legacy-name mapping, and catalog queries.
- `src/label/fontRuntime.ts` — lazy `FontFace` registration, readiness tracking, glyph coverage checks, and export barriers.
- `src/label/shapeGeometry.ts` — parameterized shape types, normalization, bounds, and canvas drawing commands shared by preview and masks.
- `src/label/elementPresets.ts` — text and geometry preset factories; the UI consumes this instead of hard-coded add buttons.
- `src/label/selection.ts` — pure multi-selection, alignment, distribution, and transform helpers.
- `src/app/projectSchema.ts` — version-3 serialization and version-1/2 migration.

### New UI modules

- `src/ui/icons.tsx` — shared SVG icons currently embedded in `Panels.tsx`.
- `src/ui/EditorSidebar.tsx` — `贴标 / 模型` tabs and sidebar shell.
- `src/ui/LabelWorkspace.tsx` — area selector, add-element action, layer list, and layer actions.
- `src/ui/ModelPartTree.tsx` — model-only search, hierarchy, visibility, and create-area actions.
- `src/ui/ElementLibrary.tsx` — searchable categorized element popover.
- `src/ui/FontBrowser.tsx` — searchable categorized font browser with preview, favorites, recent fonts, and status.
- `src/ui/Inspector.tsx` — contextual inspector router.
- `src/ui/InspectorSection.tsx` — accessible collapsible inspector sections.
- `src/ui/inspectors/TextInspector.tsx` — text content, typography, appearance, transform, and craft controls.
- `src/ui/inspectors/ShapeInspector.tsx` — geometry, appearance, transform, and craft controls.
- `src/ui/inspectors/ImageInspector.tsx` — image sizing, ratio lock, appearance, transform, and craft controls.
- `src/ui/inspectors/AreaInspector.tsx` — transparent paper, area range, and global craft controls.
- `src/ui/inspectors/MultiSelectionInspector.tsx` — alignment, distribution, common opacity, and bulk actions.
- `src/ui/ViewModeSwitch.tsx` — `2D / 2D + 3D / 3D` segmented control.

### Modified modules

- `src/label/types.ts` — font reference, shape union, project-compatible geometry parameters.
- `src/label/fonts.ts` — retain uploaded-font compatibility while delegating catalog fonts to `fontRuntime.ts`.
- `src/label/LabelCanvas.tsx` — generic shape renderer, font readiness, multi-select Transformer, and light editing guides.
- `src/label/craft.ts` — remove rectangle-only assumptions from shape craft helpers.
- `src/state/stores.ts` — selected layer id array, workspace tab, central view mode, font favorites/recent state.
- `src/app/actions.ts` — project v3, migration entry point, font readiness before PNG/GLB export, multi-select shortcuts.
- `src/app/App.tsx` — new three-region workspace and central view modes.
- `src/ui/Toolbar.tsx` — central view switch and removal of binary design/3D toggle.
- `src/ui/Panels.tsx` — reduced to compatibility exports during migration, then deleted when no imports remain.
- `src/app/styles.css` — light tokens and all new workspace, popover, inspector, focus, and responsive rules.
- `src/app/AreaPicker.tsx` — light 2D area-selection surface.
- `src/scene/SceneController.ts` — light studio background, grid, outline, and light balance.

### Font assets

- `public/fonts/<font-id>/<weight>-<style>.woff2` — self-hosted font files.
- `public/fonts/<font-id>/OFL.txt` or the upstream license file — license per font family.

### Tests

- `tests/fontCatalog.test.ts`
- `tests/fontRuntime.test.ts`
- `tests/shapeGeometry.test.ts`
- `tests/elementPresets.test.ts`
- `tests/selection.test.ts`
- `tests/projectSchema.test.ts`
- `tests/uiStore.test.ts`
- Modify `tests/renderingFidelity.test.ts`
- Modify `tests/export-roundtrip.test.ts`

---

### Task 1: Add project-v3 domain types and safe migrations

**Files:**
- Modify: `src/label/types.ts`
- Create: `src/app/projectSchema.ts`
- Modify: `src/app/actions.ts`
- Test: `tests/projectSchema.test.ts`
- Modify: `tests/export-roundtrip.test.ts`

**Interfaces:**
- Produces: `PROJECT_VERSION = 3`
- Produces: `parseLabelProject(raw: unknown): LabelProjectV3`
- Produces: `serializeLabelProject(modelFileName: string, areas: LabelAreaConfig[]): LabelProjectV3`
- Produces: `ShapeKind`, `ShapeGeometry`, and the expanded `ShapeLayer`
- Produces: `TextLayer.fontFamily` as a stable font id while preserving legacy import mapping

- [ ] **Step 1: Write failing migration tests**

```ts
import { describe, expect, it } from 'vitest'
import { parseLabelProject, serializeLabelProject } from '../src/app/projectSchema'

describe('label project v3', () => {
  it('migrates a v2 rectangle and legacy font name', () => {
    const project = parseLabelProject({
      version: 2,
      modelFileName: 'bottle.glb',
      areas: [{
        id: 'a1', name: 'Front', meshIndex: 0, nodeName: 'Bottle',
        remap: { mode: 'cylindrical', axis: [0, 1, 0], origin: [0, 0, 0], radius: 1, wrap: 1, offset: 0, planarBox: { min: [0, 0, 0], max: [1, 1, 1] } },
        range: { uStart: 0, uWidth: 1, vStart: 0, vHeight: 1 },
        canvas: { width: 2048, height: 1024, aspect: 2 },
        layers: [
          { id: 't1', kind: 'text', text: 'Aesop', fontFamily: 'Arial', fontSize: 80, fontWeight: 400, letterSpacing: 0, lineHeight: 1.2, color: '#000000', align: 'left', italic: false, x: 100, y: 100, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 1, craft: [] },
          { id: 's1', kind: 'shape', shape: 'rectangle', width: 300, height: 80, fill: '#000000', stroke: '#000000', strokeWidth: 0, cornerRadius: 0, x: 100, y: 100, rotation: 0, opacity: 1, visible: true, locked: false, zIndex: 0, craft: [] },
        ],
        globalCraft: { craft: [] }, fonts: [], referenceVisible: false,
      }],
    })
    expect(project.version).toBe(3)
    expect(project.areas[0].layers[0]).toMatchObject({ kind: 'text', fontFamily: 'arial' })
    expect(project.areas[0].layers[1]).toMatchObject({ kind: 'shape', shape: 'rectangle', geometry: {} })
  })

  it('does not serialize undo history or runtime reference URLs', () => {
    const output = serializeLabelProject('bottle.glb', [makeArea()])
    expect(JSON.stringify(output)).not.toContain('undoStack')
    expect(JSON.stringify(output)).not.toContain('referenceUrl')
  })
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `pnpm vitest run tests/projectSchema.test.ts`  
Expected: FAIL because `src/app/projectSchema.ts` does not exist.

- [ ] **Step 3: Add the versioned schema and migration boundary**

Implement the public project shape in `src/app/projectSchema.ts`:

```ts
export const PROJECT_VERSION = 3 as const

export interface LabelProjectV3 {
  version: typeof PROJECT_VERSION
  modelFileName: string
  areas: Array<Omit<LabelAreaConfig, 'undoStack' | 'redoStack' | 'referenceUrl'>>
}

export function parseLabelProject(raw: unknown): LabelProjectV3
export function serializeLabelProject(modelFileName: string, areas: LabelAreaConfig[]): LabelProjectV3
```

Reject prototype-pollution keys, require versions 1–3, normalize absent paper to transparent behavior, normalize a legacy rectangle to `geometry: {}`, and map legacy font display names through `legacyFontId()` from Task 2. Keep runtime GLB restoration in `projectImportRuntime.ts`.

- [ ] **Step 4: Route import/export through the schema**

Replace the inline version checks and mapping in `src/app/actions.ts` with:

```ts
const project = serializeLabelProject(ms.modelName, ls.areas)
const parsed = parseLabelProject(JSON.parse(String(reader.result)))
```

Keep the existing requirement that a GLB must be loaded before importing `.lbl` data.

- [ ] **Step 5: Run migration and round-trip tests**

Run: `pnpm vitest run tests/projectSchema.test.ts tests/export-roundtrip.test.ts`  
Expected: PASS, including version-1 and version-2 fixtures.

- [ ] **Step 6: Record checkpoint evidence**

Run: `pnpm build`  
Expected: TypeScript and Vite build pass. No commit is created because this workspace is not a Git worktree.

---

### Task 2: Build the 60-font catalog and local font runtime

**Files:**
- Create: `src/label/fontCatalog.ts`
- Create: `src/label/fontRuntime.ts`
- Modify: `src/label/fonts.ts`
- Modify: `src/label/types.ts`
- Create: `tests/fontCatalog.test.ts`
- Create: `tests/fontRuntime.test.ts`
- Create/Add: `public/fonts/**`

**Interfaces:**
- Produces: `FontCategory`, `FontCatalogEntry`, `FONT_CATALOG`
- Produces: `legacyFontId(name: string): string`
- Produces: `fontEntry(id: string): FontCatalogEntry | null`
- Produces: `searchFonts(query: string, category?: FontCategory): FontCatalogEntry[]`
- Produces: `ensureFontLoaded(id: string, weight: number, style: 'normal' | 'italic'): Promise<FontLoadResult>`
- Produces: `waitForDesignFonts(layers: LabelLayer[], uploaded: UploadedFontRecord[]): Promise<FontLoadReport>`
- Produces: `fontCssFor(ref: string, uploaded: UploadedFontRecord[]): string`

- [ ] **Step 1: Write catalog-count, category, mapping, and loading tests**

```ts
import { describe, expect, it } from 'vitest'
import { FONT_CATALOG, legacyFontId, searchFonts } from '../src/label/fontCatalog'

describe('font catalog', () => {
  it('contains exactly 60 unique curated families', () => {
    expect(FONT_CATALOG).toHaveLength(60)
    expect(new Set(FONT_CATALOG.map((font) => font.id)).size).toBe(60)
  })

  it('maps old saved names to stable ids', () => {
    expect(legacyFontId('Arial')).toBe('arial')
    expect(legacyFontId('系统默认')).toBe('system-sans')
    expect(legacyFontId('PingFang SC')).toBe('pingfang-sc')
  })

  it('searches by display name, family, and category', () => {
    expect(searchFonts('playfair').map((font) => font.id)).toContain('playfair-display')
    expect(searchFonts('', 'chinese')).toHaveLength(12)
  })
})
```

Mock `FontFace` and `document.fonts` in `tests/fontRuntime.test.ts`, then assert deduplicated concurrent loads, a failed result for missing assets, and an unavailable-font list from `waitForDesignFonts`.

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm vitest run tests/fontCatalog.test.ts tests/fontRuntime.test.ts`  
Expected: FAIL because the catalog and runtime modules do not exist.

- [ ] **Step 3: Define the catalog contract and all 60 stable ids**

Use these categories and families in `FONT_CATALOG`:

```ts
export type FontCategory = 'chinese' | 'sans' | 'serif' | 'display' | 'handwriting' | 'mono'

export interface FontCatalogEntry {
  id: string
  name: string
  family: string
  category: FontCategory
  languages: Array<'zh-Hans' | 'zh-Hant' | 'latin'>
  weights: number[]
  styles: Array<'normal' | 'italic'>
  files: Partial<Record<`${number}-${'normal' | 'italic'}`, string>>
  license: { name: string; path: string }
  fallback: string
}
```

Curated families:

- Chinese (12): Noto Sans SC, Noto Serif SC, Source Han Sans SC, Source Han Serif SC, LXGW WenKai, ZCOOL QingKe HuangYou, ZCOOL XiaoWei, Ma Shan Zheng, Long Cang, Liu Jian Mao Cao, Zhi Mang Xing, Noto Sans TC.
- Sans (16): Inter, Montserrat, Roboto, Open Sans, Lato, Poppins, Manrope, DM Sans, Nunito Sans, Work Sans, Raleway, Urbanist, Outfit, Figtree, Source Sans 3, IBM Plex Sans.
- Serif (12): Playfair Display, Cormorant Garamond, Libre Baskerville, Lora, Merriweather, EB Garamond, DM Serif Display, Bodoni Moda, Prata, Cinzel, Spectral, Source Serif 4.
- Display (10): Oswald, Bebas Neue, Roboto Condensed, Archivo Narrow, Barlow Condensed, Anton, Fjalla One, Teko, Staatliches, League Gothic.
- Handwriting (6): Caveat, Dancing Script, Pacifico, Sacramento, Great Vibes, Satisfy.
- Mono (4): IBM Plex Mono, JetBrains Mono, Space Mono, Roboto Mono.

Add actual WOFF2 and license files at the manifest paths. Do not expose a font entry until its normal 400 asset exists; families without a requested weight resolve to their nearest catalog weight.

- [ ] **Step 4: Implement cached lazy loading and deterministic fallback**

Use one promise cache per `font-id/weight/style`:

```ts
export interface FontLoadResult { id: string; ok: boolean; cssFamily: string; error?: string }
export interface FontLoadReport { ready: string[]; unavailable: string[] }

const fontLoads = new Map<string, Promise<FontLoadResult>>()
```

Register `FontFace` under a deterministic internal family such as `__catalog_inter`. Await both `face.load()` and `document.fonts.ready`. Preserve the current uploaded-font `dataUrl` path and keep uploaded names namespaced as `upload:<sanitized-name>`.

- [ ] **Step 5: Verify every manifest path and license path**

Run a Node script from the test that resolves `public${entry.files[key]}` and `public${entry.license.path}` for every entry.  
Expected: no missing files, 60 catalog entries, and no duplicate family ids.

- [ ] **Step 6: Run tests and build**

Run: `pnpm vitest run tests/fontCatalog.test.ts tests/fontRuntime.test.ts tests/projectSchema.test.ts && pnpm build`  
Expected: PASS.

---

### Task 3: Implement parameterized geometry and preset factories

**Files:**
- Create: `src/label/shapeGeometry.ts`
- Create: `src/label/elementPresets.ts`
- Modify: `src/label/types.ts`
- Modify: `src/label/craft.ts`
- Create: `tests/shapeGeometry.test.ts`
- Create: `tests/elementPresets.test.ts`

**Interfaces:**
- Produces: `ShapeKind`
- Produces: `ShapeCommand = MoveTo | LineTo | BezierTo | Arc | Close`
- Produces: `normalizeShapeLayer(layer: ShapeLayer): ShapeLayer`
- Produces: `shapeCommands(layer: ShapeLayer): ShapeCommand[]`
- Produces: `traceShape(ctx: ShapeDrawingContext, layer: ShapeLayer): void`
- Produces: `ELEMENT_PRESETS: ElementPreset[]`
- Produces: `createLayerFromPreset(presetId: string, area: LabelAreaConfig): LabelLayer`

- [ ] **Step 1: Write failing geometry tests**

```ts
describe('shape geometry', () => {
  it.each(['rectangle', 'ellipse', 'triangle', 'diamond', 'polygon', 'star', 'line', 'wave', 'burst', 'cross', 'bracket', 'dot-grid', 'frame'])('%s produces finite drawing commands', (shape) => {
    const layer = makeShape({ shape })
    const commands = shapeCommands(layer)
    expect(commands.length).toBeGreaterThan(0)
    expect(JSON.stringify(commands)).not.toContain('NaN')
  })

  it('clamps unsafe polygon and star parameters', () => {
    expect(normalizeShapeLayer(makeShape({ shape: 'polygon', geometry: { sides: 1 } })).geometry).toMatchObject({ sides: 3 })
    expect(normalizeShapeLayer(makeShape({ shape: 'star', geometry: { points: 100, innerRatio: 0 } })).geometry).toMatchObject({ points: 32, innerRatio: 0.05 })
  })
})
```

In `tests/elementPresets.test.ts`, assert that every preset creates a serializable layer centered on the area, has a unique id, and uses a known shape kind.

- [ ] **Step 2: Run tests and verify they fail**

Run: `pnpm vitest run tests/shapeGeometry.test.ts tests/elementPresets.test.ts`  
Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement normalized commands for every first-release shape**

Define this union in `types.ts`:

```ts
export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'polygon' | 'star' | 'line' | 'wave' | 'burst' | 'cross' | 'bracket' | 'dot-grid' | 'frame'

export interface ShapeGeometry {
  sides?: number
  points?: number
  innerRatio?: number
  amplitude?: number
  frequency?: number
  arrowStart?: boolean
  arrowEnd?: boolean
  dash?: number[]
  inset?: number
  rows?: number
  columns?: number
  gap?: number
}
```

Keep shared position, size, fill, stroke, corner radius, opacity, locking, z-index, and craft properties on `ShapeLayer`. Generate commands in local coordinates centered at `(0, 0)` so Konva preview and mask rendering share identical geometry.

- [ ] **Step 4: Add curated presets as editable native layers**

Define `ElementPreset` with `id`, Chinese name, category, thumbnail kind, and a factory patch. Include all spec categories: title/body/vertical text, eight basic shapes, six line styles, six label components, six decorations, and three containers. A preset only initializes values; it must not store the preset name as rendering state.

- [ ] **Step 5: Run focused tests and serialization regression**

Run: `pnpm vitest run tests/shapeGeometry.test.ts tests/elementPresets.test.ts tests/projectSchema.test.ts tests/craft.test.ts`  
Expected: PASS.

---

### Task 4: Render every shape consistently in 2D, craft masks, and export

**Files:**
- Modify: `src/label/LabelCanvas.tsx`
- Modify: `src/label/craft.ts`
- Modify: `tests/renderingFidelity.test.ts`
- Modify: `tests/craft.test.ts`

**Interfaces:**
- Consumes: `traceShape`, `shapeCommands`, and normalized `ShapeLayer` from Task 3.
- Produces: `drawShapeMask(ctx, layer, gray, mode)` using the same geometry commands as the visible preview.
- Produces: Konva `Shape` rendering for non-rectangle geometry and optimized `Rect`/`Ellipse` paths where fidelity is identical.

- [ ] **Step 1: Add failing preview/mask parity tests**

Add a recording drawing context that captures `moveTo`, `lineTo`, `bezierCurveTo`, `arc`, and `closePath`. Assert the visible helper and mask helper consume the same command list for star, wave, frame, dot-grid, and line presets. Add a regression that a legacy rectangle still produces the current width, height, corner radius, fill, and stroke.

- [ ] **Step 2: Run focused tests**

Run: `pnpm vitest run tests/renderingFidelity.test.ts tests/craft.test.ts`  
Expected: FAIL on missing generic shape drawing.

- [ ] **Step 3: Replace rectangle-only mask drawing**

Remove `drawRectangleMaskShape` and call:

```ts
function drawShapeMask(ctx: CanvasRenderingContext2D, layer: ShapeLayer, gray: number, mode: MaskDrawMode): void {
  ctx.save()
  ctx.translate(layer.x, layer.y)
  ctx.rotate((layer.rotation * Math.PI) / 180)
  ctx.beginPath()
  traceShape(ctx, layer)
  ctx.fillStyle = `rgb(${gray},${gray},${gray})`
  ctx.strokeStyle = ctx.fillStyle
  ctx.lineWidth = Math.max(1, layer.strokeWidth)
  if (mode === 'stroke') ctx.stroke()
  else ctx.fill()
  ctx.restore()
}
```

Handle open line paths by stroking even in fill-mask mode, and render dot-grid as repeated closed circles.

- [ ] **Step 4: Render generic shapes with a shared Konva scene function**

Use `Shape` from `react-konva`; apply the same commands to `context`, then fill/stroke through the Konva shape API. Preserve emboss, deboss, foil, opacity, locking, drag, and Transformer behavior.

- [ ] **Step 5: Run render, export, and build regressions**

Run: `pnpm vitest run tests/renderingFidelity.test.ts tests/craft.test.ts tests/export-roundtrip.test.ts && pnpm build`  
Expected: PASS with no rectangle regression.

---

### Task 5: Add multi-selection and deterministic alignment helpers

**Files:**
- Create: `src/label/selection.ts`
- Modify: `src/state/stores.ts`
- Modify: `src/label/LabelCanvas.tsx`
- Modify: `src/app/actions.ts`
- Create: `tests/selection.test.ts`

**Interfaces:**
- Produces: `selectedLayerIds: string[]`
- Produces: `selectLayers(ids: string[])`, `toggleLayerSelection(id: string)`, `clearLayerSelection()`
- Produces: `alignLayers(layers, ids, mode): LabelLayer[]`
- Produces: `distributeLayers(layers, ids, axis): LabelLayer[]`
- Produces: `nudgeLayers(layers, ids, dx, dy): LabelLayer[]`

- [ ] **Step 1: Write failing selection-helper tests**

```ts
it('aligns selected layers without changing unselected layers', () => {
  const next = alignLayers(layers, ['a', 'b'], 'left')
  expect(next.find((layer) => layer.id === 'a')!.x).toBe(next.find((layer) => layer.id === 'b')!.x)
  expect(next.find((layer) => layer.id === 'c')).toEqual(layers[2])
})

it('distributes three layers by horizontal centers', () => {
  const next = distributeLayers(layers, ['a', 'b', 'c'], 'horizontal')
  expect(centerGap(next, 'a', 'b')).toBeCloseTo(centerGap(next, 'b', 'c'))
})
```

- [ ] **Step 2: Run the focused test**

Run: `pnpm vitest run tests/selection.test.ts`  
Expected: FAIL because `selection.ts` does not exist.

- [ ] **Step 3: Replace single selection state**

Use only `selectedLayerIds` as the source of truth. A single-selection consumer obtains `selectedLayerIds[0] ?? null`; do not keep two independently mutable selection fields. Clear selection when changing areas and remove deleted ids atomically.

- [ ] **Step 4: Connect Shift-click, Transformer nodes, and keyboard nudging**

- Plain click replaces selection.
- Shift-click toggles one layer.
- Clicking empty canvas clears selection.
- Arrow keys nudge one canvas pixel; Shift+Arrow nudges ten pixels.
- Delete removes all selected unlocked layers.
- Cmd/Ctrl+D duplicates all selected layers and selects the copies.
- Transformer receives all selected unlocked Konva nodes and commits one history snapshot per completed group transform.

- [ ] **Step 5: Run selection and store regressions**

Run: `pnpm vitest run tests/selection.test.ts tests/projectSchema.test.ts tests/renderingFidelity.test.ts`  
Expected: PASS.

---

### Task 6: Split the left sidebar into label and model workspaces

**Files:**
- Create: `src/ui/icons.tsx`
- Create: `src/ui/EditorSidebar.tsx`
- Create: `src/ui/LabelWorkspace.tsx`
- Create: `src/ui/ModelPartTree.tsx`
- Create: `src/ui/ElementLibrary.tsx`
- Modify: `src/state/stores.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/ui/Toolbar.tsx`
- Modify: `src/ui/Panels.tsx`
- Create: `tests/uiStore.test.ts`

**Interfaces:**
- Consumes: `ELEMENT_PRESETS`, `createLayerFromPreset`, and multi-selection state.
- Produces: `workspaceTab: 'labels' | 'model'`
- Produces: `setWorkspaceTab(tab)`
- Produces: `<EditorSidebar />`, `<LabelWorkspace />`, `<ModelPartTree />`, `<ElementLibrary />`

- [ ] **Step 1: Write failing UI-state tests**

Reset the Zustand store between tests and assert:

```ts
expect(useUiStore.getState().workspaceTab).toBe('model')
useUiStore.getState().setWorkspaceTab('labels')
expect(useUiStore.getState().workspaceTab).toBe('labels')
```

Also assert that activating or creating an area switches to `labels`, while loading a model with no active area keeps `model` selected.

- [ ] **Step 2: Run the store test**

Run: `pnpm vitest run tests/uiStore.test.ts`  
Expected: FAIL because `workspaceTab` is missing.

- [ ] **Step 3: Extract shared icons and model-only tree**

Move `Icon` to `src/ui/icons.tsx`. Move the current part filtering, hierarchy, visibility, material tooltip, triangles, and area badges into `ModelPartTree.tsx`. Remove the separate area list from the model tree.

- [ ] **Step 4: Build the label workspace**

Render the current area selector, `添加元素`, layer rows, and a compact footer action bar. Each layer row permanently shows type/name, craft marker, visibility, and lock; move duplicate/delete/order actions to the row menu or footer. Keep area delete in the area menu and require confirmation only when the region contains design layers.

- [ ] **Step 5: Connect the element library**

Render category tabs and searchable preset tiles from `ELEMENT_PRESETS`. On preset click:

```ts
const layer = createLayerFromPreset(preset.id, area)
applyAreaOp(area.id, (cfg) => ({ ...cfg, layers: [...cfg.layers, layer] }))
selectLayers([layer.id])
```

Disable the action and show the model-tab guidance when no area exists.

- [ ] **Step 6: Replace `<PartTree />` in `App.tsx`**

Use `<EditorSidebar />`; switch to the model tab when a user starts area creation and to the label tab when an area becomes active. Leave a temporary compatibility export from `Panels.tsx` only until all imports are migrated.

- [ ] **Step 7: Run store, model, and build checks**

Run: `pnpm vitest run tests/uiStore.test.ts tests/modelLoader.test.ts tests/labelCandidate.test.ts && pnpm build`  
Expected: PASS.

---

### Task 7: Build the contextual inspector and font browser

**Files:**
- Create: `src/ui/FontBrowser.tsx`
- Create: `src/ui/Inspector.tsx`
- Create: `src/ui/InspectorSection.tsx`
- Create: `src/ui/inspectors/TextInspector.tsx`
- Create: `src/ui/inspectors/ShapeInspector.tsx`
- Create: `src/ui/inspectors/ImageInspector.tsx`
- Create: `src/ui/inspectors/AreaInspector.tsx`
- Create: `src/ui/inspectors/MultiSelectionInspector.tsx`
- Modify: `src/ui/Panels.tsx`
- Modify: `src/state/stores.ts`
- Modify: `src/app/App.tsx`

**Interfaces:**
- Consumes: font catalog/runtime, shape geometry, selection helpers, and `CraftEditor`.
- Produces: `<Inspector />` as the only right-panel entry.
- Produces: UI-only `favoriteFontIds`, `recentFontIds`, `inspectorSections` state.

- [ ] **Step 1: Add font preference state tests**

Extend `tests/uiStore.test.ts` to assert favorite toggling is idempotent, recent fonts are deduplicated and capped at 8, and inspector section state is stored per object type without entering the label undo stack.

- [ ] **Step 2: Implement accessible reusable sections**

`InspectorSection` uses a real button with `aria-expanded`, a labelled region, and persisted open state. Defaults: content/typography/geometry/transform open; craft/advanced closed.

- [ ] **Step 3: Implement the font browser**

The trigger shows current font name and sample. The popover contains search, category chips, favorites, recent fonts, virtualized or capped visible rows, live sample text, coverage badges, and load state. Selecting a font first calls `ensureFontLoaded`; on success it patches `fontFamily`, on failure it keeps the old font and exposes the error.

- [ ] **Step 4: Split object-specific property editors**

Move current text, image, shape, paper, area, transform, and craft controls out of `Panels.tsx`. Preserve all existing functional fields, then add shape-specific parameters and ratio lock. Use a sticky inspector header with object name, visibility, lock, duplicate, and delete actions.

- [ ] **Step 5: Add multi-selection inspector actions**

Expose left/center/right, top/middle/bottom, horizontal/vertical distribution, common opacity, lock, and delete. Disable distribution with fewer than three selected objects. Execute every bulk change through one `applyAreaOp` call.

- [ ] **Step 6: Route context through one inspector**

Priority order:

1. selected unbound model mesh → model summary/create area;
2. more than one selected label layer → multi-selection;
3. one selected label layer → kind-specific inspector;
4. active area and no layer → area inspector;
5. nothing loaded → guided empty state.

- [ ] **Step 7: Run the full unit suite and build**

Run: `pnpm test && pnpm build`  
Expected: all existing and new tests pass.

---

### Task 8: Move 3D out of properties and add central view modes

**Files:**
- Create: `src/ui/ViewModeSwitch.tsx`
- Modify: `src/state/stores.ts`
- Modify: `src/app/App.tsx`
- Modify: `src/ui/Toolbar.tsx`
- Modify: `src/app/canvasLayout.ts`
- Modify: `tests/canvasLayout.test.ts`
- Modify: `tests/uiStore.test.ts`

**Interfaces:**
- Produces: `editorViewMode: '2d' | 'split' | '3d'`
- Produces: `setEditorViewMode(mode)`
- Produces: `<ViewModeSwitch />`
- Consumes: existing `<LabelCanvas />` and `<Viewport />` without duplicating design state.

- [ ] **Step 1: Add failing view-mode and split-layout tests**

Assert the default for an active area is `2d`, switching modes preserves `selectedLayerIds`, and `fitCanvasDisplayWidth` returns a valid canvas size when the 2D pane receives 65% of the central width.

- [ ] **Step 2: Run tests and verify failure**

Run: `pnpm vitest run tests/uiStore.test.ts tests/canvasLayout.test.ts`  
Expected: FAIL on missing `editorViewMode`.

- [ ] **Step 3: Add the segmented view control**

Use three buttons with `aria-pressed`, exact labels `2D 设计`, `2D + 3D`, and `3D 预览`, plus keyboard left/right navigation.

- [ ] **Step 4: Refactor the central workspace**

- `2d`: render only `CanvasHost`.
- `split`: render a resizable 65/35 horizontal split with `CanvasHost` and `Viewport showFrontMarker`.
- `3d`: render a full `Viewport` without the editing front marker.

Remove `.preview3d` and the embedded `<Viewport />` from the right panel. The right side always renders `<Inspector />`.

- [ ] **Step 5: Remove the old binary view toggle**

Keep `mode` only for the separate area-setup flow until that flow is migrated; the editor itself derives its central content from `editorViewMode`.

- [ ] **Step 6: Run layout and full regression checks**

Run: `pnpm vitest run tests/uiStore.test.ts tests/canvasLayout.test.ts tests/sceneTexture.test.ts tests/visibility.test.ts && pnpm build`  
Expected: PASS.

---

### Task 9: Apply the light visual system to 2D and 3D

**Files:**
- Modify: `src/app/styles.css`
- Modify: `src/app/AreaPicker.tsx`
- Modify: `src/scene/SceneController.ts`
- Modify: `src/label/LabelCanvas.tsx`
- Modify: `tests/sceneTexture.test.ts`

**Interfaces:**
- Produces: semantic light CSS tokens used by all editor components.
- Preserves: transparent label output and local RoomEnvironment reflections.

- [ ] **Step 1: Add a scene-style regression seam**

Extract and test:

```ts
export const LIGHT_STUDIO = {
  background: 0xeef1f4,
  gridCenter: 0xaeb7c4,
  gridLine: 0xd7dce3,
  outline: 0x356ae6,
} as const
```

Verify `configureLabelMaterial` still uses transparent color textures and no opaque default material is introduced.

- [ ] **Step 2: Replace root color tokens and component states**

Set the exact global constraint colors, then style tabs, layer rows, popovers, inspectors, inputs, focus rings, empty states, split divider, and view switch. Use shadows only on menus/popovers/drag previews. Remove dark hard-coded colors from `AreaPicker` and the canvas checkerboard.

- [ ] **Step 3: Configure a light studio without losing model detail**

Set `scene.background` to `LIGHT_STUDIO.background`, keep PMREM environment reflections, use a neutral hemisphere ground color, adjust key/rim lighting for white and amber models, use the light grid colors, and change selection outline from yellow to the single blue accent. Do not remove normal maps, bump maps, clearcoat, or source GLB materials.

- [ ] **Step 4: Add reduced-motion and focus rules**

All interactive transitions use opacity or transform. Under `@media (prefers-reduced-motion: reduce)`, set transition and animation durations to zero. Add `:focus-visible` outlines with `#356AE6` and at least 2px visible separation.

- [ ] **Step 5: Run scene, paper, visibility, and build regressions**

Run: `pnpm vitest run tests/sceneTexture.test.ts tests/labelPaper.test.ts tests/visibility.test.ts tests/renderingFidelity.test.ts && pnpm build`  
Expected: PASS.

---

### Task 10: Gate exports on fonts and complete end-to-end visual QA

**Files:**
- Modify: `src/app/actions.ts`
- Modify: `src/label/LabelCanvas.tsx`
- Modify: `tests/fontRuntime.test.ts`
- Create: `output/playwright/workspace-redesign/**` during QA only

**Interfaces:**
- Consumes: `waitForDesignFonts` from Task 2.
- Produces: export failure messages listing unavailable font display names.
- Produces: browser QA evidence at 1280×720, 1440×900, and 1920×1080.

- [ ] **Step 1: Add failing export-barrier tests**

Mock one successful and one failed catalog font. Assert PNG and GLB preparation do not begin while fonts are pending and fail with `字体尚未就绪：<name>` when a used font cannot load. Assert unused catalog fonts never block export.

- [ ] **Step 2: Add the export barrier**

At the start of PNG and GLB export:

```ts
const report = await waitForDesignFonts(activeAreas.flatMap((area) => area.layers), activeAreas.flatMap((area) => area.fonts))
if (report.unavailable.length > 0) throw new Error(`字体尚未就绪：${report.unavailable.join('、')}`)
```

After fonts become ready, force a Canvas draw and wait for the next completed bake version before reading the color canvas.

- [ ] **Step 3: Run the entire automated suite**

Run: `pnpm test`  
Expected: every test file passes with zero unhandled errors.

- [ ] **Step 4: Run the production build**

Run: `pnpm build`  
Expected: TypeScript and Vite complete successfully; note generated JS, CSS, and font asset sizes separately.

- [ ] **Step 5: Execute the E2E workflow with the supplied serum GLB**

Use `/Users/apple/realibox/cosmetic-bottles-glb/10_treatment_serum_dropper.glb`:

1. Open the GLB.
2. Verify the default sidebar tab and switch between `贴标` and `模型`.
3. Create or activate the bottle label area.
4. Add a Chinese text preset, a Playfair Display text layer, a frame, a line, a badge, a star, and an uploaded image.
5. Use Shift-click multi-select, align, distribute, duplicate, lock, and undo/redo.
6. Switch through all three central view modes.
7. Save and re-import the version-3 `.lbl` project.
8. Export PNG and GLB.
9. Parse the GLB and verify original model nodes/material details remain present.
10. Confirm browser console has zero errors.

- [ ] **Step 6: Capture and inspect visual evidence**

Capture full-editor screenshots at:

- `output/playwright/workspace-redesign/1280x720-labels.png`
- `output/playwright/workspace-redesign/1440x900-fonts.png`
- `output/playwright/workspace-redesign/1440x900-elements.png`
- `output/playwright/workspace-redesign/1440x900-split.png`
- `output/playwright/workspace-redesign/1920x1080-3d.png`

Inspect each image for overflow, clipped popovers, dark remnants, weak focus/selection states, white-label-background regression, distorted geometry, mirrored text, and loss of 3D surface detail.

- [ ] **Step 7: Record final evidence**

Record test counts, build output, console error count, exported PNG dimensions, exported GLB parse result, and screenshot paths. Do not describe a check as passed unless its command or browser evidence was captured in this task.

---

## Self-Review Results

- Spec coverage: font catalog/runtime, geometry/presets, sidebar separation, contextual inspector, multi-selection, central view modes, light theme, migration, error handling, export barriers, E2E, and visual QA each map to Tasks 1–10.
- Dependency order: migrations and domain contracts precede rendering; rendering and selection precede UI; UI precedes theme and final E2E.
- Type consistency: `fontFamily` remains the serialized stable font reference; `selectedLayerIds` is the sole selection source; `editorViewMode` is independent from the area-setup `mode`; shape rendering and masks both consume `traceShape`.
- Placeholder scan: no deferred implementation markers are used. Arc text, docking, general SVG editing, and online font commerce remain explicit non-goals from the approved spec.
- Repository constraint: every task ends with tests/build evidence because the current workspace has no Git metadata.
