import { Node, CallExpression, SyntaxKind, type SourceFile } from 'ts-morph'

/** Returns the callee name of a call expression (e.g. `fetch` from `fetch(...)`) */
export function callName(call: CallExpression): string {
  const expr = call.getExpression()
  if (Node.isIdentifier(expr)) return expr.getText()
  if (Node.isPropertyAccessExpression(expr)) return expr.getName()
  return expr.getText()
}

/** Returns the first string-literal argument of a call, or undefined */
export function firstStringArg(call: CallExpression): string | undefined {
  const first = call.getArguments()[0]
  if (!first) return undefined
  if (Node.isStringLiteral(first)) return first.getLiteralValue()
  if (Node.isNoSubstitutionTemplateLiteral(first)) return first.getLiteralValue()
  // Template literal — return the raw text for pattern matching
  if (Node.isTemplateExpression(first)) return first.getText()
  return undefined
}

/** Returns true if the function body contains only a TODO comment or throw/return stub */
export function isStubBody(node: Node): boolean {
  const text = node.getText()
  return (
    /\/\/\s*(TODO|FIXME|HACK|XXX|stub|not implemented)/i.test(text) ||
    /throw new Error\(['"]not implemented/i.test(text) ||
    /throw new Error\(['"]todo/i.test(text)
  )
}

/** Heuristic: file/function name looks like a React component */
export function looksLikeComponent(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name)
}

/** Heuristic: name looks like a React hook */
export function looksLikeHook(name: string): boolean {
  return /^use[A-Z]/.test(name)
}

/** Returns all TODO/FIXME comments in a source file */
export function findTodoComments(sf: SourceFile): Array<{ text: string; line: number }> {
  const results: Array<{ text: string; line: number }> = []
  const fullText = sf.getFullText()
  const todoRe = /\/\/\s*(TODO|FIXME|HACK|XXX)[^\n]*/gi
  let match: RegExpExecArray | null
  while ((match = todoRe.exec(fullText)) !== null) {
    const line = sf.getLineAndColumnAtPos(match.index).line
    results.push({ text: match[0].trim(), line })
  }
  return results
}

/**
 * Normalises a URL to just its pathname for route matching.
 * Handles absolute URLs (https://api.example.com/api/users → /api/users),
 * relative paths (/api/users), and template strings (left as-is).
 */
export function normalizeUrlToPath(url: string): string {
  // Template literal — can't statically resolve
  if (url.includes('${')) return url
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return new URL(url).pathname
    }
  } catch {
    // malformed absolute URL — fall through
  }
  return url
}

/** Returns true if a URL string plausibly matches a route pattern */
export function urlMatchesRoute(url: string, routePath: string): boolean {
  const normalizedUrl = normalizeUrlToPath(url)
  // Replace :param segments with a wildcard for comparison
  const routeRegex = routePath
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape regex chars
    .replace(/\\:\w+/g, '[^/]+')               // :param → [^/]+
    .replace(/\\\*/g, '.*')                    // * → .*
  try {
    // Remove query strings and trailing slashes from the URL for matching
    const cleanUrl = normalizedUrl.replace(/[?#].*$/, '').replace(/\/$/, '') || '/'
    return new RegExp(`^${routeRegex}$`).test(cleanUrl)
  } catch {
    return false
  }
}

/** Extracts HTTP method + URL from a fetch/axios/authFetch call */
export function extractHttpCall(call: CallExpression): { method: string; url: string } | undefined {
  const name = callName(call)
  const args = call.getArguments()

  // fetch(url, { method: 'POST' }) or fetch(url)
  if (name === 'fetch' || name === 'authFetch' || name === 'apiFetch') {
    const url = firstStringArg(call) ?? args[0]?.getText() ?? 'unknown'
    let method = 'GET'
    if (args[1] && Node.isObjectLiteralExpression(args[1])) {
      const methodProp = args[1].getProperty('method')
      if (methodProp && Node.isPropertyAssignment(methodProp)) {
        const init = methodProp.getInitializer()
        if (init && Node.isStringLiteral(init)) method = init.getLiteralValue().toUpperCase()
      }
    }
    return { method, url }
  }

  // axios.get/post/put/delete/patch(url)
  if (/^axios\.(get|post|put|delete|patch|head)$/i.test(name)) {
    const method = name.split('.')[1].toUpperCase()
    const url = firstStringArg(call) ?? 'unknown'
    return { method, url }
  }

  // api.get/post/put/delete/patch(url)  — common pattern in Next.js API clients
  if (/^api\.(get|post|put|delete|patch)$/i.test(name) ||
      /^client\.(get|post|put|delete|patch)$/i.test(name)) {
    const method = name.split('.')[1].toUpperCase()
    const url = firstStringArg(call) ?? 'unknown'
    return { method, url }
  }

  return undefined
}
