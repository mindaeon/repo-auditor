import path from 'node:path'
import { glob } from 'glob'
import { Project, Node, SyntaxKind } from 'ts-morph'
import type { Route, DbQuery } from '../types.js'
import { callName, firstStringArg } from './ast-utils.js'

// ─── Next.js App Router route detection ───────────────────────────────────────

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']

function nextAppRouterSegmentToPath(relPath: string): string {
  // e.g. app/api/users/[id]/route.ts → /api/users/:id
  return relPath
    .replace(/\\/g, '/')
    .replace(/^.*?app\//, '')
    .replace(/\/route\.(ts|tsx|js|jsx)$/, '')
    .replace(/\[\.\.\.(\w+)\]/g, '*')     // [...slug] → *
    .replace(/\[(\w+)\]/g, ':$1')          // [id] → :id
    .replace(/\([\w-]+\)\//g, '')          // (group)/ → removed
    || '/'
}

function nextPagesRouterSegmentToPath(relPath: string): string {
  // e.g. pages/api/users/[id].ts → /api/users/:id
  return relPath
    .replace(/\\/g, '/')
    .replace(/^.*?pages\//, '/')
    .replace(/\.(ts|tsx|js|jsx)$/, '')
    .replace(/\/index$/, '')
    .replace(/\[\.\.\.(\w+)\]/g, '*')
    .replace(/\[(\w+)\]/g, ':$1')
    || '/'
}

export async function scanNextRoutes(rootDir: string, project: Project): Promise<Route[]> {
  const routes: Route[] = []

  // App Router: app/**/route.{ts,tsx,js,jsx}
  const appRouteFiles = await glob('**/app/**/route.{ts,tsx,js,jsx}', {
    cwd: rootDir, absolute: true, ignore: ['**/node_modules/**', '**/.next/**'],
  })
  for (const file of appRouteFiles) {
    const rel = path.relative(rootDir, file)
    const routePath = '/' + nextAppRouterSegmentToPath(rel)
    const sf = project.addSourceFileAtPath(file)

    for (const method of HTTP_METHODS) {
      const exported = sf.getExportedDeclarations().get(method)
      if (exported?.length) {
        routes.push({
          method,
          path: routePath,
          file,
          line: exported[0].getStartLineNumber(),
          framework: 'next-app',
        })
      }
    }
  }

  // Pages Router: pages/api/**/*.{ts,tsx,js,jsx}
  const pagesApiFiles = await glob('**/pages/api/**/*.{ts,js}', {
    cwd: rootDir, absolute: true, ignore: ['**/node_modules/**', '**/.next/**'],
  })
  for (const file of pagesApiFiles) {
    const rel = path.relative(rootDir, file)
    const routePath = nextPagesRouterSegmentToPath(rel)
    routes.push({
      method: '*',
      path: routePath,
      file,
      line: 1,
      framework: 'next-pages',
    })
  }

  return routes
}

// ─── Hono / Express / Fastify backend route detection ────────────────────────

const ROUTE_METHOD_RE = /\.(get|post|put|delete|patch|head|all|route|on)\s*\(/i

export async function scanBackendRoutes(rootDir: string, project: Project): Promise<Route[]> {
  const routes: Route[] = []

  const files = await glob('**/*.{ts,js}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  })

  for (const file of files) {
    // Quick text pre-filter to avoid full parse on unrelated files
    const sf = project.addSourceFileAtPath(file)
    const text = sf.getFullText()
    if (!ROUTE_METHOD_RE.test(text)) continue

    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return
      const expr = node.getExpression()

      // Use full expression text (e.g. "router.get") so the dot is present
      const exprText = expr.getText()
      const methodMatch = exprText.match(/\.(get|post|put|delete|patch|head|all)$/i)
      if (!methodMatch) return

      const pathArg = firstStringArg(node)
      if (!pathArg) return

      // Detect framework by looking at the callee object name
      let framework: Route['framework'] = 'unknown'
      if (Node.isPropertyAccessExpression(expr)) {
        const objName = expr.getExpression().getText()
        if (/\bapp\b/.test(objName)) framework = 'express'
        if (/\broker\b|\brouter\b/.test(objName)) {
          framework = 'express'
          // Hono also uses router — check imports to disambiguate
          const imports = sf.getImportDeclarations()
          const hasHono = imports.some(i => i.getModuleSpecifierValue() === 'hono')
          if (hasHono) framework = 'unknown' // tag as unknown, path still captured
        }
        if (/\bfastify\b/.test(objName)) framework = 'fastify'
      }

      routes.push({
        method: (methodMatch[1] === 'all' ? '*' : methodMatch[1]).toUpperCase(),
        path: pathArg,
        file,
        line: node.getStartLineNumber(),
        framework,
      })
    })
  }

  return routes
}

// ─── DB query extraction ──────────────────────────────────────────────────────

const TABLE_FROM_SQL_RE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+["'`]?(\w+)["'`]?/i

export function extractTableFromSql(sql: string): string | undefined {
  const m = TABLE_FROM_SQL_RE.exec(sql)
  return m?.[1]
}

export async function scanDbQueries(rootDir: string, project: Project): Promise<DbQuery[]> {
  const queries: DbQuery[] = []

  const files = await glob('**/*.{ts,js}', {
    cwd: rootDir,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*', '**/*.spec.*', '**/__tests__/**'],
  })

  for (const file of files) {
    const sf = project.addSourceFileAtPath(file)
    const text = sf.getFullText()

    // Pre-filter: skip files unlikely to have DB queries
    if (!/prepare|query|execute|findMany|findFirst|select|insert|update|delete|from\(/i.test(text)) continue

    sf.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return
      const name = callName(node)
      const line = node.getStartLineNumber()
      const snippet = node.getText().slice(0, 120)

      // Cloudflare D1: db.prepare('SQL').bind(...).first/all/run
      if (name === 'prepare') {
        const sql = firstStringArg(node) ?? ''
        queries.push({
          file, line, snippet,
          type: detectSqlType(sql),
          table: extractTableFromSql(sql),
          orm: 'd1',
        })
        return
      }

      // Prisma: prisma.user.findMany(), prisma.post.create(), etc.
      if (/^prisma\.\w+\.(findMany|findFirst|findUnique|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate)$/.test(name)) {
        const parts = name.split('.')
        queries.push({
          file, line, snippet,
          type: detectOrmType(parts[2]),
          table: parts[1],
          orm: 'prisma',
        })
        return
      }

      // Drizzle: db.select().from(table), db.insert(table).values(...)
      if (/^db\.(select|insert|update|delete)$/.test(name)) {
        queries.push({
          file, line, snippet,
          type: name.split('.')[1] as DbQuery['type'],
          orm: 'drizzle',
        })
        return
      }

      // Raw SQL string patterns
      if ((name === 'query' || name === 'execute' || name === 'run') && firstStringArg(node)) {
        const sql = firstStringArg(node) ?? ''
        queries.push({
          file, line, snippet,
          type: detectSqlType(sql),
          table: extractTableFromSql(sql),
          orm: 'raw-sql',
        })
      }
    })
  }

  return queries
}

function detectSqlType(sql: string): DbQuery['type'] {
  const upper = sql.trim().toUpperCase()
  if (upper.startsWith('SELECT')) return 'select'
  if (upper.startsWith('INSERT')) return 'insert'
  if (upper.startsWith('UPDATE')) return 'update'
  if (upper.startsWith('DELETE')) return 'delete'
  if (/^(CREATE|DROP|ALTER|TRUNCATE)/.test(upper)) return 'ddl'
  return 'raw'
}

function detectOrmType(method: string): DbQuery['type'] {
  if (/find|select|count|aggregate/.test(method)) return 'select'
  if (/create|insert/.test(method)) return 'insert'
  if (/update|upsert/.test(method)) return 'update'
  if (/delete/.test(method)) return 'delete'
  return 'orm'
}
