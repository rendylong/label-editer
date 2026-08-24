# glb-label-editor

独立 Web 版 GLB 贴标编辑器 —— 为美妆瓶身设计标签（文字 / 图片 / 工艺），实时 3D 预览，导出重打包 GLB。

纯前端应用（Vite + React 19 + three.js + Konva + @gltf-transform），无后端、无账号，静态部署即可用。**不是 DSH 插件，不依赖 better-sidebar。**

## 功能

- **部件列表**：GLB 场景树（节点 / 材质 / 三角形数），点击高亮，可显隐，自动识别贴标部件（名字含 label/贴标/标签，或含纹理的独立网格）。
- **多个贴标区域**：可在部件列表创建任意数量的贴标区域，每个区域独立设计画布、图层、工艺与撤销栈；左侧「贴标区域」分组列出全部区域，可点击切换、删除。
- **贴标区域可视化设置流程**：工具栏「＋ 贴标区域」进入独立页面——① 选择目标表面 → ② 在遵循 3D UV 逻辑的 **2D 展开图**上拖拽矩形框选贴标区域 → ③ 创建或更新。展开图明确标注模型正面、背部接缝、顶部与底部；选区始终限制在有效表面范围内。已有区域会载入真实范围继续编辑，不会丢弃确认结果。
- **贴标区域大小可调**：编辑器属性面板显示区域摘要，并统一从「在 2D 展开图中编辑」进入可视化调整；环绕宽度、环绕起点、高度比例与垂直位置均由同一 UV 坐标转换约束，画布规格实时按几何推导。
- **标签设计（WYSIWYG）**：2D 画布即"瓶子上的标签"——
  - 文本图层：内容 / 字体（系统 + 上传 ttf/otf/woff2）/ 字号 / 字重 / 字距 / 行距 / 对齐 / 颜色 / 斜体 / 旋转 / 透明度 / **文字朝向**（横向=沿瓶身环绕、纵向=沿瓶高，属性面板可见当前朝向并切换）；
  - 图片图层：上传 PNG/JPG/WebP，拖拽 / 缩放 / 旋转；
  - **工艺**（每图层可叠加、也可全局）：烫金（金/银/玫瑰金/香槟金/镭射）、击凸、压凹、磨砂、UV 亮油、描边；
  - 画布内直接拖拽 / 旋转 / 缩放（Konva Transformer）、增量撤销/重做（Ctrl+Z / Ctrl+Shift+Z / Delete / Ctrl+D）、快捷键缩放；
  - 参考层（原标签纹理）显隐对比、接缝线、正面标记。
- **实时 3D 预览**：所有贴标区域的修改防抖烘焙（≤50ms）→ 纹理热更新（换源不重编译）→ 下一帧生效；**PBR 通道**（Metalness/Roughness/Bump）由工艺自动生成并应用于材质；顶栏可切换 Color / Metalness / Roughness / Bump 通道视图。
- **导出**：
  - 标签纹理 PNG（激活区域，尺寸 = 画布规格，由几何推导，2048 宽）；
  - **重打包 GLB**：Web Worker 中 @gltf-transform 重打包**所有贴标区域**（替换 baseColorTexture + metallicRoughness + normal、覆盖 UV、保留透明背景并使用 BLEND、按区域范围设置采样），**交叉自检**（独立实现 three GLTFLoader 重解析 + UV 采样比对 + 输入未修改校验），任一项失败则报错并保留原文件；
  - 项目 `.lbl`（JSON：设计数据 + 重映射参数）导入/导出，防止刷新丢失。

## 核心技术：圆柱投影 UV 重映射

真实模型的贴标网格 UV 常常是损坏/退化的（如示例 `面霜瓶.glb` 的 label_0：78% 顶点采样同一纹理点），无法直接编辑。本工具：

1. 对标签网格拟合圆柱（PCA 主轴候选 + 圆柱度质量择优）；
2. **圆柱投影重映射**：`u = (-atan2/2π + 0.5)·wrap + offset`、`v = 高度归一化`；U 正方向与模型正面的自然阅读方向一致，画布宽高比 = `2πr·wrap : 高`（几何推导，非固定方形）；
3. **接缝顶点拆分**：跨缝三角形按"相对首顶点展开 ±1"复制顶点，配合 REPEAT 采样实现无缝环绕（实测可见带 138 条跨缝边全部消除）；
4. 底部退化扇区（r < 0.2·r̄）三角形整体塌缩到单一 u 列（不可见区域，避免整幅拉伸）；
5. 正面原点 = 画布 u=0.5（`θ_front = π/2 - 2π·offset`），画布与 3D 标记对齐。

uvRemap 是**唯一数据源**：预览（three `geometry.setAttribute`）与导出（gltf-transform accessor 覆盖）都从同一组序列化参数派生，杜绝双源漂移。全部数学为纯函数，黄金用例见 `tests/uvRemap.test.ts`（真实模型数据）。

## 使用

```bash
pnpm install
pnpm dev        # 开发（http://localhost:5178）
pnpm test       # Vitest 单测（含真实 GLB 黄金用例与区域坐标回归）
pnpm build      # 产物在 dist/
pnpm preview    # 本地预览（http://localhost:4178）
```

打开页面 → `加载示例`（内置面霜瓶.glb）→ 自动选中 label_0 → 添加文字/图片、调属性、加工艺 → 右侧 3D 实时预览 → `导出 GLB` / `导出纹理 PNG`。

也可以 `打开 GLB` 导入任意 `.glb`（v1 仅支持 .glb；`.gltf` 外部资源未支持）。

## 部署

`dist/` 是纯静态产物，可放任意静态托管（GitHub Pages / Vercel / Nginx…）。

> ⚠️ **必须通过 http(s) 访问**（DRACO 解码 worker 在 `file://` 下不可用；3D 预览需要 WebGL）。DRACO 解码器已本地化到 `public/draco/`，离线可用。

## 已知限制（v1）

- **Draco 压缩模型的标签导出**不可用（npm 版 draco3d 依赖 node:fs，浏览器不可行——M1 spike 结论）：预览可正常显示（three 本地 decoder），导出会提示"仅导出 PNG"兜底。
- 工艺效果为**视觉模拟**（烫金/击凸等绘制进纹理与 PBR 通道）；生产印刷需专色/出血转换（规划中）。
- 模板库、异形曲面展平、.gltf 外部资源见 TODOS。
- 环境贴图 / 动画 / Meshopt / KTX2 未接入。

## 目录

```
src/
  glb/          analyze.ts（部件树/accessor 提取）、uvRemap.ts（重映射纯函数）、
                rebuild.ts + rebuild.worker.ts（重打包 + 交叉自检）、textures.ts（PNG/打包/法线）
  scene/        SceneController.ts（three 场景、高亮、纹理热更新、通道视图）、Viewport.tsx
  label/        LabelCanvas.tsx（Konva 画布 + 烘焙）、craft.ts（工艺绘制 + mask）、fonts.ts、types.ts
  state/        stores.ts（modelStore / labelStore（mutation 网关 + 增量撤销）/ uiStore）
  ui/           Toolbar.tsx、Panels.tsx（部件树/图层/属性/工艺）
  app/          App.tsx、modelLoader.ts、actions.ts（导出/.lbl/快捷键）、styles.css
tests/          uvRemap 黄金用例、GLB 往返、导出管线往返
```

设计与评审记录：见 `/Users/apple/dsh/PLAN.md`（autoplan 三阶段评审 + 决策审计）。
