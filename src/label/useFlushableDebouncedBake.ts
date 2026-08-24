import { useEffect, useLayoutEffect, useRef, type DependencyList } from 'react'

/**
 * Debounces an expensive bake during editing, but synchronously flushes the
 * latest committed render while refs are still owned during layout unmount.
 */
export function useFlushableDebouncedBake(bake: () => void, dependencies: DependencyList, delay = 300): void {
  const bakeRef = useRef(bake)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef(false)
  bakeRef.current = bake

  const cancelScheduledWork = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }

  useEffect(() => {
    cancelScheduledWork()
    pendingRef.current = true
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        if (!pendingRef.current) return
        pendingRef.current = false
        bakeRef.current()
      })
    }, delay)
    return cancelScheduledWork
  }, [...dependencies, delay])

  useLayoutEffect(() => () => {
    if (!pendingRef.current) return
    cancelScheduledWork()
    pendingRef.current = false
    bakeRef.current()
  }, [])
}
