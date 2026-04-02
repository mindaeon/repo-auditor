// ─── Core types for the Repo Auditor + Vertical Slice Tracer ──────────────────

export interface Route {
  method: string       // GET, POST, PUT, DELETE, PATCH, *
  path: string         // e.g. /api/users/:id
  file: string         // absolute path to source file
  line: number
  handler?: string     // function name if extractable
  framework: 'next-app' | 'next-pages' | 'hono' | 'express' | 'fastify' | 'unknown'
}

export interface DbQuery {
  file: string
  line: number
  type: 'select' | 'insert' | 'update' | 'delete' | 'ddl' | 'raw' | 'orm'
  table?: string
  orm?: 'prisma' | 'drizzle' | 'd1' | 'raw-sql' | 'typeorm' | 'sequelize'
  snippet: string      // raw query or ORM call text (truncated)
}

export interface ComponentNode {
  name: string
  file: string
  line: number
  isPage: boolean
  apiCalls: ApiCallNode[]
  hooksUsed: string[]
  importedComponents: string[]
}

export interface HookNode {
  name: string
  file: string
  line: number
  apiCalls: ApiCallNode[]
  deps: string[]       // other hooks this hook depends on
}

export interface ApiCallNode {
  file: string
  line: number
  method: string       // GET, POST, …
  url: string          // literal or template string
  matchedRoutes: Route[]
}

export interface BackendEndpointNode {
  route: Route
  dbQueries: DbQuery[]
  calledServices: string[]
}

export interface VerticalSlice {
  id: string
  label: string        // e.g. "UserProfile → useUser → GET /api/users/:id → D1 users table"
  component?: ComponentNode
  hook?: HookNode
  apiCall?: ApiCallNode
  backendEndpoint?: BackendEndpointNode
  dbQueries: DbQuery[]
  depth: number        // how many layers were traced (1-5)
  issues: Issue[]
}

// ─── Issues & Fix tasks ────────────────────────────────────────────────────────

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info'
export type IssueCategory =
  | 'missing-backend'        // frontend calls endpoint that has no backend handler
  | 'missing-frontend'       // backend route has no known caller
  | 'stub-implementation'    // TODO/placeholder in source
  | 'no-db-query'            // endpoint has no DB access (possibly intentional)
  | 'untyped-api-call'       // fetch/axios without TypeScript types
  | 'broken-import'          // import resolves to non-existent file
  | 'circular-dependency'    // module graph cycle detected
  | 'large-component'        // component > 500 lines (complexity smell)
  | 'missing-error-handling' // async call with no try/catch
  | 'hardcoded-url'          // literal URL in source code

export interface Issue {
  id: string
  category: IssueCategory
  severity: IssueSeverity
  message: string
  file: string
  line: number
  suggestion?: string
}

export interface FixTask {
  id: string
  title: string
  description: string
  severity: IssueSeverity
  affectedFiles: string[]
  issues: Issue[]
  estimatedLoc: number    // rough lines-of-code to fix
}

// ─── Dependency graph ─────────────────────────────────────────────────────────

export interface DependencyEdge {
  from: string   // file path
  to: string     // file path
  type: 'import' | 'api-call' | 'db-query'
}

export interface DependencyGraph {
  nodes: string[]           // file paths
  edges: DependencyEdge[]
  cycles: string[][]        // each cycle is a list of file paths forming the loop
}

// ─── Audit report ─────────────────────────────────────────────────────────────

export interface AuditReport {
  generatedAt: string       // ISO date
  rootDir: string
  summary: {
    totalFiles: number
    totalRoutes: number
    totalComponents: number
    totalHooks: number
    totalDbQueries: number
    totalIssues: number
    issuesByCategory: Record<IssueCategory, number>
    issuesBySeverity: Record<IssueSeverity, number>
    coverageScore: number   // 0-100: % of routes traced to ≥1 component
  }
  routes: Route[]
  components: ComponentNode[]
  hooks: HookNode[]
  dbQueries: DbQuery[]
  verticalSlices: VerticalSlice[]
  dependencyGraph: DependencyGraph
  issues: Issue[]
  fixPlan: FixTask[]
}
