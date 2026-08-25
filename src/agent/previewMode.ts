export function isAgentPreviewUrl(value: string | URL): boolean {
  try {
    const url = value instanceof URL ? value : new URL(value)
    return url.searchParams.get('agent-preview') === '1'
  } catch {
    return false
  }
}
