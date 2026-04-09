/**
 * Prompt Quality Evaluation — Encanto
 *
 * Assembles the production system prompt, runs 25 test questions through
 * Claude (Haiku, matching production), scores each response with an LLM judge
 * (Sonnet), and writes JSON + Markdown reports to eval-reports/.
 *
 * Usage:
 *   npm run eval
 *
 * Optional env overrides:
 *   EVAL_PROMPT_TYPE   — prompt key in prompts.json (default: standardAssistant)
 *   EVAL_AGENT_MODEL   — model used to answer questions (default: claude-haiku-4-5-20251001)
 *   EVAL_JUDGE_MODEL   — model used to score responses (default: claude-sonnet-4-6)
 */

import { createRequire } from 'module';
import { Anthropic } from '@anthropic-ai/sdk';
import { scoreResponse } from './scorer.js';
import { buildReport, printSummary, saveReport, loadLastResults, saveLastResults, printComparison } from './report.js';

// Use createRequire to load JSON in an ESM context
const require = createRequire(import.meta.url);

const DELAY_MS = 1500; // Courtesy delay between API calls to stay within rate limits
const PASS_THRESHOLD = 7; // Minimum score (out of 10) to count a test as passed

// ---------------------------------------------------------------------------
// Prompt assembly
// Replicates getSystemPrompt() from claude.server.js without importing
// React Router modules (which would fail in a plain Node script).
// ---------------------------------------------------------------------------
async function buildSystemPrompt(promptType) {
  const prompts = require('../../app/prompts/prompts.json');
  const config = prompts.systemPrompts[promptType];

  if (!config) {
    throw new Error(
      `Prompt type "${promptType}" not found in prompts.json. ` +
      `Available: ${Object.keys(prompts.systemPrompts).join(', ')}`
    );
  }

  const { faqKnowledgeBase } = await import('../../app/prompts/knowledge/faq.js');
  const { makeupConsultantGuide } = await import('../../app/prompts/knowledge/makeup-consultant-guide.js');
  const { cartCheckoutPattern } = await import('../../app/prompts/knowledge/cart-checkout-pattern.js');

  const variables = {
    persona: config.persona ?? '',
    behavioralRules: config.behavioralRules ?? '',
    examples: config.examples ?? '',
    formattingGuidelines: config.formattingGuidelines ?? '',
    cartCheckoutPattern,
    makeupConsultantGuide,
    faqKnowledgeBase,
  };

  const text = config.template.replace(/\$\{(\w+)\}/g, (_, key) => variables[key] ?? '');

  return { text, version: config.version ?? 'unknown', promptType };
}

// ---------------------------------------------------------------------------
// Agent call (non-streaming — eval only needs the final text response)
// ---------------------------------------------------------------------------
async function callAgent(question, systemPromptText, anthropic, agentModel) {
  const response = await anthropic.messages.create({
    model: agentModel,
    max_tokens: 1024,
    system: [{ type: 'text', text: systemPromptText }],
    messages: [{ role: 'user', content: question }],
  });
  return response.content[0].text;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) {
    throw new Error('CLAUDE_API_KEY is not set. Add it to your .env file.');
  }

  const promptType = process.env.EVAL_PROMPT_TYPE || 'standardAssistant';
  const agentModel = process.env.EVAL_AGENT_MODEL || 'claude-haiku-4-5-20251001';
  const judgeModel = process.env.EVAL_JUDGE_MODEL || 'claude-sonnet-4-6';

  // Dynamic import so test-cases.json is resolved relative to this file
  const { default: testCases } = await import('./test-cases.json', { with: { type: 'json' } });

  const anthropic = new Anthropic({ apiKey });

  const lastResults = loadLastResults();

  console.log(`\n--- Encanto Prompt Eval ---`);
  console.log(`Agent model:  ${agentModel}`);
  console.log(`Judge model:  ${judgeModel}`);
  console.log(`Prompt type:  ${promptType}`);
  console.log(`Test cases:   ${testCases.length}\n`);

  const { text: systemPromptText, version } = await buildSystemPrompt(promptType);
  const startTime = Date.now();
  const results = [];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    const questionPreview = tc.question.length > 55
      ? tc.question.slice(0, 52) + '...'
      : tc.question;
    process.stdout.write(`[${i + 1}/${testCases.length}] ${tc.id} (${tc.category}) — "${questionPreview}"... `);

    const tStart = Date.now();
    let agentResponse = '';
    let judgeResult;
    let error;

    try {
      agentResponse = await callAgent(tc.question, systemPromptText, anthropic, agentModel);
      judgeResult = await scoreResponse(
        tc.question,
        agentResponse,
        systemPromptText,
        tc,
        anthropic,
        judgeModel
      );
      const passLabel = judgeResult.total >= PASS_THRESHOLD ? 'PASS' : 'FAIL';
      const flagStr = judgeResult.flags.length ? `  [${judgeResult.flags.join(', ')}]` : '';
      console.log(`${passLabel}  ${judgeResult.total}/10${flagStr}`);
    } catch (err) {
      error = err.message;
      console.log(`ERROR: ${error}`);
    }

    results.push({
      testCase: tc,
      agentResponse,
      judgeResult: judgeResult ?? null,
      durationMs: Date.now() - tStart,
      error: error ?? null,
    });

    if (i < testCases.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  const totalDurationMs = Date.now() - startTime;

  const report = buildReport(results, {
    store: 'encanto',
    promptVersion: version,
    promptType,
    model: agentModel,
    judgeModel,
    runAt: new Date().toISOString(),
    totalDurationMs,
    totalTests: testCases.length,
    passThreshold: PASS_THRESHOLD,
  });

  printSummary(report);
  printComparison(report, lastResults);
  saveReport(report);
  saveLastResults(report);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
