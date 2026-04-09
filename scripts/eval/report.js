/**
 * Report builder, console printer, and file writer for eval results.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIMENSIONS = ['accuracy', 'format', 'tone', 'completeness', 'escalation'];

/**
 * Builds a full EvalReport from raw per-test results and run metadata.
 */
export function buildReport(results, meta) {
  const byCategory = buildCategoryStats(results, meta.passThreshold);
  const overall = buildOverallStats(results, meta);

  return { meta, perTest: results, summary: { byCategory, overall } };
}

function buildCategoryStats(results, passThreshold) {
  const groups = {};

  for (const r of results) {
    if (!r.judgeResult) continue;
    const cat = r.testCase.category;
    if (!groups[cat]) groups[cat] = { label: r.testCase.categoryLabel, results: [] };
    groups[cat].results.push(r);
  }

  const byCategory = {};
  for (const [cat, { label, results: catResults }] of Object.entries(groups)) {
    const count = catResults.length;
    const avgTotal = avg(catResults.map(r => r.judgeResult.total));
    const avgByDimension = Object.fromEntries(
      DIMENSIONS.map(d => [d, round2(avg(catResults.map(r => r.judgeResult.scores[d])))])
    );
    const passCount = catResults.filter(r => r.judgeResult.total >= passThreshold).length;
    byCategory[cat] = { label, count, avgTotal: round2(avgTotal), avgByDimension, passCount };
  }

  return byCategory;
}

function buildOverallStats(results, meta) {
  const valid = results.filter(r => r.judgeResult);
  const avgTotal = valid.length ? avg(valid.map(r => r.judgeResult.total)) : 0;

  const avgByDimension = Object.fromEntries(
    DIMENSIONS.map(d => [d, round2(valid.length ? avg(valid.map(r => r.judgeResult.scores[d])) : 0)])
  );

  const flagCounts = {};
  for (const r of valid) {
    for (const flag of r.judgeResult.flags) {
      flagCounts[flag] = (flagCounts[flag] || 0) + 1;
    }
  }

  const passCount = valid.filter(r => r.judgeResult.total >= meta.passThreshold).length;
  const passRate = valid.length ? passCount / valid.length : 0;

  let verdict;
  if (avgTotal >= 8.0) verdict = 'PRODUCTION_READY';
  else if (avgTotal >= 6.5) verdict = 'CONDITIONAL_PASS';
  else verdict = 'REQUIRES_REMEDIATION';

  return {
    avgTotal: round2(avgTotal),
    avgByDimension,
    passCount,
    passRate: round3(passRate),
    flagCounts,
    verdict,
  };
}

/**
 * Prints a human-readable summary to the console.
 */
export function printSummary(report) {
  const { meta, summary } = report;
  const { overall, byCategory } = summary;

  console.log('\n========================================');
  console.log(`  EVAL REPORT — ${meta.store.toUpperCase()} — prompt v${meta.promptVersion}`);
  console.log(`  Run at: ${meta.runAt}`);
  console.log(`  Agent: ${meta.model} | Judge: ${meta.judgeModel}`);
  console.log('========================================\n');

  console.log('CATEGORY SCORES:');
  for (const data of Object.values(byCategory)) {
    const bar = '█'.repeat(Math.round(data.avgTotal));
    const passInfo = `${data.passCount}/${data.count} passed`;
    console.log(`  ${data.label.padEnd(26)} avg ${data.avgTotal.toFixed(1)}/10  ${bar.padEnd(10)}  (${passInfo})`);
    const d = data.avgByDimension;
    console.log(`    acc:${d.accuracy}/3  fmt:${d.format}/2  tone:${d.tone}/2  comp:${d.completeness}/2  esc:${d.escalation}/1`);
  }

  const passPercent = (overall.passRate * 100).toFixed(0);
  console.log(`\nOVERALL: ${overall.avgTotal.toFixed(1)}/10  |  ${overall.passCount}/${meta.totalTests} passed (${passPercent}%)  |  ${overall.verdict}`);
  const od = overall.avgByDimension;
  console.log(`         acc:${od.accuracy}/3  fmt:${od.format}/2  tone:${od.tone}/2  comp:${od.completeness}/2  esc:${od.escalation}/1`);

  if (Object.keys(overall.flagCounts).length > 0) {
    console.log('\nFLAGS RAISED:');
    const sorted = Object.entries(overall.flagCounts).sort((a, b) => b[1] - a[1]);
    for (const [flag, count] of sorted) {
      console.log(`  ${flag.padEnd(32)} x${count}`);
    }
  }

  console.log('\nPER-TEST SCORES:');
  for (const r of report.perTest) {
    if (!r.judgeResult) {
      console.log(`  ${r.testCase.id.padEnd(4)}  ERROR: ${r.error ?? 'unknown'}`);
      continue;
    }
    const s = r.judgeResult.scores;
    const passLabel = r.judgeResult.total >= meta.passThreshold ? 'PASS' : 'FAIL';
    const flagStr = r.judgeResult.flags.length ? `  [${r.judgeResult.flags.join(', ')}]` : '';
    console.log(
      `  ${r.testCase.id.padEnd(4)}  ${passLabel}  ${r.judgeResult.total}/10` +
      `  acc:${s.accuracy} fmt:${s.format} tone:${s.tone} comp:${s.completeness} esc:${s.escalation}` +
      flagStr
    );
  }

  console.log(`\nDuration: ${(meta.totalDurationMs / 1000).toFixed(1)}s`);
}

