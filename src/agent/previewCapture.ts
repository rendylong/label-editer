import type { PreviewRequest, QcCameraMetadata, QcViewRequest } from './contracts'

export type AgentPreviewCapture = (request: Required<Pick<PreviewRequest, 'width' | 'height'>>) => Promise<Blob>

export interface AgentQcCaptureResult {
  blob: Blob
  camera: QcCameraMetadata
}

export interface AgentPreviewCaptureOwner {
  preview: AgentPreviewCapture
  qc(request: QcViewRequest): Promise<AgentQcCaptureResult>
}

let owner: { token: symbol; capture: AgentPreviewCaptureOwner } | null = null

export function registerAgentPreviewCapture(capture: AgentPreviewCaptureOwner): () => void {
  const token = Symbol('agent-preview')
  owner = { token, capture }
  return () => {
    if (owner?.token === token) owner = null
  }
}

export function captureAgentPreview(request: Required<Pick<PreviewRequest, 'width' | 'height'>>): Promise<Blob> {
  if (!owner) return Promise.reject(new Error('3D preview is not ready'))
  return owner.capture.preview(request)
}

export function captureAgentQcView(request: QcViewRequest): Promise<AgentQcCaptureResult> {
  if (!owner) return Promise.reject(new Error('3D preview is not ready'))
  return owner.capture.qc(request)
}
