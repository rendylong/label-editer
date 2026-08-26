/**
 * 共享类型：标签图层、工艺、重映射参数、部件树。
 * 所有数据模型必须 JSON 可序列化（.lbl 项目文件依赖）。
 */

import type { CarrierMode, LabelSubstrate, NormalizedBounds, PhysicalBounds, ProcessIntent } from '../agent/designContracts'

export type { CarrierMode, ProcessIntent } from '../agent/designContracts'

export interface PhysicalArtboard {
  widthMm: number
  heightMm: number
  background: string
}

export type SubstrateSpec = LabelSubstrate

export type TargetAspectPolicy = 'fit' | 'crop-approved' | 'block'

export interface DesignBinding {
  blueprintRevision: string
  blueprintSha256: string
  reviewManifestSha256: string
  approvedCrop?: PhysicalBounds
}

export interface LayerDesignMetrics {
  boundsMm?: PhysicalBounds
  normalizedBounds?: NormalizedBounds
  anchor: 'top_left' | 'top_center' | 'center' | 'baseline_left' | 'baseline_center'
  fontSizeMm?: number
  letterSpacingEm?: number
  lineHeight?: number
  wrapPolicy?: 'none' | 'word' | 'character'
  maxLines?: number
  strokeWidthMm?: number
  cornerRadiusMm?: number
}

export interface LayerPhysicalMetadata {
  designMetrics?: LayerDesignMetrics
  processes?: ProcessIntent[]
}

/** 工艺类型（六种，可叠加，作用于图层或全局）。 */
export type CraftType = 'foil' | 'emboss' | 'deboss' | 'matte' | 'uv' | 'stroke'

/** 工艺参数（物理值）。 */
export interface CraftParams {
  /** 烫金：色系预设 key */
  foilColor?: 'gold' | 'silver' | 'rose' | 'champagne' | 'holographic' | 'custom'
  /** 自定义金属箔基色；foilColor=custom 时使用。 */
  foilCustomColor?: string
  /** 印刷专色/箔版名称。 */
  foilSpotName?: string
  /** 渐变角度（度） */
  gradientAngle?: number
  /** 高光强度 0-1 */
  highlight?: number
  /** 击凸/压凹：深度（相对字号比例 0-1） */
  depth?: number
  /** 光源方向（度） */
  lightAngle?: number
  /** 磨砂：强度 0-1 */
  intensity?: number
  /** 磨砂噪点密度 0-1 */
  noise?: number
  /** UV 亮油：光泽度 0-1 */
  gloss?: number
  /** 描边：颜色 + 宽度（px） */
  strokeColor?: string
  strokeWidth?: number
}

export interface CraftEffect {
  type: CraftType
  params: CraftParams
}

/** 文本图层。 */
export interface TextLayer extends LayerPhysicalMetadata {
  id: string
  kind: 'text'
  text: string
  /** Stable catalog id. Legacy display names are migrated at project import. */
  fontFamily: string
  fontSize: number
  fontWeight: number | 'normal' | 'bold'
  letterSpacing: number
  lineHeight: number
  /** 可拖动调整的文本框宽度；旧项目缺省时按文字自然宽度显示。 */
  width?: number
  color: string
  align: 'left' | 'center' | 'right'
  italic: boolean
  /** 文字朝向：horizontal = 沿瓶身环绕（默认）；vertical = 沿瓶高 */
  direction?: 'horizontal' | 'vertical'
  /** 语言书写方向；auto 会根据首个强方向字符推断。 */
  writingDirection?: 'auto' | 'ltr' | 'rtl'
  /** BCP-47 语言标签，用于字体覆盖与交付检查。 */
  language?: string
  /** 画布坐标（px，相对画布左上角） */
  x: number
  y: number
  rotation: number
  opacity: number
  visible: boolean
  locked: boolean
  zIndex: number
  craft: CraftEffect[]
}

/** 图片图层。 */
export interface ImageLayer extends LayerPhysicalMetadata {
  id: string
  kind: 'image'
  /** 可序列化的数据 URL（旧项目可能仍含临时 objectURL） */
  src: string
  /** 原始像素尺寸 */
  naturalWidth: number
  naturalHeight: number
  width: number
  height: number
  x: number
  y: number
  rotation: number
  opacity: number
  visible: boolean
  locked: boolean
  zIndex: number
  craft: CraftEffect[]
}

/** First-release shape vocabulary. Rendering algorithms are added separately. */
export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond' | 'polygon' | 'star' | 'line' | 'wave' | 'burst' | 'cross' | 'bracket' | 'dot-grid' | 'frame' | 'path'

