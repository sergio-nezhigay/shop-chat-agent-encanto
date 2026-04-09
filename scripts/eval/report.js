/**
 * Report builder, console printer, and file writer for eval results.
 */

import { writeFileSync, mkdirSync } from 'fs';
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

// --- Helpers ---

function avg(nums) {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round3(n) { return Math.round(n * 1000) / 1000; }
