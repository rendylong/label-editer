import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'

const schemaPath = path.resolve(import.meta.dirname, '../../src/agent/label-spec-v2.schema.json')
const labelSpecSchema = JSON.parse(readFileSync(schemaPath, 'utf8'))
const projectSchemaPath = path.resolve(import.meta.dirname, '../../src/agent/label-project-v3.schema.json')
const labelProjectSchema = JSON.parse(readFileSync(projectSchemaPath, 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateLabelSpec = ajv.compile(labelSpecSchema)
const validateLabelProject = ajv.compile(labelProjectSchema)

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const AREA_PATCHABLE_FIELDS = new Set([
  'name', 'target', 'surfaceMode', 'side', 'range', 'remap', 'paper', 'print', 'globalCraft',
  'carrier', 'artboard', 'substrate', 'placementPolicy', 'blueprintAreaId', 'designBinding',
])
const OPERATION_FIELDS = {
  'add-area': new Set(['op', 'area', 'index']),
  'update-area': new Set(['op', 'areaId', 'changes']),
  'remove-area': new Set(['op', 'areaId']),
  'add-layer': new Set(['op', 'areaId', 'layer', 'index']),
  'update-layer': new Set(['op', 'areaId', 'layerId', 'changes']),
  'remove-layer': new Set(['op', 'areaId', 'layerId']),
  'move-layer': new Set(['op', 'areaId', 'layerId', 'index']),
}
const LAYER_PATCHABLE_FIELDS = Object.fromEntries(
  ['text', 'image', 'shape'].map((type) => [
    type,
    new Set(Object.keys(labelSpecSchema.$defs[`${type}Layer`].properties).filter((key) => key !== 'id' && key !== 'type')),
  ]),
)

export class ProjectControlError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'ProjectControlError'
    this.code = code
    if (details) this.details = details
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertJsonValue(value, pathName = '/') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${pathName}/${index}`))
    return
  }
  if (!isRecord(value)) throw new ProjectControlError('INVALID_LABEL_SPEC', `Value at ${pathName} is not valid JSON`)
  for (const [key, nested] of Object.entries(value)) {
    if (POLLUTION_KEYS.has(key)) throw new ProjectControlError('INVALID_LABEL_SPEC', `Unsafe key at ${pathName}/${key}`)
    assertJsonValue(nested, `${pathName}/${key}`)
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  )
}

export function canonicalJson(value) {
  assertJsonValue(value)
  return JSON.stringify(canonicalValue(value))
}

export function revisionOf(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`
}

function schemaIssues(validate) {
  return (validate.errors ?? []).map((error) => ({
    path: error.keyword === 'additionalProperties'
      ? `${error.instancePath}/${error.params.additionalProperty}`
      : error.instancePath || '/',
    message: error.message ?? 'invalid value',
    keyword: error.keyword,
  }))
}

function assertUniqueAddressIds(value, errorCode = 'INVALID_LABEL_SPEC') {
  const areaIds = new Set()
  for (const [areaIndex, area] of value.areas.entries()) {
    if (areaIds.has(area.id)) {
      throw new ProjectControlError(errorCode, `Duplicate area id: ${area.id}`, { path: `/areas/${areaIndex}/id` })
    }
    areaIds.add(area.id)
    const layerIds = new Set()
    for (const [layerIndex, layer] of area.layers.entries()) {
      if (layerIds.has(layer.id)) {
        throw new ProjectControlError(errorCode, `Duplicate layer id in area ${area.id}: ${layer.id}`, {
          path: `/areas/${areaIndex}/layers/${layerIndex}/id`,
        })
      }
      layerIds.add(layer.id)
    }
  }
}

function assertLabelSpecV2(value, errorCode = 'INVALID_LABEL_SPEC') {
  assertJsonValue(value)
  if (!validateLabelSpec(value)) {
    throw new ProjectControlError(errorCode, 'Label Spec schema validation failed', { issues: schemaIssues(validateLabelSpec) })
  }
  assertUniqueAddressIds(value, errorCode)
}

function assertLabelProjectV3(value) {
  assertJsonValue(value)
  if (!validateLabelProject(value)) {
    throw new ProjectControlError('INVALID_LABEL_SPEC', 'Label Project v3 schema validation failed', {
      issues: schemaIssues(validateLabelProject),
    })
  }
  for (const [areaIndex, area] of value.areas.entries()) {
    if (Math.hypot(...area.remap.axis) <= 1e-9) {
      throw new ProjectControlError('INVALID_LABEL_SPEC', 'Label Project remap axis cannot be zero', {
        path: `/areas/${areaIndex}/remap/axis`,
      })
    }
    if (area.range.uStart + area.range.uWidth > 1 + 1e-9
      || area.range.vStart + area.range.vHeight > 1 + 1e-9) {
      throw new ProjectControlError('INVALID_LABEL_SPEC', 'Label Project range exceeds normalized bounds', {
        path: `/areas/${areaIndex}/range`,
      })
    }
    for (let dimension = 0; dimension < 3; dimension += 1) {
      if (area.remap.planarBox.min[dimension] > area.remap.planarBox.max[dimension]) {
        throw new ProjectControlError('INVALID_LABEL_SPEC', 'Label Project planar bounds are inverted', {
          path: `/areas/${areaIndex}/remap/planarBox`,
        })
      }
    }
  }
  assertUniqueAddressIds(value)
}

function summary(value, kind) {
  return {
    kind,
    revision: revisionOf(value),
    areaCount: value.areas.length,
    areas: value.areas.map((area) => ({
      id: area.id,
      name: area.name,
      layerCount: area.layers.length,
      layerIds: area.layers.map((layer) => layer.id),
    })),
    value: structuredClone(value),
  }
}

export function inspectProject(value) {
  if (value?.version === 2) {
    assertLabelSpecV2(value)
    return summary(value, 'label-spec-v2')
  }
  if (value?.version === 3) {
    assertLabelProjectV3(value)
    return summary(value, 'label-project-v3')
  }
  throw new ProjectControlError('INVALID_LABEL_SPEC', `Unsupported label document version: ${String(value?.version)}`)
}

function invalidOperation(message, details) {
  throw new ProjectControlError('INVALID_PATCH_OPERATION', message, details)
}

function assertOnlyFields(value, allowed, label) {
  if (!isRecord(value)) invalidOperation(`${label} must be an object`)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidOperation(`${label} contains an unsupported field: ${key}`)
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) invalidOperation(`${label} must be a non-empty string`)
  return value
}

