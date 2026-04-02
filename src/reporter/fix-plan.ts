import type { Issue, FixTask, IssueSeverity } from '../types.js'

const SEVERITY_ORDER: Record<IssueSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
}

export function buildFixPlan(issues: Issue[]): FixTask[] {
  // Group issues by category + severity
  type Group = { issues: Issue[]; files: Set<string> }
  const groups = new Map<string, Group>()

  for (const issue of issues) {
    const key = `${issue.category}:${issue.severity}`
    if (!groups.has(key)) groups.set(key, { issues: [], files: new Set() })
    const g = groups.get(key)!
    g.issues.push(issue)
    g.files.add(issue.file)
  }

  const tasks: FixTask[] = []
  let id = 1

  for (const [key, group] of groups) {
    const [category, severity] = key.split(':') as [Issue['category'], IssueSeverity]
    const count = group.issues.length

    tasks.push({
      id: `fix-${id++}`,
      title: fixTitle(category, count),
      description: fixDescription(category, group.issues),
      severity,
      affectedFiles: [...group.files],
      issues: group.issues,
      estimatedLoc: estimateLoc(category, count),
    })
  }

  // Sort by severity then count
  return tasks.sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (sev !== 0) return sev
    return b.issues.length - a.issues.length
  })
}

function fixTitle(category: Issue['category'], count: number): string {
  const map: Record<Issue['category'], string> = {
    'missing-backend': `Add ${count} missing backend endpoint${count > 1 ? 's' : ''}`,
    'missing-frontend': `Review ${count} backend route${count > 1 ? 's' : ''} with no frontend caller`,
    'stub-implementation': `Implement ${count} stub${count > 1 ? 's' : ''} (TODO/FIXME)`,
    'no-db-query': `Verify ${count} endpoint${count > 1 ? 's' : ''} missing DB queries`,
    'untyped-api-call': `Add types to ${count} API call${count > 1 ? 's' : ''}`,
    'broken-import': `Fix ${count} broken import${count > 1 ? 's' : ''}`,
    'circular-dependency': `Break ${count} circular dependency cycle${count > 1 ? 's' : ''}`,
    'large-component': `Refactor ${count} oversized component${count > 1 ? 's' : ''}`,
    'missing-error-handling': `Add error handling to ${count} async call${count > 1 ? 's' : ''}`,
    'hardcoded-url': `Extract ${count} hardcoded URL${count > 1 ? 's' : ''} to config`,
  }
  return map[category] ?? `Fix ${count} ${category} issue${count > 1 ? 's' : ''}`
}

function fixDescription(category: Issue['category'], issues: Issue[]): string {
  const files = [...new Set(issues.map(i => i.file.split('/').slice(-2).join('/')))]
  const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '')

  const map: Record<Issue['category'], string> = {
    'missing-backend': `The following frontend API calls have no matching backend handler: ${issues.slice(0, 3).map(i => i.message).join('; ')}`,
    'missing-frontend': `These backend routes appear to have no known callers in the frontend. They may be unused or called from outside the repo. Files: ${fileList}`,
    'stub-implementation': `Functions with TODO/FIXME/throw "not implemented" bodies need real implementations in: ${fileList}`,
    'no-db-query': `These endpoints don't query the database. Verify they're intentionally stateless. Files: ${fileList}`,
    'untyped-api-call': `API calls without TypeScript types reduce type safety. Add response types using generics or type assertions. Files: ${fileList}`,
    'broken-import': `Import statements that resolve to non-existent files will fail at runtime. Files: ${fileList}`,
    'circular-dependency': `Circular imports can cause initialization order issues and memory leaks. Break cycles by extracting shared types. Files: ${fileList}`,
    'large-component': `Components over 500 lines are hard to maintain. Split into smaller focused components. Files: ${fileList}`,
    'missing-error-handling': `Async operations without try/catch can cause unhandled promise rejections. Files: ${fileList}`,
    'hardcoded-url': `Hardcoded URLs make it hard to switch environments. Move to env vars or a config file. Files: ${fileList}`,
  }
  return map[category] ?? `${issues.length} instances across ${fileList}`
}

function estimateLoc(category: Issue['category'], count: number): number {
  const perIssue: Record<Issue['category'], number> = {
    'missing-backend': 30,
    'missing-frontend': 5,
    'stub-implementation': 20,
    'no-db-query': 10,
    'untyped-api-call': 5,
    'broken-import': 2,
    'circular-dependency': 15,
    'large-component': 50,
    'missing-error-handling': 5,
    'hardcoded-url': 3,
  }
  return (perIssue[category] ?? 10) * count
}
