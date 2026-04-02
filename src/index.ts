#!/usr/bin/env node
import { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs'
import { Project } from 'ts-morph'
import chalk from 'chalk'
import ora from 'ora'
import { scanNextRoutes, scanBackendRoutes, scanDbQueries } from './scanner/route-scanner.js'
import { scanComponents, scanHooks, buildVerticalSlices } from './scanner/vertical-slicer.js'
import { detectBrokenImports, detectHardcodedUrls, detectCircularDependencies } from './scanner/static-analyzers.js'
import { buildFixPlan } from './reporter/fix-plan.js'
import { generateHtmlReport } from './reporter/html-reporter.js'
import type { AuditReport, Issue, IssueCategory, IssueSeverity } from './types.js'

const program = new Command()

program
  .name('repo-auditor')
  .description('Repo Auditor + Vertical Slice Tracer — static analysis for TypeScript/JavaScript repos')
  .version('0.1.0')

program
  .command('audit [dir]', { isDefault: true })
  .description('Audit a repository and trace vertical slices from UI to DB')
  .option('-o, --output <file>', 'Output HTML report to file', 'audit-report.html')
  .option('--json <file>', 'Also write JSON report to file')
  .option('--no-html', 'Skip HTML report generation')
  .option('--min-severity <level>', 'Minimum severity to display (critical|high|medium|low|info)', 'medium')
  .option('--tsconfig <path>', 'Path to tsconfig.json (auto-detected if omitted)')
  .action(async (dir: string | undefined, opts: {
    output: string
    json?: string
    html: boolean
    minSeverity: string
    tsconfig?: string
  }) => {
    const rootDir = path.resolve(dir ?? '.')

    if (!fs.existsSync(rootDir)) {
      console.error(chalk.red(`Directory not found: ${rootDir}`))
      process.exit(1)
    }

    console.log(chalk.bold.cyan('\n  Repo Auditor + Vertical Slice Tracer'))
    console.log(chalk.dim(`  Analysing: ${rootDir}\n`))

    // ── Set up ts-morph project ──────────────────────────────────────────
    const spinner = ora('Setting up TypeScript project…').start()
    let tsconfigPath = opts.tsconfig
    if (!tsconfigPath) {
      for (const candidate of ['tsconfig.json', 'packages/client/tsconfig.json', 'packages/worker/tsconfig.json']) {
        const p = path.join(rootDir, candidate)
        if (fs.existsSync(p)) { tsconfigPath = p; break }
      }
    }

    const project = new Project({
      tsConfigFilePath: tsconfigPath,
      skipAddingFilesFromTsConfig: !tsconfigPath,
      compilerOptions: tsconfigPath ? undefined : {
        allowJs: true,
        checkJs: false,
        target: 99, // ESNext
      },
    })

    spinner.succeed('TypeScript project ready')

    // ── Scan routes ──────────────────────────────────────────────────────
    spinner.start('Scanning routes…')
    const [nextRoutes, backendRoutes] = await Promise.all([
      scanNextRoutes(rootDir, project).catch(() => []),
      scanBackendRoutes(rootDir, project).catch(() => []),
    ])
    const routes = [...nextRoutes, ...backendRoutes]
    spinner.succeed(`Found ${chalk.bold(routes.length)} routes (${nextRoutes.length} Next.js, ${backendRoutes.length} backend)`)

    // ── Scan DB queries ──────────────────────────────────────────────────
    spinner.start('Scanning database queries…')
    const dbQueries = await scanDbQueries(rootDir, project).catch(() => [])
    spinner.succeed(`Found ${chalk.bold(dbQueries.length)} DB queries`)

    // ── Scan components + hooks ──────────────────────────────────────────
    spinner.start('Scanning components and hooks…')
    const [components, hooks] = await Promise.all([
      scanComponents(rootDir, project).catch(() => []),
      scanHooks(rootDir, project).catch(() => []),
    ])
    spinner.succeed(`Found ${chalk.bold(components.length)} components, ${chalk.bold(hooks.length)} hooks`)

    // ── Build vertical slices ────────────────────────────────────────────
    spinner.start('Tracing vertical slices…')
    const verticalSlices = buildVerticalSlices(components, hooks, routes, dbQueries)
    spinner.succeed(`Traced ${chalk.bold(verticalSlices.length)} vertical slices`)

    // ── Collect all issues ───────────────────────────────────────────────
    const allIssues: Issue[] = verticalSlices.flatMap(s => s.issues)

    // Large component issues
    for (const comp of components) {
      const sf = project.getSourceFile(comp.file)
      if (sf && sf.getEndLineNumber() > 500) {
        allIssues.push({
          id: `large-${comp.file}`,
          category: 'large-component',
          severity: 'medium',
          message: `${comp.name} is ${sf.getEndLineNumber()} lines — consider splitting`,
          file: comp.file,
          line: comp.line,
          suggestion: 'Extract sections into smaller focused components',
        })
      }
    }

    // ── Static analyzers (broken imports, hardcoded URLs, circular deps) ─
    spinner.start('Running static analyzers…')
    const [brokenImports, hardcodedUrls, { issues: circularIssues, graph: dependencyGraph }] = await Promise.all([
      detectBrokenImports(rootDir, project).catch(() => [] as Issue[]),
      detectHardcodedUrls(rootDir, project).catch(() => [] as Issue[]),
      detectCircularDependencies(rootDir, project).catch(() => ({ issues: [] as Issue[], graph: { nodes: [], edges: [], cycles: [] } })),
    ])
    allIssues.push(...brokenImports, ...hardcodedUrls, ...circularIssues)
    spinner.succeed(
      `Static analysis: ${chalk.bold(brokenImports.length)} broken imports, ` +
      `${chalk.bold(hardcodedUrls.length)} hardcoded URLs, ` +
      `${chalk.bold(circularIssues.length)} circular deps`,
    )

    // ── Build fix plan ───────────────────────────────────────────────────
    const fixPlan = buildFixPlan(allIssues)

    // ── Coverage score ───────────────────────────────────────────────────
    const tracedRouteFiles = new Set(
      verticalSlices
        .filter(s => s.backendEndpoint && s.component)
        .map(s => s.backendEndpoint!.route.file)
    )
    const coverageScore = routes.length > 0
      ? Math.round((tracedRouteFiles.size / routes.length) * 100)
      : 0

    const issuesBySeverity = allIssues.reduce((acc, i) => {
      acc[i.severity] = (acc[i.severity] ?? 0) + 1; return acc
    }, {} as Record<IssueSeverity, number>)

    const issuesByCategory = allIssues.reduce((acc, i) => {
      acc[i.category] = (acc[i.category] ?? 0) + 1; return acc
    }, {} as Record<IssueCategory, number>)

    const report: AuditReport = {
      generatedAt: new Date().toISOString(),
      rootDir,
      summary: {
        totalFiles: project.getSourceFiles().length,
        totalRoutes: routes.length,
        totalComponents: components.length,
        totalHooks: hooks.length,
        totalDbQueries: dbQueries.length,
        totalIssues: allIssues.length,
        issuesByCategory,
        issuesBySeverity,
        coverageScore,
      },
      routes,
      components,
      hooks,
      dbQueries,
      verticalSlices,
      dependencyGraph,
      issues: allIssues,
      fixPlan,
    }

    // ── Print summary ────────────────────────────────────────────────────
    console.log()
    console.log(chalk.bold('  Summary'))
    console.log(`  Coverage score:   ${colorScore(coverageScore)}%`)
    console.log(`  Routes:           ${chalk.bold(routes.length)}`)
    console.log(`  Vertical slices:  ${chalk.bold(verticalSlices.length)}`)
    console.log(`  Circular deps:    ${chalk.bold(dependencyGraph.cycles.length)}`)
    console.log(`  Total issues:     ${chalk.bold(allIssues.length)} (${chalk.red(issuesBySeverity.critical ?? 0)} critical, ${chalk.yellow(issuesBySeverity.high ?? 0)} high, ${issuesBySeverity.medium ?? 0} medium)`)
    console.log()

    // ── Print issues above min-severity ─────────────────────────────────
    const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
    const minSev = sevOrder[opts.minSeverity] ?? 2
    const filteredIssues = allIssues.filter(i => (sevOrder[i.severity] ?? 4) <= minSev)

    if (filteredIssues.length > 0) {
      console.log(chalk.bold(`  Issues (≥ ${opts.minSeverity})`))
      for (const issue of filteredIssues.slice(0, 30)) {
        const sev = sevLabel(issue.severity)
        const file = issue.file.replace(rootDir + '/', '').split('/').slice(-2).join('/')
        console.log(`  ${sev} ${chalk.dim(`${file}:${issue.line}`)} ${issue.message}`)
      }
      if (filteredIssues.length > 30) console.log(chalk.dim(`  … and ${filteredIssues.length - 30} more (see report)`))
      console.log()
    }

    // ── Write reports ────────────────────────────────────────────────────
    if (opts.html !== false) {
      spinner.start(`Writing HTML report to ${opts.output}…`)
      const html = generateHtmlReport(report)
      fs.writeFileSync(path.resolve(opts.output), html, 'utf8')
      spinner.succeed(`HTML report: ${chalk.cyan(path.resolve(opts.output))}`)
    }

    if (opts.json) {
      fs.writeFileSync(path.resolve(opts.json), JSON.stringify(report, null, 2), 'utf8')
      console.log(chalk.dim(`  JSON report: ${opts.json}`))
    }

    console.log()
    if ((issuesBySeverity.critical ?? 0) > 0) process.exit(1)
  })

program.parse()

function colorScore(score: number): string {
  if (score >= 80) return chalk.green(score)
  if (score >= 60) return chalk.yellow(score)
  if (score >= 40) return chalk.hex('#fb923c')(score)
  return chalk.red(score)
}

function sevLabel(severity: string): string {
  const map: Record<string, string> = {
    critical: chalk.bgRed.white(' CRIT '),
    high:     chalk.bgHex('#7c2d12').white(' HIGH '),
    medium:   chalk.bgHex('#713f12').black(' MED  '),
    low:      chalk.bgBlue.white(' LOW  '),
    info:     chalk.bgGray.white(' INFO '),
  }
  return map[severity] ?? severity
}
