export interface AsyncResourceLifecycle<T> {
  install: (resource: T) => void
  dispose: (resource: T) => void
  onError?: (error: unknown) => void
}

export class LatestAsyncResourceOwner {
  private generation = 0
  private disposed = false

  async run<T>(load: () => Promise<T>, lifecycle: AsyncResourceLifecycle<T>): Promise<boolean> {
    if (this.disposed) return false
    const generation = ++this.generation
    try {
      const resource = await load()
      if (this.disposed || generation !== this.generation) {
        lifecycle.dispose(resource)
        return false
      }
      lifecycle.install(resource)
      return true
    } catch (error) {
      if (!this.disposed && generation === this.generation) lifecycle.onError?.(error)
      return false
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
  }
}
