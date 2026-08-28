# GLB Label Editor Codex Plugin

[English](README.md) | **简体中文** | [日本語](README.ja.md) | [Français](README.fr.md)

GLB Label Editor 帮助品牌、包装设计与电商内容团队，把已有的美妆包装 GLB 快速变成可评审、可修改、可交付的标签方案。即使手上只有瓶器模型、文案、Logo 和基础品牌规范，也可以让 Codex 完成贴标区域识别、正背标排版、效果预览和最终资产整理。

它适合新品上市前的包装提案、现有包装改版、不同香型或容量的 SKU 延展、多语言标签制作、法规与成分文案更新、正标与背标的版本对比，以及面向客户和内部团队的快速评审。对于已有 3D 包装资产，也可以直接补充环绕标、颈标、透明贴纸、烫金、击凸、磨砂和局部 UV 等视觉效果，不必先重新制作整套模型。

制作过程中会自动打开 Web 实时预览，设计每次更新都会反映在同一个页面中，方便用户边看边确认。完成后可获得贴标后的 GLB、可继续编辑的项目、3D 预览图、各贴标面的图片与 PBR 通道，以及用于检查印刷规格和资产完整性的清单。

## 一条命令安装到 Codex

```bash
commit="$(node --input-type=module -e 'const response = await fetch("https://api.github.com/repos/rendylong/label-editer/commits/main"); if (!response.ok) throw new Error("GitHub returned " + response.status); process.stdout.write((await response.json()).sha)')" &&
npx --yes --package="https://github.com/rendylong/label-editer/archive/$commit.tar.gz" glb-label-editor-install
```

只要求预先安装 Node.js 22+ 和 Codex CLI。命令会先把 `main` 解析为不可变的 commit，再调用 `npx`，避免新版本继续复用旧安装器缓存。安装器会通过 Node.js 自带的 npm 安装锁定依赖和 Playwright Chromium、构建编辑器，并将可运行插件安装到 `~/.codex/glb-label-editor`。它随后会添加 `label-editer` marketplace，安装并启用 `glb-label-editor@label-editer`。

Python 3 是可选依赖，仅在运行随附的 cosmetic-label 知识查询脚本 [`skills/cosmetic-label/scripts/query_labels.py`](skills/cosmetic-label/scripts/query_labels.py) 时需要。插件的核心安装、启动、检查、校验、review、QC、apply 和 export 流程不依赖 Python。

安装或更新插件后，请新建 Codex 会话，使 Skill 重新加载。可以用下面的命令确认插件状态：

```bash
codex plugin list --json
codex mcp list --json
```

插件应处于已安装且已启用状态，同时 MCP 列表中不得出现 `glb-label-editor`。

安装后的本地 CLI 启动器位于 `~/.codex/glb-label-editor/plugin/bin/label-cli.mjs`。安装器会实际执行一次 `schema --json` 验证启动器，而不会生成 MCP 配置。

希望让 Agent 代为安装时，直接复制 [`INSTALL_WITH_AGENT.md`](INSTALL_WITH_AGENT.md) 中的 Prompt。安装器不会执行 `curl | sh`，且只管理 `~/.codex/glb-label-editor`。

## 本地开发

```bash
pnpm install
pnpm exec playwright install chromium
pnpm build
```

仓库自带的开发 marketplace 名为 `label-editer-dev`：

```bash
codex plugin marketplace add /absolute/path/to/label-editer
codex plugin add glb-label-editor@label-editer-dev
```

插件清单位于 [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json)。插件安装时会同时安装 [`cosmetic-label`](skills/cosmetic-label/SKILL.md) 和 [`cosmetic-label-editor`](skills/cosmetic-label-editor/SKILL.md)，并生成指向受管理 runtime 的本地 CLI 启动器。

## 审批绑定工作流

固定顺序仍为 `$cosmetic-label` → `$cosmetic-label-editor`，并包含两道与 revision 绑定的审批门：

