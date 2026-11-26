// These functions run unchanged in the builder and in the published browser module.
export function makeNormalizer(folding) {
  const characters = Array.from(folding)
  const simplified = new Map()
  for (let i = 0; i < characters.length; i += 2) {
    simplified.set(characters[i], characters[i + 1])
  }
  const colors = new Set((
    "clear black white lightgray lightgrey gray grey darkgray darkgrey blue navy royal slate sky cyan teal " +
    "green acid lime forest olive yellow gold goldenrod orange brown tan brick red scarlet crimson coral " +
    "salmon pink magenta purple violet maroon accent unlaunched highlight stat negstat"
  ).split(" "))
  return function normalize(text) {
    return text.normalize("NFKC").replace(/\[\[|\[([^\]\r\n]*)\]/g, (match, tag) => {
      if (match === "[[") return "["
      if (!tag || /^#(?:[a-f0-9]{1,6}|[a-f0-9]{8})$/i.test(tag)) return ""
      return colors.has(tag.toLowerCase().replaceAll("_", "")) ? "" : match
    }).toLowerCase().replace(/\p{Unified_Ideograph}/gu, ch => simplified.get(ch) ?? ch)
      .replace(/\s+/gu, " ").trim()
  }
}

export function documentText(doc, field) {
  switch (field) {
    case "all": return [doc.name, doc.description, doc.author, ...doc.labels, ...doc.messages]
    case "name": return [doc.name]
    case "description": return [doc.description]
    case "author": return [doc.author, doc.description, ...doc.messages]
    case "label": return doc.labels
    case "message": return doc.messages
    default: throw new RangeError(`Unknown text field: ${field}`)
  }
}

export function makeSearch(index, normalize) {
  const textFields = new Set(["all", "name", "description", "author", "label", "message"])
  const contentFields = new Set(["all", "block", "material", "input", "output", "unit"])
  const { blocks, names } = index.catalog
  function contentNames(ids = [], dictionary) {
    return ids.flatMap(id => Object.hasOwn(dictionary, id) ? [id, dictionary[id]] : [id])
  }
  // Many schematics contain the same buildings. Match content names once per building type.
  const buildings = Object.entries(index.postings.block).map(([id, ids]) => {
    const block = Object.hasOwn(blocks, id) ? blocks[id] : {}
    const fields = {
      block: block.name ? [id, id.replaceAll("-", " "), block.name] : [id, id.replaceAll("-", " ")],
      material: contentNames(Object.keys(block.materials ?? {}), names.item),
      input: [...contentNames(block.itemInputs, names.item), ...contentNames(block.liquidInputs, names.liquid)],
      output: [...contentNames(block.itemOutputs, names.item), ...contentNames(block.liquidOutputs, names.liquid)],
      unit: contentNames(block.units, names.unit),
    }
    for (const key of Object.keys(fields)) fields[key] = [...new Set(fields[key].map(normalize))]
    fields.all = [...fields.block, ...fields.input, ...fields.output, ...fields.unit]
    return { id, fields, ids }
  })

  return function search(text, field = "all", count) {
    if (!textFields.has(field) && !contentFields.has(field)) throw new RangeError(`Unknown search field: ${field}`)
    if (count !== undefined && (field !== "block" || !Number.isSafeInteger(count) || count < 1)) {
      throw new RangeError("Count requires the block field and a positive integer")
    }
    const term = normalize(text)
    if (!term) return []
    const matches = new Set()
    if (textFields.has(field)) {
      // Every literal hit contains the rarest character. Verify complete substrings on its shortlist.
      const lists = Array.from(new Set(term), ch => index.postings.text[ch] ?? [])
      const candidates = lists.reduce((smallest, list) => list.length < smallest.length ? list : smallest)
      for (const id of candidates) {
        if (documentText(index.documents[id], field).some(value => normalize(value).includes(term))) matches.add(id)
      }
    }
    if (contentFields.has(field)) {
      const matchingBlocks = buildings.filter(block => block.fields[field].some(value => value.includes(term)))
      const quantities = new Map()
      for (const { id: blockId, ids } of matchingBlocks) {
        for (const id of ids) {
          if (count === undefined) matches.add(id)
          else quantities.set(id, (quantities.get(id) ?? 0) + index.documents[id].blocks[blockId])
        }
      }
      for (const [id, quantity] of quantities) {
        if (quantity === count) matches.add(id)
      }
    }
    return [...matches].sort((a, b) => a - b).map(id => index.documents[id])
  }
}
