import path from 'node:path'
import { glob } from 'glob'
import { Project, Node, SyntaxKind } from 'ts-morph'
import type { ComponentNode, HookNode, ApiCallNode, Route, DbQuery, VerticalSlice, Issue, BackendEndpointNode } from '../types.js'
import { callName, firstStringArg, looksLikeComponent, looksLikeHook, extractHttpCall, urlMatchesRoute, normalizeUrlToPath, isStubBody } from './ast-utils.js'

// ─── Component scanner ────────────────────────────────────────────────────────

export async function scanComponents(rootDir: string, project: Project): Promise<ComponentNode[]> {
  const components: ComponentNode[] = []

  const files = await glob('**/*.{tsx,jsx}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.test.*', '**/*.spec.*'],
  })

  for (const file of files) {
    const sf = project.addSourceFileAtPath(file)
    const isPage = /\/(page|layout|error|loading|not-found)\.(tsx|jsx)$/.test(file) ||
                   /\/pages\//.test(file)

    // Collect API calls in this file
    const apiCalls = extractApiCallsFromFile(sf, file)
    const hooksUsed: string[] = []
    const importedComponents: string[] = []

    // Find hook usages
    sf.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const name = callName(node)
        if (looksLikeHook(name)) hooksUsed.push(name)
      }
    })

    // Find imported component names
    for (const imp of sf.getImportDeclarations()) {
      for (const named of imp.getNamedImports()) {
        const name = named.getName()
        if (looksLikeComponent(name)) importedComponents.push(name)
      }
      const def = imp.getDefaultImport()
      if (def && looksLikeComponent(def.getText())) importedComponents.push(def.getText())
    }

    // Find exported component declarations
    const exported = sf.getExportedDeclarations()
    let foundComponent = false
    for (const [name, decls] of exported) {
      if (looksLikeComponent(name) && decls.length > 0) {
        components.push({
          name,
          file,
          line: decls[0].getStartLineNumber(),
          isPage,
          apiCalls,
          hooksUsed: [...new Set(hooksUsed)],
          importedComponents: [...new Set(importedComponents)],
        })
        foundComponent = true
      }
    }

    // Fallback: treat the file itself as a component if it's a page
    if (!foundComponent && isPage) {
      const baseName = path.basename(file, path.extname(file))
      components.push({
        name: baseName.charAt(0).toUpperCase() + baseName.slice(1),
        file,
        line: 1,
        isPage,
        apiCalls,
        hooksUsed: [...new Set(hooksUsed)],
        importedComponents: [...new Set(importedComponents)],
      })
    }
  }

  return components
}

// ─── Hook scanner ─────────────────────────────────────────────────────────────

export async function scanHooks(rootDir: string, project: Project): Promise<HookNode[]> {
  const hooks: HookNode[] = []

  const files = await glob('**/*.{ts,tsx,js,jsx}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.test.*', '**/*.spec.*'],
  })

  for (const file of files) {
    const sf = project.addSourceFileAtPath(file)

    // Find all function declarations/arrow functions that look like hooks
    const declarations = [
      ...sf.getFunctions(),
      ...sf.getVariableDeclarations(),
    ]

    for (const decl of declarations) {
      const name = 'getName' in decl ? (decl as any).getName() : undefined
      if (!name || !looksLikeHook(name)) continue

      const apiCalls = extractApiCallsFromFile(sf, file)
      const deps: string[] = []

      // Find other hooks this hook depends on
      const body = 'getBody' in decl ? (decl as any).getBody() : decl
      if (body) {
        body.forEachDescendant?.((node: Node) => {
          if (Node.isCallExpression(node)) {
            const callee = callName(node)
            if (looksLikeHook(callee) && callee !== name) deps.push(callee)
          }
        })
      }

      hooks.push({
        name,
        file,
        line: decl.getStartLineNumber(),
        apiCalls,
        deps: [...new Set(deps)],
      })
    }
  }

  return hooks
}

// ─── API call extractor ───────────────────────────────────────────────────────

function extractApiCallsFromFile(sf: ReturnType<Project['addSourceFileAtPath']>, file: string): ApiCallNode[] {
  const calls: ApiCallNode[] = []
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const http = extractHttpCall(node)
    if (!http) return
    calls.push({
      file,
      line: node.getStartLineNumber(),
      method: http.method,
      url: http.url,
      matchedRoutes: [], // populated later by linkSlices
    })
  })
  return calls
}

// ─── Vertical slice builder ───────────────────────────────────────────────────

