# GLB Label Editor Codex Plugin

面向美妆包装 GLB 的 Agent 贴标插件。Codex 或其他 MCP Agent 可以检查模型、选择稳定贴标目标、应用正标/背标/环绕标设计、渲染工艺预览，并原子导出可编辑项目、PBR 通道与已贴标 GLB。需要人工调整时，可打开带会话令牌的本地可视化编辑器继续操作。

插件由三层共用同一套运行时：两个 Codex Skill 分别负责贴标设计和 GLB 制作，MCP 提供六个粗粒度工具，`label-cli` 提供可脚本化的 JSON 接口。Agent 不需要依赖 DOM 选择器操作前端。

## 一条命令安装到 Codex

```bash
npx --yes --package=github:rendylong/label-editer glb-label-editor-install
```

只要求预先安装 Node.js 22+ 和 Codex CLI。安装器会通过 Node.js 自带的 npm 安装锁定依赖和 Playwright Chromium、构建编辑器，并将可运行插件安装到 `~/.codex/glb-label-editor`。它随后会添加 `label-editer` marketplace，安装并启用 `glb-label-editor@label-editer`。

安装或更新插件后，请新建 Codex 会话，使 Skill 和 MCP 工具重新加载。可以用下面的命令确认插件状态：

```bash
codex plugin list --json
codex mcp list --json
```

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

本地开发时也可以只注册 MCP：

```bash
codex mcp add glb-label-editor -- node /absolute/path/to/glb-label-editor/scripts/mcp-server.mjs
```

插件清单位于 [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json)，MCP 配置位于 [`.mcp.json`](.mcp.json)。插件安装时会同时安装 [`cosmetic-label`](skills/cosmetic-label/SKILL.md) 和 [`cosmetic-label-editor`](skills/cosmetic-label-editor/SKILL.md)。

## 两阶段工作流

完整顺序固定为 `$cosmetic-label` → `$cosmetic-label-editor`：

1. `$cosmetic-label` 完成需求澄清、案例依据、排版/字体/工艺/内容四维设计、正背标 mockup 和 Editor Handoff。
2. 用户确认方向；若用户明确要求不中断快速执行，则交接状态标记为 `assumed_for_fast_run` 并公开全部假设。
3. `$cosmetic-label-editor` 读取交接，再检查 GLB、解析稳定 mesh、生成并校验 Label Spec v2，最后发布完整产物。

设计阶段不猜 mesh、`stableSelector` 或 UV；制作阶段不擅自重做品牌、文案、字体、颜色、工艺和内容层级。Editor Handoff 合约位于 [`skills/cosmetic-label/references/editor_handoff.md`](skills/cosmetic-label/references/editor_handoff.md)。

## Agent 工具

| MCP 工具 | 用途 | 是否写文件 |
| --- | --- | --- |
| `inspect_model` | 检查 GLB、列出稳定 mesh selector、候选贴标面、尺寸与 codec 状态 | 否 |
| `validate_label_spec` | 校验 Label Spec、资源、目标与设计/印刷问题 | 否 |
| `apply_label_spec` | 一次完成应用、烘焙、预览、GLB 交叉校验和完整产物发布 | 是 |
| `render_label_preview` | 从 Label Spec 或 `.lbl` 项目生成预览 PNG | 是 |
| `export_label_assets` | 从已保存 `.lbl` 项目再次导出完整交付物 | 是 |
| `open_label_editor` | 返回同一会话的本机令牌化 URL，供人工审阅和接管 | 否 |

进入 `$cosmetic-label-editor` 后，推荐工具顺序是 `inspect_model` → `validate_label_spec` → `apply_label_spec`。不要根据相似节点名猜目标；使用检查结果中的 `stableSelector`。`open_label_editor` 只用于人机接力，不是自动化所必需的步骤。

## CLI

所有命令都返回统一 Agent envelope。使用 `--json` 时，stdout 只写一条 JSON；进度与诊断写 stderr。

```bash
# 获取完整 Label Spec v2 JSON Schema
node scripts/label-cli.mjs schema --json

# 检查模型和候选贴标区域
node scripts/label-cli.mjs inspect model.glb --json

# 仅校验规格；增加 --glb 可同时验证模型目标
node scripts/label-cli.mjs validate spec.json --glb model.glb --json

# 应用设计并发布完整目录
node scripts/label-cli.mjs apply spec.json \
  --glb model.glb --output result --json

# 已明确允许覆盖时使用 --force；--open 同时返回人工审阅 URL
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

退出码：`0` 成功；`2` 参数错误；`3` 路径越界；`4` Label Spec/项目无效；`5` 目标缺失或有歧义；`6` 浏览器不可用；`7` GLB 重建失败；`8` codec 不支持；`9` 输出冲突；`1` 其他内部错误。

## Label Spec v2

Schema 的唯一来源是 [`src/agent/label-spec-v2.schema.json`](src/agent/label-spec-v2.schema.json)，也可以通过 `label-cli schema` 获取。真实正/背标示例见 [`tests/fixtures/specs/perfume-front-back-v2.json`](tests/fixtures/specs/perfume-front-back-v2.json)。

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
- 页面 CSP 禁止 `unsafe-eval`，只允许本源脚本；仅对运行时自有的内存 GLB 开放 `blob:` 连接。
- 目录和单文件产物都采用同目录临时文件/目录后 rename 的原子发布方式；除非明确使用 `force`，不会覆盖已有结果。
- 返回的人工接管 URL 是短期本地能力凭证，不应发送给不受信任的第三方。

## Codec 与交付边界

- 标准 GLB 可直接处理；Draco GLB 会在 Node 运行时先解压标准化，输出当前不保留 Draco 压缩。
- `EXT_meshopt_compression` 和 `KHR_texture_basisu` 当前返回明确的 `UNSUPPORTED_CODEC`，不会静默生成不完整结果。
- 工艺是屏幕/PBR 预览和分色数据，不等于供应商实物可行性。颜色、套准、附着力、触感和刀模需要打样确认。
- 当前不会生成印厂可直接制版的 PDF/AI 刀模，也不替代法规、条码或宣称审核。

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