1. 先选择并记录 carrier，再发展视觉方向。若由 Agent 推断，需记录依据、一个可行备选及其取舍，并公开材料与供应商能力假设。
2. 先生成可编辑的 `layout-blueprint.json`，再从该蓝图派生正/背 mockup 与干净的设计评审证据。蓝图是唯一设计事实源；参考 HTML、图片与 PDF 仅是不执行的视觉/内容证据。
3. 设计审批只能绑定精确的 blueprint revision、blueprint SHA-256 与 design-review manifest SHA-256。等待审批、有 blocker、过期、缺失或 digest 不一致的设计门不得进入制作。
4. `$cosmetic-label-editor` 检查 GLB、解析精确稳定目标、翻译已审批蓝图，并在应用或编辑已审批设计期间始终保持可见的 `live` 预览。
5. 为当前 working revision 运行干净的制作 `review` 证据；图片不得包含网格、选区、变换控件、区域/调试标记或诊断通道。
6. 制作审批只能绑定精确的当前 review manifest、输入 revision/digest、蓝图/design-review digest、模型 fingerprint 与映射区域绑定 digest。
7. 使用诊断 `qc` 做检查和有上限的修复取证。QC 不能替代干净 review 或任一道审批门；可见修复需按变更范围重新 review 和审批。
8. 只有当前审批、校验、QC 与输出交叉检查全部通过，才可 apply 或 export 当前 revision。

Carrier 与 process 是两个不同维度。`direct_surface_print`、`in_mold`、`foil_or_ink_only`、`clear_label` 和 `bare` 都不隐含纸张面板；`applied_label` 必须显式记录 substrate。烫金、油墨、白墨底、光油、击凸等属于图层 process，不是 carrier 的别名。

`continuous_authorized` 必须由用户针对当前任务明确授权。它只移除等待，不会移除校验、披露、证据采集、两道审批记录、新鲜度检查、QC、修复上限或交付检查。紧急、沉默、历史任务和旧 `assumed_for_fast_run` 状态都不构成授权。

若不支持的效果必须使用 flattened fallback，仅可在用户明确接受后继续，并需列明不可编辑图层和文字、丢失或近似的分色，以及更高保真矢量替代方案。不得把扁平化图稿描述为完全可编辑。

设计阶段不猜 mesh、`stableSelector` 或 UV；制作阶段不擅自重做品牌、文案、字体、颜色、carrier、process 或内容层级。Handoff v2 合约位于 [`skills/cosmetic-label/references/editor_handoff.md`](skills/cosmetic-label/references/editor_handoff.md)。

## Agent 控制面

| CLI 命令 | 用途 | 是否写文件 |
| --- | --- | --- |
| `inspect` | 检查 GLB、列出稳定 mesh selector、候选贴标面、尺寸与 codec 状态 | 否 |
| `project` | 读取 Label Spec v2 / Label Project v3，返回稳定 ID、完整值和 SHA-256 revision | 否 |
| `patch` | 按 area/layer ID 原子应用一组 revision-guarded 操作 | 是 |
| `validate` | 校验 Label Spec、资源、目标与设计/印刷问题 | 否 |
| `live` | 自动打开只读 Web 预览并持续监听同一 working spec | 否 |
| `preview` | 生成供 Agent 视觉检查的 PNG | 是 |
| `review` | 生成与审批绑定的干净平面图稿和上模证据 | 是 |
| `qc` | 生成用于检查与修复的诊断多视角证据 | 是 |
| `apply` / `export` | 烘焙、GLB 交叉校验并完整发布产物 | 是 |
| `open` | 显式人工接管，返回本机令牌化可编辑 URL | 否 |

规范顺序是 carrier 决策 → blueprint/mockup → 设计审批 → `inspect` → 创建/校验 working spec → `live` → `project` / `patch --force` 循环 → `validate` → 干净 `review` → 制作审批 → 诊断 `qc` / 修复 / 重拍 → `apply` 或 `export`。不要根据相似节点名猜目标；使用检查结果中的 `stableSelector`。`open` 不属于默认 Agent 工作流。

