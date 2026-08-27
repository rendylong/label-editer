import type {
  PreviewRequest,
  QcCameraMetadata,
  QcViewRequest,
  ReviewViewKind,
  ReviewViewRequest,
} from './contracts'
import { MAX_REVIEW_SHEET_SOURCES, reviewSheetLabel } from './reviewCapturePlan'
import { parsePortablePng } from '../../scripts/lib/png-core.mjs'

export type AgentPreviewCapture = (request: Required<Pick<PreviewRequest, 'width' | 'height'>>) => Promise<Blob>

export interface AgentQcCaptureResult {
  blob: Blob
  camera: QcCameraMetadata
}

export interface AgentPreviewCaptureOwner {
  preview: AgentPreviewCapture
  qc(request: QcViewRequest): Promise<AgentQcCaptureResult>
  review?(request: ReviewViewRequest, context: AgentReviewCaptureContext): Promise<AgentReviewCaptureResult>
}

export interface AgentReviewCaptureResult {
  id: string
  kind: ReviewViewKind
  blob: Blob
  width: number
  height: number
  camera?: QcCameraMetadata
}

export interface AgentReviewCaptureSource {
  request: ReviewViewRequest
  result: AgentReviewCaptureResult
}

export interface AgentReviewCaptureContext {
  blueprintRevision: string
  inputRevision: string
  sources: AgentReviewCaptureSource[]
  consumeEncodedBytes?: (byteLength: number) => void
}

let owner: { token: symbol; capture: AgentPreviewCaptureOwner } | null = null

function browserNotReady(): Error & { code: 'BROWSER_NOT_READY' } {
  const error = new Error('3D preview is not ready') as Error & { code: 'BROWSER_NOT_READY' }
  error.code = 'BROWSER_NOT_READY'
  return error
}

function reviewNotReady(message: string): Error & { code: 'BROWSER_NOT_READY' } {
  const error = new Error(message) as Error & { code: 'BROWSER_NOT_READY' }
  error.code = 'BROWSER_NOT_READY'
  return error
}

function assertReviewDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || width < 1 || width > 4096
    || !Number.isInteger(height) || height < 1 || height > 4096) {
    throw reviewNotReady('Review capture dimensions are invalid')
  }
}

function assertBoundedSourceDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) {
    throw reviewNotReady('Review source dimensions are invalid or exceed the bounded allocation')
  }
}

