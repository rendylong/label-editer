# Editor Handoff — cosmetic-label to cosmetic-label-editor

Use this contract after design is complete and before GLB production. It preserves design intent while leaving model-specific surface selection and UV mapping to `$cosmetic-label-editor`.

```yaml
handoff_version: 1
status: approved | assumed_for_fast_run
source:
  design_spec: <path or inline artifact id>
  mockup: <path or inline artifact id>
model:
  glb_path: <path if supplied>
  package_type: <bottle | jar | tube | compact | other>
design_intent:
  selected_direction: <name>
  positioning: <tier and 2-4 personality keywords>
  convention_basis: [<benchmark or category convention>]
  differentiation_axes: [layout, typography, process, content]
areas:
  - id: front
    side: front | back | left | right | wrap | top | bottom | neck | custom
    application: direct_print | paper_label | clear_label | foil_stamp | other
    placement: <human-readable placement and proportions>
    physical_size_mm: { width: <number or unknown>, height: <number or unknown> }
    shape: <rectangle | rounded_rect | oval | full_wrap | die_cut | band | other>
    layer_order:
      - <background, logo, brand, product, claim, volume, etc.>
    copy:
      - text: <exact text>
        role: <brand | product | claim | ingredient | volume | regulatory | other>
        language: <BCP-47 tag>
        writing_direction: ltr | rtl | auto
        placeholder: false
    typography:
      class: <class>
      font_preference: <family or local asset>
      weight: <weight>
      case: <case>
      letter_spacing: <value or intent>
      alignment: <alignment>
    palette:
      - { role: <ink | substrate | accent | foil>, color: <hex, Pantone, or named target> }
    processes:
      - { element: <role>, process: <screen_print | offset_print | hot_stamp_foil | emboss | deboss | other> }
assets:
  - { id: <id>, role: <logo | image | font>, path: <local path or missing> }
print_constraints:
  bleed_mm: <number or unknown>
  minimum_text_height_mm: <number or unknown>
  spot_colors: [<name>]
assumptions: [<explicit assumption>]
blockers: [<unresolved item that prevents production>]
```

Rules:

- Preserve exact supplied copy. Use explicit `PLACEHOLDER` values for missing regulatory, ingredient, barcode, batch, expiry, and origin content.
- Do not include guessed mesh selectors or UV coordinates.
- `approved` means the user selected the direction. `assumed_for_fast_run` is allowed only when the user explicitly requested an uninterrupted workflow.
- Any non-empty `blockers` list stops production. Unknown physical measurements may remain warnings if the editor can derive placement safely from the inspected GLB.