## CLI

所有命令都返回统一 Agent envelope。使用 `--json` 时，stdout 只写一条 JSON；进度与诊断写 stderr。

安装插件后，应显式使用 `node ~/.codex/glb-label-editor/plugin/bin/label-cli.mjs ...` 调用启动器；安装器不会把 `label-cli` 命令加入 `PATH` 或 npm `.bin`。下面代码块中的示例从仓库 checkout 运行，因此统一使用 `node scripts/label-cli.mjs ...`。

```bash
# 获取完整 Label Spec v2 JSON Schema
node scripts/label-cli.mjs schema --json

# 检查模型和候选贴标区域
node scripts/label-cli.mjs inspect model.glb --json

# 检查 working spec，获取稳定 id 和 revision
node scripts/label-cli.mjs project spec.json --json

# 用 project 返回的 revision 构造 operations.json，然后原子更新同一 working spec
node scripts/label-cli.mjs patch spec.json \
  --operations operations.json --output spec.json --force --json

# 仅校验规格；增加 --glb 可同时验证模型目标
node scripts/label-cli.mjs validate spec.json --glb model.glb --json

# 自动打开可见的只读 Web 实时预览，并保持前台运行直到收到信号
node scripts/label-cli.mjs live spec.json --glb model.glb --json

# 为精确的当前 revision 生成干净制作审批证据
node scripts/label-cli.mjs review working-label-spec.json \
  --glb package.glb \
  --output production-review/revision-003 \
  --width 1600 \
  --height 1600 \
  --json

# 为当前 working revision 生成标准诊断 QC 证据集
node scripts/label-cli.mjs qc working-label-spec.json \
  --glb package.glb \
  --output label-qc/round-0 \
  --preset qc-standard \
  --json

# 应用设计并发布完整目录
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --json

# 已明确允许覆盖交付目录时使用 --force；--open 只用于显式人工接管
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --force --open --json

# 输出单个预览文件
node scripts/label-cli.mjs preview spec.json \
  --glb model.glb --output preview.png --view 3d --json

# 从可编辑项目再次导出
node scripts/label-cli.mjs export result/project.lbl.json \
  --glb model.glb --output exported --json

# 保持本地会话运行，直到 Ctrl+C
node scripts/label-cli.mjs open spec.json --glb model.glb
```

退出码：`0` 成功；`2` 参数错误；`3` 路径越界；`4` Label Spec/项目无效；`5` 目标缺失或有歧义；`6` 浏览器不可用；`7` GLB 重建失败；`8` codec 不支持；`9` 输出冲突；`10` revision 冲突；`11` patch 操作无效；`1` 其他内部错误。

## 干净制作评审证据

安装后插件的精确命令格式为：

```bash
node ~/.codex/glb-label-editor/plugin/bin/label-cli.mjs review <spec-or-project.json> \
  --glb <model.glb> \
  --output <new-immutable-directory> \
  --width <1-4096> \
  --height <1-4096> \
  --json
```

`--glb` 与 `--output` 必填；宽高默认均为 1600，可分别设置为 1 到 4096。正常流程写入新的不可变目录。`--force` 会显式替换已有目录，只用于经过明确授权的替换，而不是常规 revision 流程。

输出包括每个非 bare 区域的干净平面图稿和正视上模证据、可用的整模正/背视图、`review-sheet.png` 与 `review-manifest.json`。manifest 绑定规范输入 revision 与 SHA-256、blueprint revision 与 SHA-256、design-review manifest SHA-256、模型 fingerprint、映射区域绑定 SHA-256，以及每个产物的路径/hash/尺寸。制作审批前，以及紧邻 QC 和 apply/export 前，都必须重新读取文件并重算这些 revision、fingerprint 与 digest 绑定。缺失、过期、意外、不可读或不匹配的证据会阻断制作；旧目录的审批不会转移到新 revision。

