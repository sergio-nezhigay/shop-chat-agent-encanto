/**
 * LLM-as-judge scorer for prompt quality evaluation.
 * Sends agent response + rubric to a stronger Claude model and parses structured scores.
 */

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for AI customer support chatbots. You are given:
1. The full SYSTEM PROMPT the chatbot was operating under (its knowledge base and rules)
2. A CUSTOMER QUESTION
3. The CHATBOT RESPONSE to assess

Your task is to score the chatbot response across five dimensions and return a structured JSON object.

SCORING RUBRIC:

ACCURACY (0–3):
- 3: Every factual claim is directly supported by the system prompt's knowledge base. No invented prices, policies, timelines, or product details.
- 2: Mostly accurate. One minor imprecision that doesn't mislead the customer (e.g., slight paraphrase that preserves truth).
- 1: Contains one claim not supported by the knowledge base but not egregiously wrong.
- 0: Contains invented facts (hallucinated prices, non-existent products, fabricated policies) or contradicts the knowledge base.

FORMAT (0–2):
- 2: Uses **bold** for key terms, numbers, and action items. Uses bullet lists for multi-part answers. All links formatted as [descriptive text](URL) — no raw URLs visible. Appropriate length.
- 1: Partially follows formatting rules. Minor issues (e.g., forgot bold on one key term, slightly long).
- 0: Ignores formatting rules. Shows raw URLs, no bold on key terms, wall of text for multi-part answer.

TONE (0–2):
- 2: No filler openers ("Great question!", "Certainly!", "Of course!", "Absolutely!"). Warm but direct. Matches the store's persona. Does not feel robotic.
- 1: Mostly good tone, but includes one filler opener or one slightly off-persona phrase.
- 0: Starts with a filler opener AND/OR feels cold, robotic, or inconsistent with the persona.

COMPLETENESS (0–2):
- 2: Leads with the direct answer first. Adds 1–2 sentences of genuinely useful context (next steps, related policy, relevant link). Not padded.
- 1: Answers the question but either buries the answer OR omits useful follow-up context entirely.
- 0: Does not answer the question, answers the wrong question, or is so incomplete it leaves the customer without actionable information.

ESCALATION (0–1):
- 1: Correctly handles escalation. If the question requires human action (specific order issues, returns, account-specific needs), the response provides the support email. If the question can be answered directly (general product info, shipping policies), the response does NOT unnecessarily escalate.
- 0: Either fails to escalate when escalation is required, OR escalates unnecessarily for a question that could be answered directly.

After scoring, identify any flags from this list (include all that apply):
- HALLUCINATION: Response contains a factual claim not supported by the knowledge base
- MISSING_ESCALATION: Escalation was required but support email was not provided
- UNNECESSARY_ESCALATION: Escalation was not required but support email was provided anyway
- FILLER_OPENER: Response begins with a filler phrase like "Great question!", "Certainly!", "Of course!", "Absolutely!"
- RAW_URL: A URL is displayed as plain text rather than formatted as markdown [text](url)
- MISSING_BOLD: Key terms, numbers, or action items are not bolded when they should be
- INCOMPLETE_ANSWER: The direct answer to the question is missing or buried
- OUT_OF_SCOPE_HONEST: The agent correctly stated it doesn't have information on the topic (informational, not a failure)

Return ONLY a valid JSON object with this exact structure (no markdown code fences, no preamble):
{
  "scores": {
    "accuracy": <0-3>,
    "format": <0-2>,
    "tone": <0-2>,
    "completeness": <0-2>,
    "escalation": <0-1>
  },
  "total": <sum 0-10>,
  "rationale": {
    "accuracy": "<1-2 sentence explanation>",
    "format": "<1-2 sentence explanation>",
    "tone": "<1-2 sentence explanation>",
    "completeness": "<1-2 sentence explanation>",
    "escalation": "<1-2 sentence explanation>"
  },
  "flags": [<array of flag strings, may be empty>]
}`;

/**
 * Scores a single agent response using LLM-as-judge.
 *
 * @param {string} question - The customer question
 * @param {string} agentResponse - The chatbot's response to evaluate
 * @param {string} systemPromptText - The full assembled system prompt (for accuracy checking)
 * @param {Object} testCase - The test case object (for escalation expectation + notes)
 * @param {import('@anthropic-ai/sdk').Anthropic} anthropic - Anthropic client instance
 * @param {string} judgeModel - Model ID to use as judge
 * @returns {Promise<Object>} JudgeResult with scores, total, rationale, flags
 */
export async function scoreResponse(
  question,
  agentResponse,
  systemPromptText,
  testCase,
  anthropic,
  judgeModel
) {
  const userMessage = buildJudgeUserMessage(question, agentResponse, systemPromptText, testCase);

  const response = await anthropic.messages.create({
    model: judgeModel,
    max_tokens: 1024,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const rawText = response.content[0].text;
  return parseJudgeResponse(rawText);
}

function buildJudgeUserMessage(question, agentResponse, systemPromptText, testCase) {
  const lines = [
    '## SYSTEM PROMPT THE CHATBOT WAS USING:',
    systemPromptText,
    '',
    '---',
    '',
    `## CUSTOMER QUESTION:\n${question}`,
    '',
    '---',
    '',
    `## CHATBOT RESPONSE TO EVALUATE:\n${agentResponse}`,
    '',
    '---',
    '',
    '## EVALUATION CONTEXT:',
    `- This question ${testCase.expectsEscalation ? 'REQUIRES' : 'does NOT require'} escalation to the support email.`,
  ];

  if (testCase.notes) {
    lines.push(`- Evaluator note: ${testCase.notes}`);
  }

  return lines.join('\n');
}

function parseJudgeResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    // Extract JSON block if model wrapped it in prose
    const match = rawText.match(/\{[\s\S]+\}/);
    if (!match) {
      throw new Error(`Judge returned non-JSON output: ${rawText.slice(0, 200)}`);
    }
    parsed = JSON.parse(match[0]);
  }

  const scores = {
    accuracy: clamp(parsed.scores?.accuracy ?? 0, 0, 3),
    format: clamp(parsed.scores?.format ?? 0, 0, 2),
    tone: clamp(parsed.scores?.tone ?? 0, 0, 2),
    completeness: clamp(parsed.scores?.completeness ?? 0, 0, 2),
    escalation: clamp(parsed.scores?.escalation ?? 0, 0, 1),
  };
  const total = Object.values(scores).reduce((a, b) => a + b, 0);

  return {
    scores,
    total,
    rationale: parsed.rationale ?? {},
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
    rawJudgeResponse: rawText,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
