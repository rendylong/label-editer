const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const MAX_PNG_BYTES = 256 * 1024 * 1024
const MAX_PNG_DIMENSION = 1_000_000
const MAX_PNG_PIXELS = 268_435_456
let crcTable

function table() {
  if (crcTable) return crcTable
  crcTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1)
    return crc >>> 0
  })
  return crcTable
}

function crc32(bytes, start, end) {
  let crc = 0xffffffff
  const values = table()
  for (let index = start; index < end; index += 1) crc = values[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function readU32(bytes, offset) {
  return ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0
}

function fail(message) { throw new Error(`Invalid PNG: ${message}`) }

export function parsePortablePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (bytes.length < 8 || bytes.length > MAX_PNG_BYTES || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) fail('signature or size')
  let offset = 8; let width; let height; let colorType; let sawIhdr = false; let sawPlte = false; let sawIdat = false; let endedIdat = false; let sawIend = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail('truncated chunk')
    const length = readU32(bytes, offset)
    const typeOffset = offset + 4; const dataOffset = offset + 8; const dataEnd = dataOffset + length; const chunkEnd = dataEnd + 4
    if (length > MAX_PNG_BYTES || dataEnd < dataOffset || chunkEnd > bytes.length) fail('illegal chunk length')
    const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4))
    if (!/^[A-Za-z]{4}$/.test(type)) fail('invalid chunk type')
    if (readU32(bytes, dataEnd) !== crc32(bytes, typeOffset, dataEnd)) fail(`${type} CRC mismatch`)
    if (!sawIhdr && type !== 'IHDR') fail('IHDR must be first')
    if (type === 'IHDR') {
      if (sawIhdr || length !== 13) fail('invalid IHDR')
      sawIhdr = true; width = readU32(bytes, dataOffset); height = readU32(bytes, dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]; colorType = bytes[dataOffset + 9]
      const validDepths = colorType === 0 ? [1, 2, 4, 8, 16]
        : colorType === 2 || colorType === 4 || colorType === 6 ? [8, 16]
          : colorType === 3 ? [1, 2, 4, 8] : []
      if (!(width > 0) || !(height > 0) || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION || width * height > MAX_PNG_PIXELS) fail('invalid dimensions')
      if (!validDepths.includes(bitDepth) || bytes[dataOffset + 10] !== 0 || bytes[dataOffset + 11] !== 0 || bytes[dataOffset + 12] > 1) fail('invalid IHDR fields')
    } else if (type === 'PLTE') {
      if (sawPlte || sawIdat || colorType === 0 || colorType === 4 || length === 0 || length % 3 !== 0 || length > 768) fail('invalid PLTE')
      sawPlte = true
    } else if (type === 'IDAT') {
      if (!sawIhdr || sawIend || endedIdat || (colorType === 3 && !sawPlte)) fail('invalid IDAT order')
      sawIdat = true
    } else if (type === 'IEND') {
      if (!sawIdat || sawIend || length !== 0) fail('invalid IEND')
      sawIend = true
      if (chunkEnd !== bytes.length) fail('data after IEND')
    } else {
      if (sawIdat) endedIdat = true
      if (type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90) fail(`unknown critical chunk ${type}`)
    }
    offset = chunkEnd
  }
  if (!sawIhdr || !sawIdat || !sawIend || offset !== bytes.length) fail('missing required chunks')
  return Object.freeze({ width, height })
}

export function portablePngDimensions(input) {
  try { return parsePortablePng(input) } catch { return undefined }
}
