import { createWriteStream, readFileSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { inflateSync } from 'node:zlib'
import { documentText, makeNormalizer } from './search-data/query.mjs'

const messageBlockIds = new Set(['message', 'reinforced-message', 'world-message'])
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// Java writeUTF encodes NUL as C0 80 and each UTF-16 surrogate separately.
// Decode the ordinary spans as UTF-8 to also accept third-party four-byte characters.
function decodeSchematicUtf(bytes) {
  let text = ''
  let start = 0
  for (let i = 0; i < bytes.length; i++) {
    const first = bytes[i]
    let unit, size
    if (first === 0xc0 && bytes[i + 1] === 0x80) {
      unit = 0
      size = 2
    } else if (first === 0xed && (bytes[i + 1] & 0xe0) === 0xa0 && (bytes[i + 2] & 0xc0) === 0x80) {
      unit = 0xd000 | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      size = 3
    } else {
      continue
    }
    text += utf8.decode(bytes.subarray(start, i)) + String.fromCharCode(unit)
    start = i + size
    i = start - 1
  }
  return text + utf8.decode(bytes.subarray(start))
}

class SchematicReader {
  constructor(bytes) {
    this.bytes = bytes
    this.offset = 0
  }

  get remaining() {
    return this.bytes.length - this.offset
  }

  take(size) {
    const start = this.offset
    if (size < 0) throw new Error(`Negative length at schematic offset ${start}`)
    if (size > this.remaining) throw new Error(`Truncated schematic at offset ${start} (need ${size} bytes)`)
    this.offset += size
    return start
  }

  u8() {
    return this.bytes[this.take(1)]
  }

  i16() {
    return this.bytes.readInt16BE(this.take(2))
  }

  i32() {
    return this.bytes.readInt32BE(this.take(4))
  }

  utf(decode = true) {
    const length = this.bytes.readUInt16BE(this.take(2))
    const start = this.take(length)
    if (decode) return decodeSchematicUtf(this.bytes.subarray(start, start + length))
  }
}

const labelEscapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }

// Arc minimal JSON can mix bare and quoted strings in a single labels array.
// Only a quote at the start opens a quoted label. Quotes inside a bare label are literal.
function parseSchematicLabels(source) {
  const text = source.trim()
  const end = text.length - 1
  if (text[0] !== '[' || text[end] !== ']') throw new Error('Invalid schematic labels array')
  const labels = []
  let i = 1
  while (i < end) {
    while (i < end && /[ \t\r\n]/.test(text[i])) i++
    if (i === end) break
    let label
    if (text[i] === '"') {
      const start = ++i
      while (i < end && text[i] !== '"') {
        if (text[i] === '\\') i++
        i++
      }
      if (i >= end) throw new Error('Unterminated quoted schematic label')
      label = text.slice(start, i++)
    } else {
      const start = i
      while (i < end && !/[,\r\n]/.test(text[i])) i++
      label = text.slice(start, i).trimEnd()
      if (!label.length) throw new Error('Missing schematic label')
    }
    labels.push(label.replace(/\\(?:u([\da-fA-F]{4})|([\s\S])|$)/g, (_, hex, escape) => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16))
      if (!Object.hasOwn(labelEscapes, escape)) throw new Error('Invalid escape in schematic label')
      return labelEscapes[escape]
    }))
    const separator = i
    while (i < end && /[ \t\r\n]/.test(text[i])) i++
    if (i < end && text[i] === ',') i++
    else if (i < end && !/[\r\n]/.test(text.slice(separator, i))) throw new Error('Missing schematic label separator')
  }
  return labels
}

