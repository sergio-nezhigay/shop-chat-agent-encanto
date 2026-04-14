/**
 * Claude Service
 * Manages interactions with the Claude API
 */
import { Anthropic } from "@anthropic-ai/sdk";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";
import { makeupConsultantGuide } from "../prompts/knowledge/makeup-consultant-guide";
import { upsellStrategy } from "../prompts/knowledge/upsell-strategy";
import { faqKnowledgeBase } from "../prompts/knowledge/faq";
import { cartCheckoutPattern } from "../prompts/knowledge/cart-checkout-pattern";

const makeupConsultantVariants = {
  standard: makeupConsultantGuide,
};

/**
 * Creates a Claude service instance
 * @param {string} apiKey - Claude API key
 * @returns {Object} Claude service with methods for interacting with Claude API
 */
export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  console.log('[claude.server] API key present:', !!apiKey, 'length:', apiKey?.length ?? 0);

  // Initialize Claude client
  const anthropic = new Anthropic({ apiKey });

  /**
   * Streams a conversation with Claude
   * @param {Object} params - Stream parameters
   * @param {Array} params.messages - Conversation history
   * @param {string} params.promptType - The type of system prompt to use
   * @param {Array} params.tools - Available tools for Claude
   * @param {Object} streamHandlers - Stream event handlers
   * @param {Function} streamHandlers.onText - Handles text chunks
   * @param {Function} streamHandlers.onMessage - Handles complete messages
   * @param {Function} streamHandlers.onToolUse - Handles tool use requests
   * @returns {Promise<Object>} The final message
   */
  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools,
    cartGid,
    pageContext,
    pageProductRecommendations,
    buyerCountry,
    buyerCurrency,
  }, streamHandlers) => {
    // Get system prompt from configuration or use default
    const systemInstruction = getSystemPrompt(promptType, pageContext);

    // Inject customer's existing cart ID so Claude uses it instead of creating a new cart
    if (cartGid) {
      systemInstruction.push({
        type: "text",
        text: `<cart_context>\nThe customer already has an active cart. When calling update_cart to add or modify items, always include cart_id: "${cartGid}". Never omit cart_id or create a new cart.\n</cart_context>`,
      });
    }

    // Inject buyer country/currency so Claude quotes prices in the correct currency
    if (buyerCountry || buyerCurrency) {
      systemInstruction.push({
        type: "text",
        text: `<buyer_context>\nThe customer is located in country "${buyerCountry || "unknown"}". Always quote prices in ${buyerCurrency || "the store's default currency"}. If a product price is returned in a different currency, note the local currency (${buyerCurrency}) instead.\n</buyer_context>`,
      });
    }

    // Inject store-curated companion products for the product currently being viewed
    if (Array.isArray(pageProductRecommendations) && pageProductRecommendations.length > 0) {
      const lines = pageProductRecommendations
        .map((p) => `- ${p.title} (${p.url})`)
        .join("\n");
      systemInstruction.push({
        type: "text",
        text: `<page_product_recommendations>\nThe product on this page has the following store-curated companion products set by the merchant:\n${lines}\nWhen applying the upsell strategy, prefer these specific products over generic suggestions.\n</page_product_recommendations>`,
      });
      console.log(`[upsell] Injected ${pageProductRecommendations.length} page product recommendation(s) into system prompt`);
    }

    // Create stream
    const stream = await anthropic.messages.stream({
      model: AppConfig.api.defaultModel,
      max_tokens: AppConfig.api.maxTokens,
      system: systemInstruction,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      cache_control: { type: "ephemeral" }
    });

    // Set up event handlers
    if (streamHandlers.onText) {
      stream.on('text', streamHandlers.onText);
    }

    if (streamHandlers.onMessage) {
      stream.on('message', streamHandlers.onMessage);
    }

    if (streamHandlers.onContentBlock) {
      stream.on('contentBlock', streamHandlers.onContentBlock);
    }

    // Wait for final message
    const finalMessage = await stream.finalMessage();
    console.log('[claude] cache usage:', JSON.stringify(finalMessage.usage));

    // Process tool use requests
    if (streamHandlers.onToolUse && finalMessage.content) {
      for (const content of finalMessage.content) {
        if (content.type === "tool_use") {
          await streamHandlers.onToolUse(content);
        }
      }
    }

    return finalMessage;
  };

  /**
   * Gets the system prompt content for a given prompt type
   * @param {string} promptType - The prompt type to retrieve
   * @returns {string} The system prompt content
   */
  const getSystemPrompt = (promptType, pageContext) => {
    const config = systemPrompts.systemPrompts[promptType] ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType];

    const variables = {
      persona: config.persona,
      behavioralRules: config.behavioralRules ?? "",
      examples: config.examples ?? "",
      formattingGuidelines: config.formattingGuidelines,
      cartCheckoutPattern,
      makeupConsultantGuide: makeupConsultantVariants.standard,
      upsellStrategy,
      faqKnowledgeBase,
    };

    const text = config.template.replace(/\$\{(\w+)\}/g, (_, key) => variables[key] ?? "");

    const systemPrompt = [
      {
        type: "text",
        text,
        cache_control: { type: "ephemeral" }
      }
    ];

    const normalizedPageContext = normalizePageContext(pageContext);
    if (normalizedPageContext) {
      systemPrompt.push({
        type: "text",
        text: buildPageContextBlock(normalizedPageContext),
      });
    }

    return systemPrompt;
  };

  const buildPageContextBlock = (pageContext) => {
    return `<page_context>
The customer is currently viewing this storefront page.
- URL: ${pageContext.url || ""}
- Pathname: ${pageContext.pathname || ""}
- Title: ${pageContext.title || ""}
- Page type: ${pageContext.page_type || ""}

Use this context to resolve questions about what the customer is looking at. If the page context is sufficient to answer, do not ask what page they are on; answer directly and stay grounded in the current page.
</page_context>`;
  };

  const normalizePageContext = (pageContext) => {
    if (!pageContext || typeof pageContext !== "object") return null;

    const url = typeof pageContext.url === "string" ? pageContext.url.trim() : "";
    const pathname = typeof pageContext.pathname === "string" ? pageContext.pathname.trim() : "";
    const title = typeof pageContext.title === "string" ? pageContext.title.trim() : "";
    const pageType = typeof pageContext.page_type === "string" ? pageContext.page_type.trim() : "";

    if (!url && !pathname && !title && !pageType) return null;

    return {
      ...(url ? { url } : {}),
      ...(pathname ? { pathname } : {}),
      ...(title ? { title } : {}),
      ...(pageType ? { page_type: pageType } : {}),
    };
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default {
  createClaudeService
};
