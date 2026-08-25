import {
  agentFailure,
  agentSuccess,
  type AgentErrorCode,
  type AgentPreviewStatus,
  type AppliedDesign,
  type ApplyProjectRequest,
  type ApplySpecRequest,
  type ArtifactDescriptor,
  type DesignValidationReport,
  type ExportManifest,
  type ExportRequest,
  type LabelEditorAgentBridgeV1,
  type ModelInspection,
  type ModelLoadRequest,
  type PreviewRequest,
  type ReadinessReport,
  type ReadinessRequest,
  type SerializedProject,
} from './contracts'

declare global {
  interface Window {
    __GLB_LABEL_EDITOR_AGENT_V1__?: LabelEditorAgentBridgeV1
  }
}

export interface InstallAgentBridgeOptions {
  location: URL
  expectedToken: string
  bridge: LabelEditorAgentBridgeV1
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
}

export function canInstallAgentBridge(url: URL, expectedToken: string): boolean {
  const presentedToken = url.searchParams.get('token') ?? ''
  return isLoopbackHost(url.hostname)
    && url.searchParams.get('agent') === '1'
    && expectedToken.length >= 32
    && presentedToken === expectedToken
}

export function installAgentBridge(options: InstallAgentBridgeOptions): () => void {
  if (!canInstallAgentBridge(options.location, options.expectedToken)) return () => undefined
  window.__GLB_LABEL_EDITOR_AGENT_V1__ = options.bridge
  return () => {
    if (window.__GLB_LABEL_EDITOR_AGENT_V1__ === options.bridge) {
      delete window.__GLB_LABEL_EDITOR_AGENT_V1__
    }
  }
}

export interface AgentBridgeHandlers {
  reset: () => Promise<void>
  loadModel: (input: ModelLoadRequest) => Promise<ModelInspection>
  applySpec: (input: ApplySpecRequest) => Promise<AppliedDesign>
  applyProject: (input: ApplyProjectRequest) => Promise<AppliedDesign>
  setAgentPreviewStatus: (input: AgentPreviewStatus) => Promise<void>
  getProject: () => Promise<SerializedProject>
  validateDesign: () => Promise<DesignValidationReport>
  waitForReady: (input?: ReadinessRequest) => Promise<ReadinessReport>
  renderPreview: (input?: PreviewRequest) => Promise<ArtifactDescriptor>
  exportArtifacts: (input: ExportRequest) => Promise<ExportManifest>
}

function missingHandler(name: keyof AgentBridgeHandlers): never {
  throw new Error(`Agent Bridge handler is not configured: ${name}`)
}

function errorCode(value: unknown): AgentErrorCode {
  if (!value || typeof value !== 'object' || !('code' in value)) return 'INTERNAL_ERROR'
  const code = String((value as { code: unknown }).code)
  const supported: AgentErrorCode[] = [
    'INVALID_USAGE', 'PATH_NOT_ALLOWED', 'OUTPUT_CONFLICT', 'INVALID_LABEL_SPEC',
    'AMBIGUOUS_MODEL_TARGET', 'MODEL_TARGET_NOT_FOUND', 'BROWSER_NOT_READY',
    'REBUILD_FAILED', 'UNSUPPORTED_CODEC', 'REVISION_CONFLICT', 'INVALID_PATCH_OPERATION', 'INTERNAL_ERROR',
  ]
  return supported.includes(code as AgentErrorCode) ? code as AgentErrorCode : 'INTERNAL_ERROR'
}

async function invoke<T>(operation: string, action: () => Promise<T>) {
  try {
    return agentSuccess(operation, await action())
  } catch (error) {
    return agentFailure(
      operation,
      errorCode(error),
      error instanceof Error ? error.message : String(error),
    )
  }
}

export function createAgentBridge(overrides: Partial<AgentBridgeHandlers> = {}): LabelEditorAgentBridgeV1 {
  const handlers: AgentBridgeHandlers = {
    reset: overrides.reset ?? (() => Promise.resolve(missingHandler('reset'))),
    loadModel: overrides.loadModel ?? (() => Promise.resolve(missingHandler('loadModel'))),
    applySpec: overrides.applySpec ?? (() => Promise.resolve(missingHandler('applySpec'))),
    applyProject: overrides.applyProject ?? (() => Promise.resolve(missingHandler('applyProject'))),
    setAgentPreviewStatus: overrides.setAgentPreviewStatus ?? (() => Promise.resolve(missingHandler('setAgentPreviewStatus'))),
    getProject: overrides.getProject ?? (() => Promise.resolve(missingHandler('getProject'))),
    validateDesign: overrides.validateDesign ?? (() => Promise.resolve(missingHandler('validateDesign'))),
    waitForReady: overrides.waitForReady ?? (() => Promise.resolve(missingHandler('waitForReady'))),
    renderPreview: overrides.renderPreview ?? (() => Promise.resolve(missingHandler('renderPreview'))),
    exportArtifacts: overrides.exportArtifacts ?? (() => Promise.resolve(missingHandler('exportArtifacts'))),
  }
  return {
    reset: () => invoke('reset', handlers.reset),
    loadModel: (input) => invoke('load_model', () => handlers.loadModel(input)),
    applySpec: (input) => invoke('apply_label_spec', () => handlers.applySpec(input)),
    applyProject: (input) => invoke('apply_label_project', () => handlers.applyProject(input)),
    setAgentPreviewStatus: (input) => invoke('set_agent_preview_status', () => handlers.setAgentPreviewStatus(input)),
    getProject: () => invoke('get_project', handlers.getProject),
    validateDesign: () => invoke('validate_design', handlers.validateDesign),
    waitForReady: (input) => invoke('wait_for_ready', () => handlers.waitForReady(input)),
    renderPreview: (input) => invoke('render_label_preview', () => handlers.renderPreview(input)),
    exportArtifacts: (input) => invoke('export_label_assets', () => handlers.exportArtifacts(input)),
  }
}

export interface AgentBridgeBootstrap {
  token: string
  artifactUploadBase: string
}

export interface BootstrapAgentBridgeOptions {
  location?: URL
  fetcher?: typeof fetch
  createBridge: (bootstrap: AgentBridgeBootstrap) => LabelEditorAgentBridgeV1
}

export async function bootstrapAgentBridgeFromPage(options: BootstrapAgentBridgeOptions): Promise<() => void> {
  const location = options.location ?? new URL(window.location.href)
  const queryToken = location.searchParams.get('token') ?? ''
  const sessionId = location.searchParams.get('session') ?? ''
  if (
    !isLoopbackHost(location.hostname)
    || location.searchParams.get('agent') !== '1'
    || queryToken.length < 32
    || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
  ) return () => undefined

  try {
    const endpoint = new URL(`/session/${encodeURIComponent(sessionId)}/bootstrap`, location.origin)
    endpoint.searchParams.set('token', queryToken)
    const response = await (options.fetcher ?? fetch)(endpoint, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!response.ok) return () => undefined
    const value = await response.json() as Partial<AgentBridgeBootstrap>
    if (value.token !== queryToken || typeof value.artifactUploadBase !== 'string') return () => undefined
    const bootstrap: AgentBridgeBootstrap = { token: value.token, artifactUploadBase: value.artifactUploadBase }
    return installAgentBridge({ location, expectedToken: bootstrap.token, bridge: options.createBridge(bootstrap) })
  } catch {
    return () => undefined
  }
}