// TypeIO.readObject, Mindustry v160.4. An object array is a sequence of tagged
// values, so its children can be skipped iteratively without allocating an array.
function readSchematicConfig(reader, captureText) {
  let pending = 1
  while (pending > 0) {
    pending--
    const type = reader.u8()
    switch (type) {
      case 0: // null
        break
      case 1: // Integer
      case 3: // Float
      case 12: // Building
      case 17: // Unit
        reader.take(4)
        break
      case 2: // Long
      case 7: // Point2
      case 11: // Double
      case 19: // Vec2
        reader.take(8)
        break
      case 4: // nullable String
        if (reader.u8() !== 0) {
          const value = reader.utf(captureText)
          if (captureText) return value
        }
        break
      case 5: // Content
      case 9: // TechNode
        reader.take(3)
        break
      case 6: // IntSeq
      case 21: // int[]
        reader.take(reader.i16() * 4)
        break
      case 8: // Point2[] (packed ints)
        reader.take(reader.u8() * 4)
        break
      case 10: // Boolean
      case 15: // legacy unit command
      case 20: // Team
        reader.take(1)
        break
      case 13: // LAccess
      case 23: // UnitCommand
        reader.take(2)
        break
      case 14: // byte[] (also logic and canvas data)
      case 16: // boolean[]
        reader.take(reader.i32())
        break
      case 18: // Vec2[]
        reader.take(reader.i16() * 8)
        break
      case 22: { // Object[]
        const count = reader.i32()
        if (count < 0 || count + pending > reader.remaining) throw new Error(`Invalid object array length ${count} at schematic offset ${reader.offset}`)
        pending += count
        break
      }
      default:
        throw new Error(`Unknown TypeIO type ${type} at schematic offset ${reader.offset - 1}`)
    }
    captureText = false
  }
}

export function readSchematic(buffer) {
  const input = ArrayBuffer.isView(buffer)
    ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : Buffer.from(buffer)
  if (input.length < 5 || input.readUInt32BE(0) !== 0x6d736368) throw new Error('Invalid or truncated msch header')
  const version = input[4]
  if (version > 1) throw new Error(`Unknown msch version ${version}`)

  // Like Java's InflaterInputStream, stop at the end of the first zlib stream.
  // Some archived files have a suffix after its checksum.
  const reader = new SchematicReader(inflateSync(input.subarray(5)))
  // Keep the stored signed dimensions verbatim, including legacy -1 placeholders.
  const width = reader.i16()
  const height = reader.i16()

  const tags = { name: '', description: '', labels: '[]', author: '' }
  const tagCount = reader.u8()
  for (let i = 0; i < tagCount; i++) {
    const key = reader.utf()
    const wanted = Object.hasOwn(tags, key)
    const value = reader.utf(wanted)
    if (wanted) tags[key] = value
  }

  const dictionary = Array.from({ length: reader.u8() }, () => reader.utf())
  const isMessage = dictionary.map(id => messageBlockIds.has(id))
  const counts = new Uint32Array(dictionary.length)
  const messages = new Set()
  const tileCount = reader.i32()
  const minTileSize = version === 0 ? 10 : 7
  if (tileCount < 0 || tileCount * minTileSize > reader.remaining) throw new Error(`Invalid or truncated schematic tile count ${tileCount}`)
  for (let i = 0; i < tileCount; i++) {
    const id = reader.u8()
    if (id >= dictionary.length) throw new Error(`Unknown block dictionary index ${id} at tile ${i}`)
    counts[id]++
    reader.take(4) // packed position
    if (version === 0) {
      reader.take(4) // legacy integer config
    } else {
      const message = readSchematicConfig(reader, isMessage[id])
      if (message?.trim()) messages.add(message)
    }
    reader.take(1) // rotation
  }
  // Some third-party writers compress a zero-padded backing buffer.
  if (reader.remaining && reader.bytes.subarray(reader.offset).some(byte => byte !== 0)) {
    throw new Error(`Unexpected data after schematic tiles at offset ${reader.offset}`)
  }

  const blocks = new Map()
  for (const [i, count] of counts.entries()) {
    if (count && dictionary[i] !== 'air') blocks.set(dictionary[i], (blocks.get(dictionary[i]) ?? 0) + count)
  }
  return {
    width, height, name: tags.name, description: tags.description,
    labels: parseSchematicLabels(tags.labels), author: tags.author,
    messages: [...messages], blocks: Object.fromEntries(blocks),
  }
}

function* schematicFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) yield* schematicFiles(file)
    else if (entry.isFile() && extname(file).toLowerCase() === '.msch') yield file
  }
}

