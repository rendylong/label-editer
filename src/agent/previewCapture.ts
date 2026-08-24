import type { PreviewRequest } from './contracts'

export type AgentPreviewCapture = (request: Required<Pick<PreviewRequest, 'width' | 'height'>>) => Promise<Blob>

let owner: { token: symbol; capture: AgentPreviewCapture } | null = null

export function registerAgentPreviewCapture(capture: AgentPreviewCapture): () => void {
  const token = Symbol('agent-preview')
  owner = { token, capture }
  return () => {
    if (owner?.token === token) owner = null
  }
}

export function captureAgentPreview(request: Required<Pick<PreviewRequest, 'width' | 'height'>>): Promise<Blob> {
  if (!owner) return Promise.reject(new Error('3D preview is not ready'))
  return owner.capture(request)
}