`preview` 是供 Agent 快速推理的单图，干净 `review` 是面向用户的制作审批证据，`qc` 是诊断检查/修复证据。三者使用不同命令、目录、manifest 与审批语义。

全部控制和渲染均在本机完成。插件不提供公网 HTTPS/MCP 服务；会话级本机令牌 URL 既不是公网端点，也不是交付证据。

## 视觉 QC 证据与修复

仅在当前制作审批通过（或存在有效的当前任务 continuous-authorization 记录）后运行 `qc`，同时保持自动打开的 `live` 预览。`live` 会让同一个只读 Web 页面始终与 working spec 同步；`qc` 是一次性诊断取证命令，不会关闭、替换或另开一个实时预览页面，其通道/叠加证据也不是审批图片。

输入可以是 Label Spec v2 或 Label Project v3。`--glb` 与 `--output` 为必填项。`--preset qc-standard` 是默认且当前支持的 preset。默认截图尺寸为 1440 × 1440；`--width` 与 `--height` 接受 1 到 4096 的整数。对于特殊瓶型，可以用 `--camera-config cameras.json` 追加最多 32 个产品专用视角，但不会移除标准必拍视角。`--json` 会让 stdout 只包含一条 Agent envelope。已有输出目录默认受保护，只有显式添加 `--force` 才会替换；常规 QC 修复应新建下一轮目录，保留此前证据。

每一轮证据都是不可变目录，结构如下：

```text
label-qc/
├── round-0/
│   ├── model/
│   │   ├── model-front.png
│   │   ├── model-back.png
│   │   ├── model-left.png
│   │   ├── model-right.png
│   │   ├── model-front-right.png
│   │   └── model-back-left.png
│   ├── areas/
│   │   └── <derived-area-token>/
│   │       ├── area-<derived-area-token>-face.png
│   │       ├── area-<derived-area-token>-craft.png
│   │       └── area-<derived-area-token>-<metalness|roughness|bump>.png
│   └── qc-manifest.json
├── round-1/
└── ...
```

每轮固定包含六张整模视图，以及每个贴标区域的两张彩色近景。只有彩色 craft 视图采用斜角；所需的 Metalness、Roughness 与 Bump 诊断图均采用正视角。规范 area id 按不透明值原样保留，可以很长或包含 Unicode；文件名使用独立、确定性的 ASCII token。不要根据 area id 重建文件名，而应将 `manifest.areas[].artifactIds` 与 `manifest.artifacts[].id` 精确关联。`qc-manifest.json` 将证据绑定到规范化的输入 revision 和模型 fingerprint，记录每个区域的稳定目标与 `requiredChannels`，并保留每个文件的 `viewId`、纳入 `reason`、相对路径、SHA-256、尺寸、通道、取景方式和相机信息。它是证据元数据，不代替视觉通过/失败结论。

查看图片前，Agent 会将 `qc-manifest.json.input.revision` 与 working 文件最新的 `project` 结果比较，然后检查所有整模、区域、工艺近景与已包含的通道图。如果发现阻塞缺陷、证据不完整或 revision 不一致，Agent 会执行 revision-safe patch，等待实时预览报告新 revision 已 ready，再重新校验并写入下一轮不可变目录。`round-0` 之后最多允许三轮自动修复；仍有阻塞项时不得 apply/export 或确认交付。非阻塞 warning 必须保留在最终交接中，渲染工艺仍需要供应商实物打样确认。

## Label Spec v2

Schema 的唯一来源是 [`src/agent/label-spec-v2.schema.json`](src/agent/label-spec-v2.schema.json)，也可以通过 CLI 的 `schema` 子命令获取。真实正/背标示例见 [`tests/fixtures/specs/perfume-front-back-v2.json`](tests/fixtures/specs/perfume-front-back-v2.json)。

核心结构：

```json
{
  "version": 2,
  "assets": {
    "logo": { "path": "./logo.png", "mimeType": "image/png" }
  },
  "areas": [
    {
      "id": "front",
      "name": "正标",
      "target": { "stableSelector": "mesh:0/node:2" },
      "surfaceMode": "overlay",
      "side": "front",
      "range": { "uStart": 0.35, "uWidth": 0.3, "vStart": 0.2, "vHeight": 0.6 },
      "layers": []
    }
  ]
}
```