export function buildVerticalSlices(
  components: ComponentNode[],
  hooks: HookNode[],
  routes: Route[],
  dbQueries: DbQuery[],
): VerticalSlice[] {
  // Index routes for fast matching
  const hookMap = new Map(hooks.map(h => [h.name, h]))

  const slices: VerticalSlice[] = []
  let id = 1

  // For each component with API calls, trace down
  for (const comp of components) {
    // Direct API calls from component
    for (const apiCall of comp.apiCalls) {
      const matched = matchRoutes(apiCall.url, apiCall.method, routes)
      apiCall.matchedRoutes = matched

      for (const route of matched) {
        const backendQueries = dbQueries.filter(q => q.file === route.file)
        const issues = detectSliceIssues(comp, apiCall, route, backendQueries)
        slices.push({
          id: `slice-${id++}`,
          label: `${comp.name} → ${apiCall.method} ${apiCall.url} → ${route.file.split('/').slice(-2).join('/')}`,
          component: comp,
          apiCall,
          backendEndpoint: { route, dbQueries: backendQueries, calledServices: [] },
          dbQueries: backendQueries,
          depth: backendQueries.length > 0 ? 4 : 3,
          issues,
        })
      }

      // Unmatched API call — issue
      if (matched.length === 0 && !apiCall.url.startsWith('http') && !apiCall.url.includes('${')) {
        slices.push({
          id: `slice-${id++}`,
          label: `${comp.name} → ${apiCall.method} ${apiCall.url} → [no backend match]`,
          component: comp,
          apiCall,
          dbQueries: [],
          depth: 2,
          issues: [{
            id: `issue-${id++}`,
            category: 'missing-backend',
            severity: 'high',
            message: `No backend route found for ${apiCall.method} ${apiCall.url} (called from ${comp.name})`,
            file: apiCall.file,
            line: apiCall.line,
            suggestion: `Create a backend handler for ${apiCall.method} ${apiCall.url}`,
          }],
        })
      }
    }

    // API calls from hooks used by this component
    for (const hookName of comp.hooksUsed) {
      const hook = hookMap.get(hookName)
      if (!hook) continue
      for (const apiCall of hook.apiCalls) {
        const matched = matchRoutes(apiCall.url, apiCall.method, routes)
        apiCall.matchedRoutes = matched
        for (const route of matched) {
          const backendQueries = dbQueries.filter(q => q.file === route.file)
          const issues = detectSliceIssues(comp, apiCall, route, backendQueries)
          slices.push({
            id: `slice-${id++}`,
            label: `${comp.name} → ${hookName} → ${apiCall.method} ${apiCall.url} → ${route.file.split('/').slice(-2).join('/')}`,
            component: comp,
            hook,
            apiCall,
            backendEndpoint: { route, dbQueries: backendQueries, calledServices: [] },
            dbQueries: backendQueries,
            depth: backendQueries.length > 0 ? 5 : 4,
            issues,
          })
        }
      }
    }
  }

  // Backend routes with no callers
  const calledRouteFiles = new Set(slices.flatMap(s => s.backendEndpoint ? [s.backendEndpoint.route.file] : []))
  for (const route of routes) {
    if (!calledRouteFiles.has(route.file) && !route.path.startsWith('/_') && !route.path.includes('webhook')) {
      const backendQueries = dbQueries.filter(q => q.file === route.file)
      slices.push({
        id: `slice-${id++}`,
        label: `[no caller] → ${route.method} ${route.path}`,
        backendEndpoint: { route, dbQueries: backendQueries, calledServices: [] },
        dbQueries: backendQueries,
        depth: 1,
        issues: [{
          id: `issue-${id++}`,
          category: 'missing-frontend',
          severity: 'low',
          message: `Route ${route.method} ${route.path} has no known frontend caller`,
          file: route.file,
          line: route.line,
          suggestion: 'Add a frontend caller or remove if unused',
        }],
      })
    }
  }

  return slices
}

function matchRoutes(url: string, method: string, routes: Route[]): Route[] {
  const normalizedUrl = normalizeUrlToPath(url)
  return routes.filter(r => {
    const methodMatch = r.method === '*' || r.method === method || method === '*'
    if (!methodMatch) return false
    // Exact match (after normalizing the incoming URL)
    if (r.path === normalizedUrl) return true
    // Pattern match
    return urlMatchesRoute(normalizedUrl, r.path)
  })
}

function detectSliceIssues(
  comp: ComponentNode,
  apiCall: ApiCallNode,
  route: Route,
  backendQueries: DbQuery[],
): Issue[] {
  const issues: Issue[] = []
  let issueId = 1

  if (backendQueries.length === 0 && !route.path.includes('auth') && !route.path.includes('health')) {
    issues.push({
      id: `slice-issue-${issueId++}`,
      category: 'no-db-query',
      severity: 'low',
      message: `Route ${route.method} ${route.path} has no DB queries — may be missing persistence`,
      file: route.file,
      line: route.line,
      suggestion: 'Verify that this route intentionally has no DB access',
    })
  }

  return issues
}