export function assertReviewPngBytes(bytes: Uint8Array, width: number, height: number): void {
  assertReviewDimensions(width, height)
  if (bytes.byteLength < 1 || bytes.byteLength > 32 * 1024 * 1024) throw reviewNotReady('Review PNG encoded size is invalid')
  try {
    parsePortablePng(bytes, {
      expectedWidth: width,
      expectedHeight: height,
      maxWidth: 4096,
      maxHeight: 4096,
      maxPixels: 4096 * 4096,
    })
  } catch (error) {
    throw reviewNotReady(`Review PNG structure is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function validatedReviewPngBytes(blob: Blob, width: number, height: number): Promise<Uint8Array> {
  assertReviewDimensions(width, height)
  if (blob.type !== 'image/png' || blob.size < 1 || blob.size > 32 * 1024 * 1024) {
    throw reviewNotReady('Review PNG MIME or encoded size is invalid')
  }
  const bytes = new Uint8Array(await blob.arrayBuffer())
  assertReviewPngBytes(bytes, width, height)
  return bytes
}

function encodeCanvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.type === 'image/png' && blob.size > 0) resolve(blob)
      else reject(reviewNotReady('Review PNG encoding failed'))
    }, 'image/png')
  })
}

function containRect(
  sourceWidth: number,
  sourceHeight: number,
  target: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(target.width / sourceWidth, target.height / sourceHeight)
  const width = sourceWidth * scale
  const height = sourceHeight * scale
  return {
    x: target.x + (target.width - width) / 2,
    y: target.y + (target.height - height) / 2,
    width,
    height,
  }
}

export function registerAgentPreviewCapture(capture: AgentPreviewCaptureOwner): () => void {
  const token = Symbol('agent-preview')
  owner = { token, capture }
  return () => {
    if (owner?.token === token) owner = null
  }
}

export function captureAgentPreview(request: Required<Pick<PreviewRequest, 'width' | 'height'>>): Promise<Blob> {
  if (!owner) return Promise.reject(browserNotReady())
  return owner.capture.preview(request)
}

export function captureAgentQcView(request: QcViewRequest): Promise<AgentQcCaptureResult> {
  if (!owner) return Promise.reject(browserNotReady())
  return owner.capture.qc(request)
}

export function captureAgentReviewView(
  request: ReviewViewRequest,
  context: AgentReviewCaptureContext,
): Promise<AgentReviewCaptureResult> {
  if (!owner?.capture.review) return Promise.reject(browserNotReady())
  return owner.capture.review(request, context)
}

/**
 * Composite the currently baked editable artwork over a neutral review field.
 * The source bake is authoritative: this function never draws a carrier panel,
 * paper edge, clear-film diagnostic, or other reconstructed decoration.
 */
export async function captureFlatArtworkReview(
  request: ReviewViewRequest,
  source: HTMLCanvasElement,
): Promise<AgentReviewCaptureResult> {
  if (request.kind !== 'flat-artwork' || !request.areaId || !request.carrier || request.carrier === 'bare') {
    throw reviewNotReady('Flat artwork review requires one current non-bare area')
  }
  assertReviewDimensions(request.width, request.height)
  assertBoundedSourceDimensions(source.width, source.height)
  const canvas = document.createElement('canvas')
  canvas.width = request.width
  canvas.height = request.height
  const context = canvas.getContext('2d')
  if (!context) throw reviewNotReady('Flat artwork review canvas is unavailable')
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.fillStyle = '#f3f4f6'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const frame = containRect(source.width, source.height, { x: 0, y: 0, width: canvas.width, height: canvas.height })
  context.drawImage(source, frame.x, frame.y, frame.width, frame.height)
  return {
    id: request.id,
    kind: request.kind,
    blob: await encodeCanvasPng(canvas),
    width: request.width,
    height: request.height,
  }
}

async function exactSheetSources(
  request: ReviewViewRequest,
  context: AgentReviewCaptureContext,
): Promise<AgentReviewCaptureSource[]> {
  if (request.kind !== 'review-sheet' || !Array.isArray(request.sourceViewIds)
    || request.sourceViewIds.length < 1 || request.sourceViewIds.length > MAX_REVIEW_SHEET_SOURCES
    || context.sources.length !== request.sourceViewIds.length) {
    throw reviewNotReady('Review sheet sources do not exactly match the capture plan')
  }
  const ids = new Set<string>()
  for (let index = 0; index < context.sources.length; index += 1) {
    const source = context.sources[index]
    const expectedId = request.sourceViewIds[index]
    const key = source.result.id.normalize('NFKC').toLowerCase()
    if (source.request.id !== expectedId || source.result.id !== expectedId
      || ids.has(key) || source.request.kind !== source.result.kind
      || source.request.kind === 'review-sheet'
      || source.result.width !== source.request.width || source.result.height !== source.request.height
      || source.result.blob.type !== 'image/png' || source.result.blob.size < 1
      || source.result.blob.size > 32 * 1024 * 1024) {
      throw reviewNotReady(`Review sheet source is stale or invalid: ${expectedId}`)
    }
    assertReviewDimensions(source.result.width, source.result.height)
    const bytes = await validatedReviewPngBytes(source.result.blob, source.request.width, source.request.height)
    context.consumeEncodedBytes?.(bytes.byteLength)
    ids.add(key)
  }
  return context.sources
}

/** Compose a bounded review sheet from only the exact captures in this batch. */
export async function composeReviewSheet(
  request: ReviewViewRequest,
  context: AgentReviewCaptureContext,
): Promise<AgentReviewCaptureResult> {
  assertReviewDimensions(request.width, request.height)
  const sources = await exactSheetSources(request, context)
  if (typeof createImageBitmap !== 'function') throw reviewNotReady('Review image decoder is unavailable')
  const canvas = document.createElement('canvas')
  canvas.width = request.width
  canvas.height = request.height
  const drawing = canvas.getContext('2d')
  if (!drawing) throw reviewNotReady('Review sheet canvas is unavailable')
  drawing.fillStyle = '#eef1f4'
  drawing.fillRect(0, 0, canvas.width, canvas.height)
  const columns = sources.length === 1 ? 1 : Math.ceil(Math.sqrt(sources.length * (canvas.width / canvas.height)))
  const rows = Math.ceil(sources.length / columns)
  const gap = Math.max(8, Math.min(24, Math.floor(Math.min(canvas.width, canvas.height) * 0.015)))
  const cellWidth = (canvas.width - gap * (columns + 1)) / columns
  const cellHeight = (canvas.height - gap * (rows + 1)) / rows
  const labelHeight = Math.max(24, Math.min(52, Math.floor(cellHeight * 0.12)))
  if (cellWidth < 1 || cellHeight <= labelHeight) throw reviewNotReady('Review sheet layout exceeds its bounded canvas')

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(source.result.blob)
    } catch {
      throw reviewNotReady(`Review sheet PNG cannot be decoded: ${source.result.id}`)
    }
    try {
      assertBoundedSourceDimensions(bitmap.width, bitmap.height)
      const column = index % columns
      const row = Math.floor(index / columns)
      const cell = {
        x: gap + column * (cellWidth + gap),
        y: gap + row * (cellHeight + gap),
        width: cellWidth,
        height: cellHeight - labelHeight,
      }
      drawing.fillStyle = '#ffffff'
      drawing.fillRect(cell.x, cell.y, cell.width, cell.height)
      const frame = containRect(bitmap.width, bitmap.height, cell)
      drawing.drawImage(bitmap, frame.x, frame.y, frame.width, frame.height)
      drawing.fillStyle = '#172033'
      const fontSize = Math.max(10, Math.min(18, Math.floor(labelHeight * 0.32)))
      drawing.font = `${fontSize}px system-ui, sans-serif`
      drawing.textAlign = 'left'
      drawing.textBaseline = 'middle'
      const lines = reviewSheetLabel({
        viewId: source.request.id,
        areaToken: source.request.areaToken,
        side: source.request.side,
        carrier: source.request.carrier,
        ordinal: index + 1,
        kind: source.request.kind,
        blueprintRevision: context.blueprintRevision,
        inputRevision: context.inputRevision,
      }).split('\n')
      const lineHeight = Math.min(fontSize * 1.25, labelHeight / lines.length)
      const firstLineY = cell.y + cell.height + (labelHeight - lineHeight * (lines.length - 1)) / 2
      for (let line = 0; line < lines.length; line += 1) {
        drawing.fillText(lines[line], cell.x, firstLineY + line * lineHeight, Math.max(1, cell.width))
      }
    } finally {
      bitmap.close()
    }
  }
  return {
    id: request.id,
    kind: request.kind,
    blob: await encodeCanvasPng(canvas),
    width: request.width,
    height: request.height,
  }
}
