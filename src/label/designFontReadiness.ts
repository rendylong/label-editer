import { useEffect, useMemo, useRef, useState } from 'react'
import type { LabelLayer, UploadedFontRecord } from './types'
import {
  deriveDesignFontRequests,
  loadDesignFontRequests,
  type FontLoadReport,
} from './fontRuntime'

export interface FontReadinessRevision {
  areaId: string
  revision: number
  readinessKey: string
  report: FontLoadReport
}

export interface FontReadinessRevisionGate {
  track: (areaId: string, request: Promise<FontLoadReport>, readinessKey?: string) => Promise<boolean>
  invalidate: () => void
  dispose: () => void
}

/** Keeps asynchronous font completions scoped to the current mounted area. */
export function createFontReadinessRevisionGate(
  onReady: (event: FontReadinessRevision) => void,
): FontReadinessRevisionGate {
  let token = 0
  let revision = 0
  let mounted = true

  return {
    async track(areaId, request, readinessKey = '') {
      const requestToken = ++token
      const report = await request
      if (!mounted || requestToken !== token) return false
      revision += 1
      onReady({ areaId, revision, readinessKey, report })
      return true
    },
    invalidate() {
      token += 1
    },
    dispose() {
      mounted = false
      token += 1
    },
  }
}

/** Loads all text faces used by the active area and exposes a redraw/rebake revision seam. */
export function useDesignFontReadiness(
  areaId: string | null,
  layers: LabelLayer[],
  uploadedFonts: UploadedFontRecord[],
): number {
  const requests = useMemo(
    () => deriveDesignFontRequests(layers, uploadedFonts),
    [layers, uploadedFonts],
  )
  const signature = requests.map((request) => request.key).join('|')
  const [ready, setReady] = useState<{ areaId: string | null; revision: number; readinessKey: string }>({ areaId: null, revision: 0, readinessKey: '' })
  const gateRef = useRef<FontReadinessRevisionGate | null>(null)

  if (!gateRef.current) {
    gateRef.current = createFontReadinessRevisionGate((event) => {
      setReady({ areaId: event.areaId, revision: event.revision, readinessKey: event.readinessKey })
    })
  }

  useEffect(() => () => gateRef.current?.dispose(), [])

  useEffect(() => {
    const gate = gateRef.current!
    if (!areaId || requests.length === 0) {
      gate.invalidate()
      return
    }
    void gate.track(areaId, loadDesignFontRequests(requests), signature)
    return () => gate.invalidate()
  }, [areaId, signature])

  return ready.areaId === areaId && ready.readinessKey === signature ? ready.revision : 0
}
