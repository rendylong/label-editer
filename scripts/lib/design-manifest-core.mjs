function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function isStrictRfc3339DateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText)
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText)
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText)
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText)
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59
}

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

/** Shared semantic rules after the caller has applied its authoritative JSON schema. */
export function validateManifestSemantics(value, kind) {
  assertUnique(value.areas.map((area) => area.id), 'area id')
  assertUnique(value.artifacts.map((artifact) => artifact.id), 'artifact id')
  assertUnique(value.artifacts.map((artifact) => artifact.path), 'artifact path')
  const areas = new Map(value.areas.map((area) => [area.id, area]))
  const evidenceByArea = new Map()
  const scopedKinds = kind === 'design'
    ? new Set(['mockup-area'])
    : new Set(['flat-artwork', 'surface-face'])
  for (const artifact of value.artifacts) {
    if (scopedKinds.has(artifact.viewKind) && (!artifact.areaId || !artifact.carrier)) {
      throw new Error(`Area-scoped artifact ${artifact.id} requires areaId and carrier`)
    }
    if (!artifact.areaId) continue
    const area = areas.get(artifact.areaId)
    if (!area) throw new Error(`Artifact ${artifact.id} references unknown area id: ${artifact.areaId}`)
    if (artifact.carrier && artifact.carrier !== area.carrier) {
      throw new Error(`Artifact ${artifact.id} carrier does not match area ${artifact.areaId}`)
    }
    if (scopedKinds.has(artifact.viewKind)) {
      const evidence = evidenceByArea.get(artifact.areaId) ?? new Set()
      evidence.add(artifact.viewKind)
      evidenceByArea.set(artifact.areaId, evidence)
    }
  }
  for (const area of value.areas) {
    if (area.carrier === 'bare') continue
    const evidence = evidenceByArea.get(area.id) ?? new Set()
    if (kind === 'design') {
      if (evidence.size === 0) throw new Error(`Area ${area.id} is missing required design-review evidence`)
    } else {
      const missing = ['flat-artwork', 'surface-face'].filter((viewKind) => !evidence.has(viewKind))
      if (missing.length > 0) throw new Error(`Area ${area.id} is missing required evidence: ${missing.join(', ')}`)
    }
  }
}