function requireIndex(value, length, { insertion = false } = {}) {
  const maximum = insertion ? length : length - 1
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    invalidOperation(`index must be an integer between 0 and ${maximum}`)
  }
  return value
}

function findArea(draft, areaId) {
  requireString(areaId, 'areaId')
  const index = draft.areas.findIndex((area) => area.id === areaId)
  if (index < 0) invalidOperation(`Area not found: ${areaId}`)
  return { area: draft.areas[index], index }
}

function findLayer(area, layerId) {
  requireString(layerId, 'layerId')
  const index = area.layers.findIndex((layer) => layer.id === layerId)
  if (index < 0) invalidOperation(`Layer not found in area ${area.id}: ${layerId}`)
  return { layer: area.layers[index], index }
}

function applyOperation(draft, operation) {
  if (!isRecord(operation) || typeof operation.op !== 'string' || !(operation.op in OPERATION_FIELDS)) {
    invalidOperation(`Unsupported patch operation: ${String(operation?.op)}`)
  }
  assertOnlyFields(operation, OPERATION_FIELDS[operation.op], operation.op)

  if (operation.op === 'add-area') {
    if (!isRecord(operation.area)) invalidOperation('add-area.area must be an object')
    requireString(operation.area.id, 'add-area.area.id')
    if (draft.areas.some((area) => area.id === operation.area.id)) invalidOperation(`Duplicate area id: ${operation.area.id}`)
    const index = operation.index === undefined
      ? draft.areas.length
      : requireIndex(operation.index, draft.areas.length, { insertion: true })
    draft.areas.splice(index, 0, structuredClone(operation.area))
    return
  }

  const { area, index: areaIndex } = findArea(draft, operation.areaId)
  if (operation.op === 'update-area') {
    assertOnlyFields(operation.changes, AREA_PATCHABLE_FIELDS, 'update-area.changes')
    Object.assign(area, structuredClone(operation.changes))
    return
  }
  if (operation.op === 'remove-area') {
    draft.areas.splice(areaIndex, 1)
    return
  }
  if (operation.op === 'add-layer') {
    if (!isRecord(operation.layer)) invalidOperation('add-layer.layer must be an object')
    requireString(operation.layer.id, 'add-layer.layer.id')
    if (area.layers.some((layer) => layer.id === operation.layer.id)) invalidOperation(`Duplicate layer id in area ${area.id}: ${operation.layer.id}`)
    const index = operation.index === undefined
      ? area.layers.length
      : requireIndex(operation.index, area.layers.length, { insertion: true })
    area.layers.splice(index, 0, structuredClone(operation.layer))
    return
  }

  const { layer, index: layerIndex } = findLayer(area, operation.layerId)
  if (operation.op === 'update-layer') {
    const allowed = LAYER_PATCHABLE_FIELDS[layer.type]
    if (!allowed) invalidOperation(`Unsupported existing layer type: ${String(layer.type)}`)
    assertOnlyFields(operation.changes, allowed, 'update-layer.changes')
    Object.assign(layer, structuredClone(operation.changes))
    return
  }
  if (operation.op === 'remove-layer') {
    area.layers.splice(layerIndex, 1)
    return
  }
  if (operation.op === 'move-layer') {
    const target = requireIndex(operation.index, area.layers.length)
    const [moved] = area.layers.splice(layerIndex, 1)
    area.layers.splice(target, 0, moved)
  }
}