/** Shape-specific parameters, kept serializable for shared preview/export geometry. */
export interface ShapeGeometry {
  sides?: number
  points?: number
  innerRatio?: number
  amplitude?: number
  frequency?: number
  arrowStart?: boolean
  arrowEnd?: boolean
  /** Render a line as two independent parallel open subpaths. */
  parallel?: boolean
  dash?: number[]
  inset?: number
  rows?: number
  columns?: number
  gap?: number
}

/** 可直接排版的色块/分隔线。旧矩形省略 geometry 时保持原有行为。 */
export interface ShapeLayer extends LayerPhysicalMetadata {
  id: string
  kind: 'shape'
  shape: ShapeKind
  /** Optional for source compatibility with existing rectangle layers. */
  geometry?: ShapeGeometry
  /** Editable source path; rendering derives pixels without rewriting it. */
  pathData?: string
  /** Source coordinate system as [minX, minY, positive width, positive height]. */
  pathViewBox?: [number, number, number, number]
  fillRule?: 'nonzero' | 'evenodd'
  width: number
  height: number
  fill: string
  stroke: string
  strokeWidth: number
  cornerRadius: number
  x: number
  y: number
  rotation: number
  opacity: number
  visible: boolean
  locked: boolean
  zIndex: number
  craft: CraftEffect[]
}

export type LabelLayer = TextLayer | ImageLayer | ShapeLayer

/** Project-serializable uploaded font data retained for legacy projects. */
export interface UploadedFontRecord {
  name: string
  dataUrl: string
}

/** 标签纸张底色。缺省/disabled 必须保持透明。 */
export interface LabelPaper {
  enabled: boolean
  color: string
  opacity: number
}

/** 面向印刷交付的物理规格；像素画布仅负责预览与烘焙。 */
export interface LabelPrintSpec {
  physicalWidthMm: number
  physicalHeightMm: number
  bleedMm: number
  cornerRadiusMm: number
  minTextHeightMm: number
  dieCutShape: 'rectangle' | 'rounded-rectangle' | 'custom'
  spotColors: string[]
}

/** 全局工艺（作用于整个标签）。 */
export interface GlobalCraft {
  craft: CraftEffect[]
}

/** 圆柱投影重映射参数（序列化、可复算 —— uvRemap 唯一数据源）。 */
export interface RemapParams {
  mode: 'cylindrical' | 'planar'
  /** 轴方向单位向量 */
  axis: [number, number, number]
  /** 轴上一点（包围盒中心） */
  origin: [number, number, number]
  /** 圆柱半径（可见带平均） */
  radius: number
  /** 环绕圈数 */
  wrap: number
  /** 接缝旋转偏移：u 平移量（0-1），正面 = u=0.5 */
  offset: number
  /** 目标节点世界变换为负手性时反转 U，抵消模型层级中的镜像。 */
  mirrorU?: boolean
  /** 平面模式包围盒 */
  planarBox: { min: [number, number, number]; max: [number, number, number] }
}

/**
 * 贴标区域范围（在圆柱投影 UV 空间内）。
 * u：环绕方向，uStart=0 起点、uWidth=宽度（份数，默认 1 = 整圈）；
 * v：高度方向，vStart=0 底部起点、vHeight=高度比例（默认 1 = 整高）。
 * 区域外网格表面在预览/导出时按 ClampToEdge 采样为画布边缘（背景色）。
 */
export interface LabelAreaRange {
  /** 环绕起点（0-1，相对整圈） */
  uStart: number
  /** 环绕宽度（份数，1 = 整圈） */
  uWidth: number
  /** 高度起点（0-1，相对标签网格高度） */
  vStart: number
  /** 高度比例（0-1） */
  vHeight: number
}

/** 画布规格（由几何推导）。 */
export interface CanvasSpec {
  /** 渲染/烘焙像素宽 */
  width: number
  height: number
  /** 几何宽高比（2πr·wrap·uWidth : h·vHeight） */
  aspect: number
}

