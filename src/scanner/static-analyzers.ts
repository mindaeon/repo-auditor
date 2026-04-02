/**
 * Static analyzers for three issue categories that were previously stubs:
 *  - broken-import   : relative imports that resolve to no file on disk
 *  - hardcoded-url   : absolute http/https URLs baked into source code
 *  - circular-dep    : import cycles in the module graph (DFS)
 *
 * Also exports buildDependencyGraph() which populates the DependencyGraph
 * that was previously always empty.
 */

import path from 'node:path'
import { glob } from 'glob'
import { Project, Node } from 'ts-morph'
import type { Issue, DependencyGraph, DependencyEdge } from '../types.js'

// ─── Broken imports ───────────────────────────────────────────────────────────

/**
 * Uses ts-morph's import resolution: if getModuleSpecifierSourceFile() returns
 * undefined the import is unresolvable (file missing or wrong extension).
 * Only checks relative imports (starts with '.') to avoid noise from missing
 * node_modules types.
 */
export async function detectBrokenImports(
  rootDir: string,
  project: Project,
): Promise<Issue[]> {
  const issues: Issue[] = []
  let id = 0

  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.d.ts'],
  })

  for (const file of files) {
    const sf = project.addSourceFileAtPath(file)

    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue()
      if (!spec.startsWith('.')) continue  // skip node_modules / path aliases

      const resolved = imp.getModuleSpecifierSourceFile()
      if (!resolved) {
        issues.push({
          id: `broken-import-${++id}`,
          category: 'broken-import',
          severity: 'high',
          message: `Cannot resolve import '${spec}'`,
          file,
          line: imp.getStartLineNumber(),
          suggestion: `Check that '${spec}' exists relative to ${path.basename(file)}`,
        })
      }
    }
  }

  return issues
}

// ─── Hardcoded URLs ───────────────────────────────────────────────────────────

// Files to skip entirely
const SKIP_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**',
  '**/.env*', '**/*.md', '**/CHANGELOG*',
  // Data / catalog / fixture files — URLs here are intentional reference data
  '**/*catalog*', '**/*catalogue*', '**/*fixture*', '**/*mock*',
  '**/*data.*', '**/*constants.*', '**/*registry.*',
]

// Line patterns indicating the URL is a static data value, not a runtime call
// e.g. `docs: 'https://...'`, `homepage: 'https://...'`, `href: 'https://...'`
const DATA_PROPERTY_RE = /\b(docs|documentation|homepage|website|repository|repo|href|link|url|source|reference|guide|tutorial)\s*:/i

// Domains that are clearly intentional (auth providers, CDNs, well-known APIs)
const ALLOWED_DOMAINS = new Set([
  'fonts.googleapis.com', 'fonts.gstatic.com',
  'accounts.google.com', 'oauth2.googleapis.com',
  'api.stripe.com', 'checkout.stripe.com',
  'github.com', 'api.github.com',
  'cdn.jsdelivr.net', 'unpkg.com',
  'schema.org', 'w3.org',
  'd3js.org',
  // Common open-source documentation domains (likely reference data, not runtime)
  'nextjs.org', 'react.dev', 'reactjs.org', 'vuejs.org',
  'nodejs.org', 'expressjs.com', 'fastify.io',
  'www.postgresql.org', 'redis.io', 'mongodb.com',
  'developers.cloudflare.com', 'kubernetes.io',
  'docs.docker.com', 'docs.python.org',
  'www.typescriptlang.org', 'eslint.org', 'prettier.io',
  'tailwindcss.com', 'radix-ui.com', 'shadcn.com',
  'stripe.com', 'twilio.com', 'sendgrid.com',
])