function assertPatchDocument(document) {
  if (!isRecord(document)) invalidOperation('Patch document must be an object')
  assertOnlyFields(document, new Set(['version', 'baseRevision', 'operations']), 'patch document')
  if (document.version !== 1) invalidOperation('Patch document version must be 1')
  if (!/^sha256:[a-f0-9]{64}$/.test(document.baseRevision ?? '')) invalidOperation('baseRevision must be a sha256 revision')
  if (!Array.isArray(document.operations)) invalidOperation('operations must be an array')
}

export function patchLabelSpec(input, document) {
  assertLabelSpecV2(input)
  assertPatchDocument(document)
  const previousRevision = revisionOf(input)
  if (document.baseRevision !== previousRevision) {
    throw new ProjectControlError('REVISION_CONFLICT', 'The Label Spec changed after it was inspected', {
      expected: document.baseRevision,
      actual: previousRevision,
    })
  }

  const draft = structuredClone(input)
  for (const [index, operation] of document.operations.entries()) {
    try {
      applyOperation(draft, operation)
      assertUniqueAddressIds(draft, 'INVALID_PATCH_OPERATION')
    } catch (error) {
      if (error?.code === 'INVALID_PATCH_OPERATION') {
        error.details = { ...(error.details ?? {}), operationIndex: index }
      }
      throw error
    }
  }
  try {
    assertLabelSpecV2(draft, 'INVALID_PATCH_OPERATION')
  } catch (error) {
    if (error?.code === 'INVALID_PATCH_OPERATION') {
      error.message = `Patched Label Spec is invalid: ${error.message}`
    }
    throw error
  }

  return {
    previousRevision,
    revision: revisionOf(draft),
    appliedOperationCount: document.operations.length,
    value: draft,
  }
}