- `overlay` 用于瓶身直印、透明贴花和本体表面；`replace` 只用于模型中独立存在的标签 mesh。
- 支持正标、背标、侧标、圆柱环绕标、平面瓶身、管体、罐盖和颈封区域。
- 文本支持可调整文本框、自动换行、多行、RTL、语言标签、字体、字重、字距、行距、对齐、横/竖排。
- 图层支持文字、图片、基础/装饰形状、拖动排序、锁定、显隐和删除。
- 工艺支持烫金、击凸、压凹、磨砂、UV 亮油和描边，并生成 Color、Metalness、Roughness、Bump 通道。
- `print` 可记录毫米尺寸、出血、圆角、最小字高、刀模类型和专色版；问题会进入验证结果与印刷清单。

## 输出目录

一次成功的 `apply` 或 `export` 会在目标目录不存在时整体发布；中途失败不会留下半成品。默认不覆盖已有目录。

```text
result/
├── labeled.glb
├── project.lbl.json
├── label-spec.normalized.json      # 从 Label Spec 应用时生成
├── print-manifest.json
├── preview-3d.png
├── manifest.json                   # SHA-256、尺寸、验证与 GLB 交叉检查
└── areas/
    ├── front/
    │   ├── color.png
    │   ├── metalness.png
    │   ├── roughness.png
    │   └── bump.png
    └── back/
        └── ...
```

`labeled.glb` 内嵌完整 `.lbl` 项目元数据；导出的 GLB 会由 three.js 独立重解析并比对目标 mesh 与完整 UV，输入文件本身不会被修改。

## 安全边界

- 默认只允许读取/写入当前工作目录；调用方可显式增加 workspace roots。
- 远程图片和字体 URL 默认禁用；资源必须是允许根目录内的本地文件。
- 浏览器仅绑定随机端口的 `127.0.0.1`，每个会话使用随机 32 字节令牌；模型、bootstrap 和产物路由都校验令牌。
- `live` 自动启动插件自带 Chromium 的 headful 窗口；页面为只读制作预览，Agent 不需要也不得控制该页面。
- 页面 CSP 禁止 `unsafe-eval`，只允许本源脚本；仅对运行时自有的内存 GLB 开放 `blob:` 连接。
- 目录和单文件产物都采用同目录临时文件/目录后 rename 的原子发布方式；`patch` 同时锁定输入与目标文件并在锁内重读 revision，避免并发写入丢失；除非明确使用 `force`，不会覆盖已有结果。
- 返回的人工接管 URL 是短期本地能力凭证，不应发送给不受信任的第三方。

## Codec 与交付边界

- 标准 GLB 可直接处理；Draco GLB 会在 Node 运行时先解压标准化，输出当前不保留 Draco 压缩。
- `EXT_meshopt_compression` 和 `KHR_texture_basisu` 当前返回明确的 `UNSUPPORTED_CODEC`，不会静默生成不完整结果。
- 工艺是屏幕/PBR 预览和分色数据，不等于供应商实物可行性。颜色、套准、附着力、触感和刀模需要打样确认。
- 屏幕/PBR 证据不是物理制造认证或供应商证明。当前不会生成印厂可直接制版的 PDF/AI 刀模，也不替代法规、条码、宣称或供应商审核。

## 前端开发与验证

插件保留完整独立编辑器，便于开发和人工设计：

```bash
pnpm dev
pnpm test
pnpm build
GLB_LABEL_E2E_MODEL=/absolute/path/to/model.glb pnpm test:plugin-e2e
pnpm plugin:verify
```

Web 前端使用 React 19、three.js、Konva 和 `@gltf-transform`。Agent 浏览器运行时加载同一份 `dist/`，因此前端与插件不会维护两套贴标逻辑。