function collectFiles(directory) {
  const files = new Map()
  for (const file of schematicFiles(directory)) {
    const match = /^(\d+)(?:_|\.msch$)/i.exec(basename(file))
    const id = match && Number(match[1])
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`Expected a numeric schematic ID in ${file}`)
    if (files.has(id)) throw new Error(`Duplicate schematic ID ${id}: ${files.get(id)} and ${file}`)
    files.set(id, file)
  }
  return [...files].sort(([a], [b]) => a - b)
}

function addPosting(postings, key, id) {
  const list = postings.get(key)
  if (list) list.push(id)
  else postings.set(key, [id])
}

export function buildIndex(directory) {
  const catalog = JSON.parse(readFileSync(new URL('./search-data/catalog.json', import.meta.url), 'utf8'))
  const normalize = makeNormalizer(catalog.folding)
  const documents = {}
  const textPostings = new Map()
  const blockPostings = new Map()
  for (const [id, file] of collectFiles(directory)) {
    const path = relative(dirname(directory), file).split(sep).join('/')
    let fields
    try {
      fields = readSchematic(readFileSync(file))
    } catch (error) {
      throw new Error(`${path}: ${error.message}`, { cause: error })
    }
    const doc = { id, path, ...fields }
    if (!doc.name) doc.name = basename(file).replace(/^\d+_?/, '').replace(/\.msch$/i, '')
    documents[id] = doc
    const characters = new Set()
    for (const value of documentText(doc, 'all')) {
      for (const character of normalize(value)) characters.add(character)
    }
    for (const ch of characters) addPosting(textPostings, ch, id)
    for (const block of Object.keys(doc.blocks)) addPosting(blockPostings, block, id)
  }
  return {
    formatVersion: 1, catalog, documents,
    postings: { text: Object.fromEntries(textPostings), block: Object.fromEntries(blockPostings) },
  }
}

// Each generated string is one JSON fragment. JSON.parse preserves arbitrary map
// keys (even "__proto__"); encoding the fragment again keeps all schematic text literal JS data.
function* mapFragments(map) {
  let separator = ''
  for (const [key, value] of Object.entries(map)) {
    yield separator + JSON.stringify(key) + ':' + JSON.stringify(value)
    separator = ','
  }
}

function* jsonFragments(index) {
  yield `{"formatVersion":${index.formatVersion},"catalog":${JSON.stringify(index.catalog)},"documents":{`
  yield* mapFragments(index.documents)
  yield '},"postings":{"text":{'
  yield* mapFragments(index.postings.text)
  yield '},"block":{'
  yield* mapFragments(index.postings.block)
  yield '}}}'
}

function* moduleLines(index) {
  yield '// Generated by build-search-index.mjs. Dictionary sources and licenses: search-data/SOURCES.md\n'
  yield 'const index = JSON.parse([\n'
  for (const fragment of jsonFragments(index)) {
    const literal = JSON.stringify(fragment).replaceAll('<', '\\u003c')
      .replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
    yield `  ${literal},\n`
  }
  yield "].join('\\n'))\nexport default index\n\n"
  const runtime = readFileSync(new URL('./search-data/query.mjs', import.meta.url), 'utf8')
  yield runtime.replaceAll('\r\n', '\n')
  yield '\nexport const normalizeSearchText = makeNormalizer(index.catalog.folding)\n'
  yield 'export const search = makeSearch(index, normalizeSearchText)\n'
}

async function main() {
  const { values } = parseArgs({ options: {
    schematics: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } })
  if (values.help) {
    console.log('node build-search-index.mjs [--schematics <directory>] [--out <search-index.js>]')
    return
  }
  const root = dirname(fileURLToPath(import.meta.url))
  const source = resolve(values.schematics ?? join(root, 'schematics'))
  const out = resolve(values.out ?? join(root, 'search-index.js'))
  if (extname(out).toLowerCase() !== '.js') throw new Error('--out must name a .js file')
  const index = buildIndex(source)
  await mkdir(dirname(out), { recursive: true })
  const temp = `${out}.${randomUUID()}.tmp`
  try {
    await pipeline(Readable.from(moduleLines(index)), createWriteStream(temp, { flags: 'wx' }))
    await rename(temp, out)
  } finally {
    await rm(temp, { force: true })
  }
  console.log(`Indexed ${Object.keys(index.documents).length} schematics -> ${out}`)
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