/** 贴标区域 = 一个可独立编辑的标签面（多区域系统核心对象）。 */
export interface LabelAreaConfig {
  /** 区域唯一 id */
  id: string
  /** 区域名称（默认 = 目标网格名） */
  name: string
  meshIndex: number
  nodeName: string
  /**
   * overlay：目标是瓶身等产品本体，保留原几何/材质并新增透明贴标层；
   * replace：目标本身就是独立标签网格，用编辑器内容替换原标签外观。
   */
  surfaceMode?: 'overlay' | 'replace'
  /** Explicit side identity keeps repeated spec imports from swapping front/back offsets. */
  side?: 'front' | 'back'
  remap: RemapParams
  /** 区域范围（尺寸/位置，可调） */
  range: LabelAreaRange
  canvas: CanvasSpec
  /** 显式纸张底色；不提供时透明。 */
  paper?: LabelPaper
  /** Physical carrier selected by the approved design contract. */
  carrier?: CarrierMode
  artboard?: PhysicalArtboard
  substrate?: SubstrateSpec
  placementPolicy?: TargetAspectPolicy
  blueprintAreaId?: string
  designBinding?: DesignBinding
  /** 可选印刷规格；旧项目未提供时保持未设置。 */
  printSpec?: LabelPrintSpec
  layers: LabelLayer[]
  globalCraft: GlobalCraft
  /** 字体上传记录（名称 → 数据 URL），随 .lbl 导出可选携带 */
  fonts: UploadedFontRecord[]
  /** 参考层（原纹理）显隐 */
  referenceVisible: boolean
  /** 参考纹理 objectURL（仅运行时，不序列化） */
  referenceUrl?: string
  /** 沿轴投影范围（v 归一化参考，圆柱坐标拾取/控制框几何用） */
  axisMin?: number
  axisMax?: number
  /** 每区域独立撤销栈（快照，仅图层引用） */
  undoStack: AreaSnapshot[]
  redoStack: AreaSnapshot[]
}

export interface AreaSnapshot {
  paper?: LabelPaper
  layers: LabelLayer[]
  globalCraft: CraftEffect[]
  referenceVisible: boolean
  remap: RemapParams
  range: LabelAreaRange
}

/** 兼容：旧 LabelConfig 别名（避免大范围改动遗留引用）。 */
export type LabelConfig = LabelAreaConfig

/** 部件树节点。 */
export interface PartNode {
  id: string
  name: string
  kind: 'group' | 'mesh' | 'label'
  children: PartNode[]
  /** 材质名（mesh 时） */
  material?: string
  /** 对应 gltf-transform 场景图中的 mesh index */
  meshIndex?: number
  visible: boolean
  /** 三角形数（mesh 时） */
  triangleCount?: number
}

/** 分析结果。 */
export interface GlbAnalysis {
  parts: PartNode[]
  /** mesh index → 节点 id（供 label 定位） */
  meshToNode: Record<number, string>
  /** 标签候选节点 id 列表（名字含 label/贴标/标签，或含纹理的独立网格） */
  labelCandidates: string[]
  /** 模型名 */
  modelName: string
}

export const FONT_STACKS: { name: string; css: string }[] = [
  { name: '系统默认', css: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif' },
  { name: 'PingFang SC', css: '"PingFang SC", "Microsoft YaHei", sans-serif' },
  { name: 'Microsoft YaHei', css: '"Microsoft YaHei", "PingFang SC", sans-serif' },
  { name: 'Noto Sans CJK', css: '"Noto Sans CJK SC", "Source Han Sans SC", sans-serif' },
  { name: '宋体 (Serif)', css: 'SimSun, "Songti SC", serif' },
  { name: '黑体 (Hei)', css: 'SimHei, "Heiti SC", sans-serif' },
  { name: 'Times', css: 'Times, "Times New Roman", serif' },
  { name: 'Georgia', css: 'Georgia, serif' },
  { name: 'Arial', css: 'Arial, Helvetica, sans-serif' },
  { name: 'Impact', css: 'Impact, Haettenschweiler, sans-serif' },
  { name: 'Courier', css: '"Courier New", Courier, monospace' },
]

export const CRAFT_LABELS: Record<CraftType, string> = {
  foil: '烫金',
  emboss: '击凸',
  deboss: '压凹',
  matte: '磨砂',
  uv: 'UV 亮油',
  stroke: '描边',
}

export const FOIL_COLORS: Record<string, { name: string; stops: string[] }> = {
  gold: { name: '金', stops: ['#f5d76e', '#fff3b0', '#d4a017', '#f7e08b', '#b8860b'] },
  silver: { name: '银', stops: ['#e8e8e8', '#ffffff', '#b8b8b8', '#efefef', '#9a9a9a'] },
  rose: { name: '玫瑰金', stops: ['#f7c8b0', '#fbe3d2', '#d98e6a', '#f7c8b0', '#c07a52'] },
  champagne: { name: '香槟金', stops: ['#f0e6c8', '#faf3dc', '#cdb983', '#f0e6c8', '#a8905a'] },
  holographic: { name: '镭射', stops: ['#ff9a9e', '#a18cd1', '#fbc2eb', '#84fab0', '#8fd3f4', '#ff9a9e'] },
}

export const BASIC_PALETTE = [
  '#000000', '#ffffff', '#c0c0c0', '#808080', '#5a5a5a',
  '#8b0000', '#d4af37', '#b76e79', '#ff6b6b', '#e74c3c',
  '#f39c12', '#f1c40f', '#2ecc71', '#16a085', '#3498db',
  '#2980b9', '#8e44ad', '#9b59b6', '#e91e63', '#7f5539',
]