/**
 * Saves the report as JSON and Markdown files in eval-reports/.
 */
export function saveReport(report) {
  const reportsDir = join(__dirname, '../../eval-reports');
  mkdirSync(reportsDir, { recursive: true });

  const timestamp = report.meta.runAt.replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `${report.meta.store}-v${report.meta.promptVersion}-${timestamp}`;

  const jsonPath = join(reportsDir, `${baseName}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\nJSON report:     ${jsonPath}`);

  const mdPath = join(reportsDir, `${baseName}.md`);
  writeFileSync(mdPath, buildMarkdown(report), 'utf8');
  console.log(`Markdown report: ${mdPath}`);
}

function buildMarkdown(report) {
  const { meta, summary, perTest } = report;
  const { overall, byCategory } = summary;

  const lines = [
    `# Eval Report — ${meta.store} — prompt v${meta.promptVersion}`,
    '',
    `**Run at:** ${meta.runAt}  `,
    `**Agent model:** ${meta.model}  `,
    `**Judge model:** ${meta.judgeModel}  `,
    `**Verdict:** ${overall.verdict}`,
    '',
    '## Overall',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Average score | ${overall.avgTotal}/10 |`,
    `| Pass rate | ${overall.passCount}/${meta.totalTests} (${(overall.passRate * 100).toFixed(0)}%) |`,
    `| Accuracy avg | ${overall.avgByDimension.accuracy}/3 |`,
    `| Format avg | ${overall.avgByDimension.format}/2 |`,
    `| Tone avg | ${overall.avgByDimension.tone}/2 |`,
    `| Completeness avg | ${overall.avgByDimension.completeness}/2 |`,
    `| Escalation avg | ${overall.avgByDimension.escalation}/1 |`,
    '',
  ];

  if (Object.keys(overall.flagCounts).length > 0) {
    lines.push('## Flags Raised', '');
    lines.push('| Flag | Count |', '|------|-------|');
    for (const [flag, count] of Object.entries(overall.flagCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${flag} | ${count} |`);
    }
    lines.push('');
  }

  lines.push('## Category Scores', '');
  lines.push('| Category | Avg | Passed | Acc | Fmt | Tone | Comp | Esc |');
  lines.push('|----------|-----|--------|-----|-----|------|------|-----|');
  for (const data of Object.values(byCategory)) {
    const d = data.avgByDimension;
    lines.push(
      `| ${data.label} | ${data.avgTotal}/10 | ${data.passCount}/${data.count} | ${d.accuracy}/3 | ${d.format}/2 | ${d.tone}/2 | ${d.completeness}/2 | ${d.escalation}/1 |`
    );
  }
  lines.push('');

  lines.push('## Per-Test Results', '');
  lines.push('| ID | Category | Score | Pass | Acc | Fmt | Tone | Comp | Esc | Flags |');
  lines.push('|----|----------|-------|------|-----|-----|------|------|-----|-------|');
  for (const r of perTest) {
    if (!r.judgeResult) {
      lines.push(`| ${r.testCase.id} | ${r.testCase.category} | ERROR | — | — | — | — | — | — | ${r.error ?? ''} |`);
      continue;
    }
    const s = r.judgeResult.scores;
    const pass = r.judgeResult.total >= meta.passThreshold ? 'PASS' : 'FAIL';
    const flags = r.judgeResult.flags.join(', ');
    lines.push(
      `| ${r.testCase.id} | ${r.testCase.category} | ${r.judgeResult.total}/10 | ${pass} | ${s.accuracy} | ${s.format} | ${s.tone} | ${s.completeness} | ${s.escalation} | ${flags} |`
    );
  }
  lines.push('');

  lines.push('## Detailed Rationale', '');
  for (const r of perTest) {
    if (!r.judgeResult) continue;
    lines.push(`### ${r.testCase.id} — ${r.testCase.question}`);
    lines.push('');
    lines.push(`**Score:** ${r.judgeResult.total}/10  |  **Flags:** ${r.judgeResult.flags.join(', ') || 'none'}`);
    lines.push('');
    lines.push('**Agent response:**');
    lines.push('');
    lines.push('> ' + r.agentResponse.replace(/\n/g, '\n> '));
    lines.push('');
    lines.push('**Rationale:**');
    for (const [dim, text] of Object.entries(r.judgeResult.rationale)) {
      lines.push(`- **${dim}:** ${text}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

const LAST_RESULTS_PATH = join(__dirname, 'last-results.json');

/**
 * Loads the last eval results from last-results.json.
 * Returns null if the file doesn't exist yet.
 */
export function loadLastResults() {
  try {
    return JSON.parse(readFileSync(LAST_RESULTS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Saves a minimal snapshot of the current report to last-results.json.
 * This file is committed to git so it persists across runs.
 */
export function saveLastResults(report) {
  const snapshot = {
    promptVersion: report.meta.promptVersion,
    runAt: report.meta.runAt,
    overall: {
      avgTotal: report.summary.overall.avgTotal,
      passCount: report.summary.overall.passCount,
      passRate: report.summary.overall.passRate,
      verdict: report.summary.overall.verdict,
    },
    perTest: report.perTest
      .filter(r => r.judgeResult)
      .map(r => ({ id: r.testCase.id, total: r.judgeResult.total, flags: r.judgeResult.flags })),
  };
  writeFileSync(LAST_RESULTS_PATH, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log(`Last results saved: ${LAST_RESULTS_PATH}`);
}

/**
 * Prints a before/after comparison between the current report and the last saved results.
 */
export function printComparison(report, last) {
  if (!last) return;

  const cur = report.summary.overall;
  const deltaTotal = round2(cur.avgTotal - last.overall.avgTotal);
  const deltaPass = cur.passCount - last.overall.passCount;
  const deltaSign = n => n > 0 ? `+${n}` : `${n}`;

  console.log('\n--- Comparison vs v' + last.promptVersion + ' (' + last.runAt.slice(0, 10) + ') ---');
  console.log(
    `  Overall:  ${last.overall.avgTotal} → ${cur.avgTotal}  (${deltaSign(deltaTotal)})` +
    `  |  passes: ${last.overall.passCount} → ${cur.passCount}  (${deltaSign(deltaPass)})`
  );

  // Build lookup maps
  const lastById = Object.fromEntries(last.perTest.map(t => [t.id, t]));
  const curById = Object.fromEntries(
    report.perTest.filter(r => r.judgeResult).map(r => [r.testCase.id, {
      total: r.judgeResult.total,
      flags: r.judgeResult.flags,
    }])
  );

  const improved = [], degraded = [], stable = [];

  for (const id of Object.keys(curById)) {
    const c = curById[id];
    const l = lastById[id];
    if (!l) continue;
    const delta = c.total - l.total;
    if (delta > 0) improved.push({ id, from: l.total, to: c.total, delta, wasFlags: l.flags, nowFlags: c.flags });
    else if (delta < 0) degraded.push({ id, from: l.total, to: c.total, delta, wasFlags: l.flags, nowFlags: c.flags });
    else stable.push(id);
  }

  if (improved.length) {
    console.log('\n  IMPROVED:');
    for (const t of improved.sort((a, b) => b.delta - a.delta)) {
      const wasF = t.wasFlags.length ? `  was: [${t.wasFlags.join(', ')}]` : '';
      const nowF = t.nowFlags.length ? `  now: [${t.nowFlags.join(', ')}]` : '';
      console.log(`    ${t.id.padEnd(4)}  ${t.from} → ${t.to}  (+${t.delta})${wasF}${nowF}`);
    }
  }

  if (degraded.length) {
    console.log('\n  DEGRADED:');
    for (const t of degraded.sort((a, b) => a.delta - b.delta)) {
      const wasF = t.wasFlags.length ? `  was: [${t.wasFlags.join(', ')}]` : '';
      const nowF = t.nowFlags.length ? `  now: [${t.nowFlags.join(', ')}]` : '';
      console.log(`    ${t.id.padEnd(4)}  ${t.from} → ${t.to}  (${t.delta})${wasF}${nowF}`);
    }
  }

  if (stable.length) {
    console.log(`\n  STABLE (${stable.length}): ${stable.join(' ')}`);
  }
}

// --- Helpers ---

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
