function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$]/u.test(value)
}

function quotedEnd(contents: string, start: number, quote: string): number {
  let index = start + 1
  while (index < contents.length) {
    if (contents[index] === '\\') {
      index += 2
      continue
    }
    if (contents[index] === quote) return index
    index += 1
  }
  return contents.length
}

function blockCommentEnd(contents: string, start: number): number {
  const end = contents.indexOf('*/', start + 2)
  return end === -1 ? contents.length : end + 2
}

function lineCommentEnd(contents: string, start: number): number {
  const end = contents.indexOf('\n', start + 2)
  return end === -1 ? contents.length : end + 1
}

export function extractStaticCssImports(contents: string): readonly string[] {
  const imports: string[] = []
  const seen = new Set<string>()
  let index = 0

  while (index < contents.length) {
    const character = contents[index]
    const next = contents[index + 1]

    if (character === '/' && next === '/') {
      index = lineCommentEnd(contents, index)
      continue
    }
    if (character === '/' && next === '*') {
      index = blockCommentEnd(contents, index)
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      index = quotedEnd(contents, index, character) + 1
      continue
    }

    if (
      contents.startsWith('import', index) &&
      !isIdentifierCharacter(contents[index - 1]) &&
      !isIdentifierCharacter(contents[index + 'import'.length])
    ) {
      let specifierStart = index + 'import'.length
      while (/\s/u.test(contents[specifierStart] ?? '')) specifierStart += 1
      const quote = contents[specifierStart]
      if (quote === "'" || quote === '"') {
        const end = quotedEnd(contents, specifierStart, quote)
        if (end < contents.length) {
          const specifier = contents.slice(specifierStart + 1, end)
          if (/\.css(?:[?#].*)?$/u.test(specifier) && !seen.has(specifier)) {
            imports.push(specifier)
            seen.add(specifier)
          }
          index = end + 1
          continue
        }
      }
    }

    index += 1
  }

  return Object.freeze(imports)
}
