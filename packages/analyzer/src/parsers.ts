import { createRequire } from 'node:module'
import { Language, type Node, Parser } from 'web-tree-sitter'

const require = createRequire(import.meta.url)

export type LanguageId = 'python' | 'typescript' | 'tsx'

export interface Parsers {
  parse(language: LanguageId, text: string): Node
}

const GRAMMARS: Record<LanguageId, string> = {
  python: 'tree-sitter-python/tree-sitter-python.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
}

let loading: Promise<Parsers> | undefined

/** Loads the WASM grammars once per process (ADR 0008). */
export function loadParsers(): Promise<Parsers> {
  loading ??= (async () => {
    await Parser.init()
    const parsers = new Map<LanguageId, Parser>()
    for (const [id, spec] of Object.entries(GRAMMARS) as [LanguageId, string][]) {
      const parser = new Parser()
      parser.setLanguage(await Language.load(require.resolve(spec)))
      parsers.set(id, parser)
    }
    return {
      parse(language, text) {
        const tree = (parsers.get(language) as Parser).parse(text)
        if (!tree) throw new Error(`tree-sitter returned no tree for ${language}`)
        return tree.rootNode
      },
    }
  })()
  return loading
}

export function languageOf(path: string): LanguageId | undefined {
  if (path.endsWith('.py')) return 'python'
  if (path.endsWith('.tsx')) return 'tsx'
  if (path.endsWith('.ts')) return 'typescript'
  return undefined
}

/** Number of ERROR or MISSING nodes, so partial extraction is reported rather than hidden. */
export function countSyntaxErrors(root: Node): number {
  let count = 0
  const walk = (n: Node) => {
    if (n.isMissing || n.isError) count++
    if (!n.hasError) return
    for (const c of n.children) walk(c)
  }
  if (root.hasError) walk(root)
  return count
}

export type { Node }