const ABSOLUTE_URL_RE = /(['"`])https?:\/\/([a-zA-Z0-9.-]+)(\/[^\s'"`]*)?(['"`])/g

export async function detectHardcodedUrls(
  rootDir: string,
  project: Project,
): Promise<Issue[]> {
  const issues: Issue[] = []
  let id = 0

  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: rootDir,
    absolute: true,
    ignore: [...SKIP_GLOBS, '**/node_modules/**', '**/dist/**', '**/.next/**', '**/out/**', '**/*.d.ts'],
  })

  for (const file of files) {
    const sf = project.addSourceFileAtPath(file)
    const fullText = sf.getFullText()
    let match: RegExpExecArray | null
    ABSOLUTE_URL_RE.lastIndex = 0

    while ((match = ABSOLUTE_URL_RE.exec(fullText)) !== null) {
      const domain = match[2]
      // Strip www. prefix for domain matching, check exact + suffix
      const normDomain = domain.replace(/^www\./, '')
      if (ALLOWED_DOMAINS.has(domain) || ALLOWED_DOMAINS.has(normDomain)) continue
      // Also skip if the URL is an XML/SVG namespace (contains a year-like path segment)
      const urlText2 = match[0].slice(1, -1)
      if (/\/\d{4}\//.test(urlText2)) continue

      // Skip if it's inside a comment
      const pos = match.index
      const lineStart = fullText.lastIndexOf('\n', pos) + 1
      const lineText = fullText.slice(lineStart, fullText.indexOf('\n', pos))
      if (/^\s*\/\//.test(lineText) || /^\s*\*/.test(lineText)) continue

      // Skip if this looks like it's assigned to an env-var-derived constant
      if (/process\.env\.|NEXT_PUBLIC_|\.env/.test(lineText)) continue

      // Skip if this is a data/reference property value (docs:, href:, homepage:, etc.)
      if (DATA_PROPERTY_RE.test(lineText)) continue

      const line = sf.getLineAndColumnAtPos(pos).line
      const urlText = match[0].slice(1, -1)  // strip quotes

      issues.push({
        id: `hardcoded-url-${++id}`,
        category: 'hardcoded-url',
        severity: 'medium',
        message: `Hardcoded URL '${urlText.slice(0, 80)}' — move to env var or config`,
        file,
        line,
        suggestion: `Extract to an environment variable (e.g. NEXT_PUBLIC_${domain.toUpperCase().replace(/[.-]/g, '_')}_URL)`,
      })
    }
  }

  return issues
}

// ─── Circular dependency detection ───────────────────────────────────────────

interface ImportGraph {
  /** Map from absolute file path → set of absolute file paths it imports */
  edges: Map<string, Set<string>>
}

function buildImportGraph(project: Project, rootDir: string): ImportGraph {
  const edges = new Map<string, Set<string>>()

  for (const sf of project.getSourceFiles()) {
    const fromFile = sf.getFilePath()
    if (fromFile.includes('node_modules') || fromFile.includes('/dist/')) continue

    const deps = new Set<string>()
    for (const imp of sf.getImportDeclarations()) {
      const resolved = imp.getModuleSpecifierSourceFile()
      if (resolved) {
        const toFile = resolved.getFilePath()
        if (!toFile.includes('node_modules') && !toFile.includes('/dist/')) {
          deps.add(toFile)
        }
      }
    }
    edges.set(fromFile, deps)
  }

  return { edges }
}

/**
 * Johnson's algorithm simplified: iterative DFS that detects back-edges.
 * Returns each cycle as an ordered list of file paths forming the loop.
 * Caps at 20 cycles to avoid overwhelming output.
 */
function findCycles(graph: ImportGraph): string[][] {
  const cycles: string[][] = []
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const stack: string[] = []

  function dfs(node: string): void {
    if (cycles.length >= 20) return
    visited.add(node)
    onStack.add(node)
    stack.push(node)

    for (const neighbor of graph.edges.get(node) ?? []) {
      if (cycles.length >= 20) break
      if (onStack.has(neighbor)) {
        // Back-edge found → cycle from neighbor back to neighbor via stack
        const cycleStart = stack.indexOf(neighbor)
        cycles.push([...stack.slice(cycleStart), neighbor])
      } else if (!visited.has(neighbor)) {
        dfs(neighbor)
      }
    }

    stack.pop()
    onStack.delete(node)
  }

  for (const node of graph.edges.keys()) {
    if (!visited.has(node) && cycles.length < 20) {
      dfs(node)
    }
  }

  return cycles
}

export async function detectCircularDependencies(
  rootDir: string,
  project: Project,
): Promise<{ issues: Issue[]; graph: DependencyGraph }> {
  const importGraph = buildImportGraph(project, rootDir)
  const cycles = findCycles(importGraph)

  const issues: Issue[] = cycles.map((cycle, i) => {
    const shortPaths = cycle.map(f => path.relative(rootDir, f))
    return {
      id: `circular-dep-${i + 1}`,
      category: 'circular-dependency' as const,
      severity: 'medium' as const,
      message: `Circular dependency: ${shortPaths.join(' → ')}`,
      file: cycle[0],
      line: 1,
      suggestion: 'Extract shared types or interfaces into a separate module to break the cycle',
    }
  })

  // Build full DependencyGraph for the HTML report
  const nodes = [...importGraph.edges.keys()].map(f => path.relative(rootDir, f))
  const edges: DependencyEdge[] = []
  for (const [from, tos] of importGraph.edges) {
    for (const to of tos) {
      edges.push({
        from: path.relative(rootDir, from),
        to: path.relative(rootDir, to),
        type: 'import',
      })
    }
  }

  const graph: DependencyGraph = {
    nodes,
    edges,
    cycles: cycles.map(c => c.map(f => path.relative(rootDir, f))),
  }

  return { issues, graph }
}
