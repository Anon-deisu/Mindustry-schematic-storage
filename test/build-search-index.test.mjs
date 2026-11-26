import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const builder = fileURLToPath(new URL("../build-search-index.mjs", import.meta.url))
const byte = n => Buffer.from([n])
const short = n => Buffer.from([n >> 8, n & 255])
function int(n) {
  const bytes = Buffer.alloc(4)
  bytes.writeInt32BE(n)
  return bytes
}

function utf(text) {
  // Java writeUTF uses UTF-16 code units, including for supplementary characters.
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (ch >= 1 && ch <= 0x7f) bytes.push(ch)
    else if (ch <= 0x7ff) bytes.push(0xc0 | (ch >> 6), 0x80 | (ch & 63))
    else bytes.push(0xe0 | (ch >> 12), 0x80 | ((ch >> 6) & 63), 0x80 | (ch & 63))
  }
  return Buffer.concat([short(bytes.length), Buffer.from(bytes)])
}

const text = value => Buffer.concat([byte(4), byte(1), utf(value)])
const byteArray = bytes => Buffer.concat([byte(14), int(bytes.length), bytes])

function msch(version, tags, tiles) {
  const entries = Object.entries(tags)
  const names = [...new Set(tiles.map(([name]) => name))]
  const payload = Buffer.concat([
    short(250), short(3), byte(entries.length), ...entries.flatMap(([k, v]) => [utf(k), utf(v)]),
    byte(names.length), ...names.map(utf), int(tiles.length),
    ...tiles.flatMap(([name, config], i) => [byte(names.indexOf(name)), int(i << 16), config, byte(0)]),
  ])
  return Buffer.concat([Buffer.from("msch"), byte(version), deflateSync(payload)])
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "msch-search-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const schematics = join(root, "schematics")
  const bucket = join(schematics, "000001-001000")
  const out = join(root, "search-index.js")
  mkdirSync(bucket, { recursive: true })
  return {
    out,
    file: name => join(bucket, name),
    run: () => spawnSync(process.execPath, [builder, "--schematics", schematics, "--out", out], {
      cwd: root, encoding: "utf8",
    }),
  }
}

test("builds a reproducible standalone JS index from old and new schematics", async t => {
  const { file, out, run } = fixture(t)
  const name = "[accent]銅牆😀[]"
  const board = "By [Alice] 金屬 [#ffd37f]張龍顯[] \u0000"
  writeFileSync(file("10_現代.msch"), msch(1, {
    name,
    description: "[green]支援Ａ裝置[]",
    author: "鍾明",
    labels: '[未分類,"有,逗號",]',
  }, [
    ["bridge-conveyor", byte(0)], ["phase-conveyor", byte(0)],
    ["message", text(board)], ["reinforced-message", text("觀測")],
    ["world-message", text("頭髮")], ["message", text(board)],
    ["micro-processor", byteArray(Buffer.from("code-not-a-message"))],
    ["silicon-smelter", byte(0)], ["ground-factory", Buffer.concat([byte(1), int(-1)])],
    ["air", byte(0)], ["custom-mod-block", byte(0)],
  ]))
  writeFileSync(file("2_舊版.msch"), msch(0, { name: "舊版", labels: '["標籤"]' }, [
    ["bridge-conveyor", int(0)], ["conveyor", int(0)],
  ]))

  const first = run()
  assert.equal(first.status, 0, first.stderr)
  const bytes = readFileSync(out)
  const second = run()
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(readFileSync(out), bytes)

  // Import with no local package, query module, or path dependencies.
  const { default: index, search, normalizeSearchText } = await import(`data:text/javascript;base64,${bytes.toString("base64")}`)
  assert.equal(index.formatVersion, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(index)), index)
  const doc = index.documents[10]
  assert.equal(doc.path, "schematics/000001-001000/10_現代.msch")
  assert.equal(doc.name, name)
  assert.equal(doc.width, 250)
  assert.deepEqual(doc.labels, ["未分類", "有,逗號", ""])
  assert.deepEqual(doc.messages, [board, "觀測", "頭髮"])
  assert.equal(doc.blocks.air, undefined)
  assert.equal(doc.blocks["custom-mod-block"], 1)
  assert.equal(normalizeSearchText("銅牆 Ｔ１２"), "铜墙 t12")
  const hits = (...args) => search(...args).map(doc => doc.id)
  assert.deepEqual(hits("銅", "name"), hits("铜", "name"))
  assert.deepEqual(hits("銅牆😀", "name"), [10])
  assert.deepEqual(hits("牆銅", "name"), [])
  assert.deepEqual(hits("支援a装置", "description"), [10])
  assert.deepEqual(hits("張龍顯", "author"), [10])
  assert.deepEqual(hits("钟明", "author"), [10])
  assert.deepEqual(hits("[Alice]", "message"), [10])
  assert.deepEqual(hits("发", "message"), [10])
  assert.deepEqual(hits("有,逗号", "label"), [10])
  assert.deepEqual(hits("code-not-a-message"), [])
  assert.deepEqual(hits("桥", "block"), [2, 10])
  assert.deepEqual(hits("橋", "block", 2), [10])
  assert.deepEqual(hits("传送带桥", "block", 1), [2])
  assert.deepEqual(hits("銅", "material"), [2, 10])
  assert.deepEqual(hits("銅"), [10])
  assert.deepEqual(hits("硅", "output"), [10])
  assert.deepEqual(hits("煤", "input"), [10])
  assert.deepEqual(hits("crawler", "unit"), [10])
})

test("does not replace an index after a parse error or a duplicate ID", t => {
  const { out, file, run } = fixture(t)
  const previous = "export default {}\n"
  writeFileSync(out, previous)
  writeFileSync(file("7_broken.msch"), Buffer.from("msch\x01"))
  let result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /7_broken\.msch/)
  assert.equal(readFileSync(out, "utf8"), previous)

  writeFileSync(file("7_broken.msch"), msch(1, { name: "fixture" }, []))
  writeFileSync(file("7_duplicate.msch"), msch(1, { name: "duplicate" }, []))
  result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Duplicate schematic ID 7/)
  assert.equal(readFileSync(out, "utf8"), previous)
})
