import type { AuditReport } from '../types.js'

/** Generates a self-contained HTML report with an interactive D3 dependency graph */
export function generateHtmlReport(report: AuditReport): string {
  const summary = report.summary
  const criticalIssues = report.issues.filter(i => i.severity === 'critical' || i.severity === 'high')
  const topSlices = report.verticalSlices.slice(0, 20)

  const graphData = buildGraphData(report)

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Repo Audit — ${escHtml(report.rootDir.split('/').pop() ?? 'unknown')}</title>
  <script src="https://d3js.org/d3.v7.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header h1 { font-size: 1.25rem; font-weight: 700; color: #f1f5f9; }
    header .badge { background: #6366f1; color: #fff; font-size: 0.7rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
    .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
    .grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; }
    .card h3 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin-bottom: 0.5rem; }
    .card .value { font-size: 2rem; font-weight: 700; color: #f1f5f9; }
    .card .sub { font-size: 0.8rem; color: #64748b; margin-top: 0.25rem; }
    .score-ring { position: relative; display: inline-flex; align-items: center; justify-content: center; }
    h2 { font-size: 1rem; font-weight: 600; color: #f1f5f9; margin: 1.5rem 0 0.75rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; background: #1e293b; color: #94a3b8; font-weight: 500; border-bottom: 1px solid #334155; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e293b; vertical-align: top; }
    tr:hover td { background: #1e293b55; }
    .badge-sev { display: inline-block; padding: 1px 8px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; }
    .sev-critical { background: #7f1d1d; color: #fca5a5; }
    .sev-high { background: #7c2d12; color: #fdba74; }
    .sev-medium { background: #713f12; color: #fde68a; }
    .sev-low { background: #1e3a5f; color: #93c5fd; }
    .sev-info { background: #1e293b; color: #94a3b8; }
    .mono { font-family: 'Fira Code', monospace; font-size: 0.75rem; color: #7dd3fc; }
    #graph { width: 100%; height: 500px; border-radius: 0.75rem; border: 1px solid #334155; overflow: hidden; background: #0f172a; margin-bottom: 2rem; }
    .graph-node circle { stroke-width: 2; cursor: pointer; }
    .graph-node text { fill: #e2e8f0; font-size: 10px; pointer-events: none; }
    .graph-link { stroke: #334155; stroke-opacity: 0.6; }
    .tooltip { position: absolute; background: #1e293b; border: 1px solid #334155; border-radius: 0.5rem; padding: 0.5rem 0.75rem; font-size: 0.75rem; pointer-events: none; max-width: 300px; z-index: 100; }
    .section { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 1.5rem; overflow-x: auto; }
    footer { text-align: center; color: #475569; font-size: 0.75rem; padding: 2rem; }
  </style>
</head>
<body>
<header>
  <h1>Repo Audit</h1>
  <span class="badge">${escHtml(report.rootDir.split('/').pop() ?? '')}</span>
  <span style="color:#64748b;font-size:0.8rem;margin-left:auto">${new Date(report.generatedAt).toLocaleString()}</span>
</header>
<div class="container">

  <!-- Summary cards -->
  <div class="grid-3">
    <div class="card">
      <h3>Coverage Score</h3>
      <div class="value" style="color:${scoreColor(summary.coverageScore)}">${summary.coverageScore}%</div>
      <div class="sub">routes traced to UI</div>
    </div>
    <div class="card">
      <h3>Routes</h3>
      <div class="value">${summary.totalRoutes}</div>
      <div class="sub">${summary.totalComponents} components · ${summary.totalHooks} hooks</div>
    </div>
    <div class="card">
      <h3>DB Queries</h3>
      <div class="value">${summary.totalDbQueries}</div>
      <div class="sub">across all backend files</div>
    </div>
    <div class="card">
      <h3>Issues</h3>
      <div class="value" style="color:${summary.issuesBySeverity.critical > 0 ? '#f87171' : '#fb923c'}">${summary.totalIssues}</div>
      <div class="sub">${summary.issuesBySeverity.critical ?? 0} critical · ${summary.issuesBySeverity.high ?? 0} high</div>
    </div>
    <div class="card">
      <h3>Fix Effort</h3>
      <div class="value">${report.fixPlan.reduce((s, t) => s + t.estimatedLoc, 0)}</div>
      <div class="sub">estimated lines of code</div>
    </div>
    <div class="card">
      <h3>Vertical Slices</h3>
      <div class="value">${report.verticalSlices.length}</div>
      <div class="sub">full-stack traces found</div>
    </div>
  </div>

  <!-- Dependency graph -->
  <h2>Dependency Graph</h2>
  <div id="graph"></div>
  <div id="tooltip" class="tooltip" style="display:none"></div>

  <!-- Critical issues -->
  <h2>Critical &amp; High Issues</h2>
  <div class="section">
    <table>
      <thead><tr><th>Severity</th><th>Category</th><th>Message</th><th>File</th><th>Line</th></tr></thead>
      <tbody>
        ${criticalIssues.map(i => `
        <tr>
          <td><span class="badge-sev sev-${escHtml(i.severity)}">${escHtml(i.severity)}</span></td>
          <td class="mono">${escHtml(i.category)}</td>
          <td>${escHtml(i.message)}</td>
          <td class="mono" title="${escHtml(i.file)}">${escHtml(i.file.split('/').slice(-2).join('/'))}</td>
          <td>${i.line}</td>
        </tr>`).join('')}
        ${criticalIssues.length === 0 ? '<tr><td colspan="5" style="color:#64748b;text-align:center;padding:1rem">No critical or high issues found</td></tr>' : ''}
      </tbody>
    </table>
  </div>

  <!-- Top vertical slices -->
  <h2>Vertical Slices (top ${topSlices.length})</h2>
  <div class="section">
    <table>
      <thead><tr><th>Depth</th><th>Trace</th><th>Issues</th></tr></thead>
      <tbody>
        ${topSlices.map(s => `
        <tr>
          <td>${s.depth}</td>
          <td class="mono">${escHtml(s.label)}</td>
          <td>${s.issues.length > 0 ? `<span class="badge-sev sev-${escHtml(s.issues[0].severity)}">${s.issues.length}</span>` : '—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

  <!-- Fix plan -->
  <h2>Fix Plan (${report.fixPlan.length} tasks)</h2>
  <div class="section">
    <table>
      <thead><tr><th>Priority</th><th>Title</th><th>Issues</th><th>Est. LOC</th></tr></thead>
      <tbody>
        ${report.fixPlan.map((t, i) => `
        <tr>
          <td><span class="badge-sev sev-${escHtml(t.severity)}">#${i+1}</span></td>
          <td><b>${escHtml(t.title)}</b><br><span style="color:#64748b;font-size:0.75rem">${escHtml(t.description.slice(0, 100))}${t.description.length > 100 ? '…' : ''}</span></td>
          <td>${t.issues.length}</td>
          <td>~${t.estimatedLoc}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>

</div>
<footer>Generated by repo-auditor · ${new Date(report.generatedAt).toLocaleString()}</footer>

<script>
const graphData = ${JSON.stringify(graphData)};
const tooltip = document.getElementById('tooltip');

const width = document.getElementById('graph').clientWidth;
const height = 500;
const svg = d3.select('#graph').append('svg').attr('width', width).attr('height', height);
const g = svg.append('g');

// Zoom
svg.call(d3.zoom().scaleExtent([0.2, 4]).on('zoom', e => g.attr('transform', e.transform)));

const color = d3.scaleOrdinal()
  .domain(['component', 'hook', 'route', 'db'])
  .range(['#6366f1', '#22d3ee', '#4ade80', '#f59e0b']);

const simulation = d3.forceSimulation(graphData.nodes)
  .force('link', d3.forceLink(graphData.links).id(d => d.id).distance(80))
  .force('charge', d3.forceManyBody().strength(-120))
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collision', d3.forceCollide(20));

const link = g.append('g').selectAll('line')
  .data(graphData.links).enter().append('line')
  .attr('class', 'graph-link')
  .attr('stroke-dasharray', d => d.type === 'api-call' ? '4,2' : null);

const node = g.append('g').selectAll('.graph-node')
  .data(graphData.nodes).enter().append('g')
  .attr('class', 'graph-node')
  .call(d3.drag()
    .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag', (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on('end', (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

node.append('circle')
  .attr('r', d => d.type === 'route' ? 10 : 7)
  .attr('fill', d => color(d.type))
  .attr('stroke', '#0f172a')
  .on('mouseover', (e, d) => {
    tooltip.style.display = 'block';
    tooltip.style.left = (e.pageX + 10) + 'px';
    tooltip.style.top = (e.pageY - 20) + 'px';
    tooltip.innerHTML = \`<b>\${d.label}</b><br><span style="color:#94a3b8">\${d.type} · \${d.file?.split('/').slice(-2).join('/') ?? ''}</span>\`;
  })
  .on('mouseout', () => tooltip.style.display = 'none');

node.append('text').attr('dx', 12).attr('dy', 4).text(d => d.label.slice(0, 20));

simulation.on('tick', () => {
  link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
  node.attr('transform', d => \`translate(\${d.x},\${d.y})\`);
});
</script>
</body>
</html>`
}

function scoreColor(score: number): string {
  if (score >= 80) return '#4ade80'
  if (score >= 60) return '#facc15'
  if (score >= 40) return '#fb923c'
  return '#f87171'
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface GraphNode { id: string; label: string; type: string; file?: string; x?: number; y?: number; fx?: number | null; fy?: number | null }
interface GraphLink { source: string; target: string; type: string }

function buildGraphData(report: AuditReport): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const seen = new Set<string>()

  function addNode(id: string, label: string, type: string, file?: string) {
    if (!seen.has(id)) {
      seen.add(id)
      nodes.push({ id, label, type, file })
    }
  }

  // Limit to top 60 nodes to keep the graph readable
  const topSlices = report.verticalSlices.slice(0, 60)

  for (const slice of topSlices) {
    const compId = slice.component ? `comp:${slice.component.file}:${slice.component.name}` : null
    const hookId = slice.hook ? `hook:${slice.hook.file}:${slice.hook.name}` : null
    const routeId = slice.backendEndpoint ? `route:${slice.backendEndpoint.route.method}:${slice.backendEndpoint.route.path}` : null

    if (compId && slice.component) addNode(compId, slice.component.name, 'component', slice.component.file)
    if (hookId && slice.hook) addNode(hookId, slice.hook.name, 'hook', slice.hook.file)
    if (routeId && slice.backendEndpoint) addNode(routeId, `${slice.backendEndpoint.route.method} ${slice.backendEndpoint.route.path}`, 'route', slice.backendEndpoint.route.file)

    for (const q of slice.dbQueries.slice(0, 3)) {
      const dbId = `db:${q.file}:${q.line}`
      addNode(dbId, q.table ?? 'DB query', 'db', q.file)
      if (routeId) links.push({ source: routeId, target: dbId, type: 'db-query' })
    }

    if (compId && hookId) links.push({ source: compId, target: hookId, type: 'import' })
    if ((compId || hookId) && routeId) {
      const src = hookId ?? compId!
      links.push({ source: src, target: routeId, type: 'api-call' })
    }
  }

  return { nodes, links }
}
