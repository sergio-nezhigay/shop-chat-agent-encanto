/**
 * Tool Service
 * Manages tool execution and processing
 */
import { saveMessage } from "../db.server";
import AppConfig from "./config.server";
import { fetchRecommendedProductsAdmin } from "./metafield.server";

/**
 * Creates a tool service instance
 * @returns {Object} Tool service with methods for managing tools
 */
export function createToolService(shopDomain = null) {
  const CART_MUTATION_TOOL_NAMES = new Set([
    "add_to_cart",
    "clear_cart",
    "empty_cart",
    "remove_cart",
    "remove_from_cart",
    "set_cart",
    "update_cart",
  ]);

  const isCartMutationTool = (toolName) => {
    const normalizedToolName = (toolName || "").toLowerCase();

    if (!normalizedToolName) return false;
    if (normalizedToolName === "get_cart") return false;
    if (CART_MUTATION_TOOL_NAMES.has(normalizedToolName)) return true;

    return normalizedToolName.includes("cart") && !normalizedToolName.includes("get_cart");
  };

  /**
   * Handles a tool error response
   * @param {Object} toolUseResponse - The error response from the tool
   * @param {string} toolName - The name of the tool
   * @param {string} toolUseId - The ID of the tool use request
   * @param {Array} conversationHistory - The conversation history
   * @param {Function} sendMessage - Function to send messages to the client
   * @param {string} conversationId - The conversation ID
   */
  const handleToolError = async (toolUseResponse, toolName, toolUseId, conversationHistory, sendMessage, conversationId) => {
    if (toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, conversationId);
      sendMessage({ type: 'auth_required' });
    } else {
      console.log("Tool use error", toolUseResponse.error);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, conversationId);
    }
  };

  /**
   * Handles a successful tool response
   * @param {Object} toolUseResponse - The response from the tool
   * @param {string} toolName - The name of the tool
   * @param {string} toolUseId - The ID of the tool use request
   * @param {Array} conversationHistory - The conversation history
   * @param {Array} productsToDisplay - Array to add product results to
   * @param {string} conversationId - The conversation ID
   */
  const handleToolSuccess = async (toolUseResponse, toolName, toolUseId, conversationHistory, productsToDisplay, conversationId, toolArgs) => {
    // Check if this is a product search result
    let toolContent = toolUseResponse.content;
    if (toolName === AppConfig.tools.productSearchName) {
      productsToDisplay.push(...await processProductSearchResult(toolUseResponse, toolArgs));

      // [price-debug] Log the raw MCP content Claude will see in conversation history
      try {
        const rawText = toolUseResponse.content?.[0]?.text;
        const rawData = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
        if (rawData?.products) {
          rawData.products.slice(0, 3).forEach((p) => {
            const rawMin = p.price_range?.min;
            const rawVariantPrice = p.variants?.[0]?.price;
            console.log(`[price-debug] product="${p.title}" price_range.min=${JSON.stringify(rawMin)} variant[0].price=${JSON.stringify(rawVariantPrice)}`);
          });
        }
      } catch (e) {
        console.log('[price-debug] could not parse raw MCP content for price logging:', e.message);
      }

      // Enrich the content Claude sees with store-curated recommended products
      // sourced from the `custom.color_variant_products` metafield
      toolContent = await appendUpsellRecommendations(toolUseResponse.content, shopDomain);
    }

    addToolResultToHistory(conversationHistory, toolUseId, toolContent, conversationId);

    return isCartMutationTool(toolName);
  };

  /**
   * Fetches a product image URL from Shopify's public product JSON endpoint.
   * No auth required — works for any publicly accessible storefront.
   * @param {string} productUrl - e.g. "https://store.com/products/handle"
   * @returns {Promise<string>} Image URL or empty string
   */
  const fetchProductImageUrl = async (productUrl) => {
    if (!productUrl) return '';
    try {
      const res = await fetch(`${productUrl}.json`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return '';
      const data = await res.json();
      return data?.product?.featured_image || data?.product?.images?.[0]?.src || '';
    } catch {
      return '';
    }
  };

  /**
   * Enriches a list of formatted products with images fetched from Shopify's
   * public product JSON endpoint for any product missing an image URL.
   * @param {Array} products - Already-formatted product objects
   * @returns {Promise<Array>} Same products with image_url filled in where possible
   */
  const enrichProductsWithImages = async (products) => {
    const missing = products.filter((p) => !p.image_url && p.url);
    if (missing.length === 0) return products;

    const imageMap = {};
    await Promise.all(
      missing.map(async (p) => {
        imageMap[p.id] = await fetchProductImageUrl(p.url);
      })
    );

    return products.map((p) =>
      imageMap[p.id] !== undefined ? { ...p, image_url: imageMap[p.id] } : p
    );
  };

  /**
   * Processes product search results
   * @param {Object} toolUseResponse - The response from the tool
   * @returns {Promise<Array>} Processed product data
   */
  const processProductSearchResult = async (toolUseResponse, toolArgs) => {
    try {
      console.log("Processing product search result");
      let products = [];

      // Extract variant filters (e.g. [{ name: "Size", value: "14" }]) from MCP call args
      const variantFilters = (toolArgs?.filters || [])
        .filter((f) => f.variantOption)
        .map((f) => f.variantOption);

      if (toolUseResponse.content && toolUseResponse.content.length > 0) {
        const content = toolUseResponse.content[0].text;

        try {
          let responseData;
          if (typeof content === 'object') {
            responseData = content;
          } else if (typeof content === 'string') {
            responseData = JSON.parse(content);
          }

          if (responseData?.products && Array.isArray(responseData.products)) {
            products = filterAvailableProducts(responseData.products, variantFilters)
              .slice(0, AppConfig.tools.maxProductsToDisplay)
              .map(formatProductData);

            console.log(`Found ${products.length} products to display (after availability filter)`);

            // Fetch real images from Shopify's public .json endpoint for any
            // products the MCP did not include image data for
            products = await enrichProductsWithImages(products);
          }
        } catch (e) {
          console.error("Error parsing product data:", e);
        }
      }

      return products;
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
  };

  /**
   * Filters out products where no variants are available for sale
   * @param {Array} products - Raw products array from MCP response
   * @returns {Array} Products with at least one available variant
   */
  const filterAvailableProducts = (products, variantFilters = []) => {
    if (variantFilters.length > 0) {
      console.log(`[availability-filter] checking ${products.length} products with variant filters:`, JSON.stringify(variantFilters));
    } else {
      console.log(`[availability-filter] checking ${products.length} products (no variant filters)`);
    }

    return products.filter((product) => {
      const name = product.title || product.product_id || '(unknown)';

      // Schema B: availabilityMatrix present
      if (Array.isArray(product.availabilityMatrix)) {
        if (product.availabilityMatrix.length === 0) {
          console.log(`[availability-filter] product="${name}" keep=false (empty matrix)`);
          return false;
        }

        if (typeof product.availabilityMatrix[0] === 'string') {
          // String schema: each entry is an available combo like "Black/Size 14"
          // If variant filters were passed, require at least one matrix entry to match
          // every requested filter value (e.g. both "14" and "Black" must appear).
          if (variantFilters.length > 0) {
            const keep = variantFilters.every((filter) =>
              product.availabilityMatrix.some((entry) =>
                entry.toLowerCase().includes(filter.value.toLowerCase())
              )
            );
            const matchedEntries = keep
              ? product.availabilityMatrix.filter((entry) =>
                  variantFilters.every((f) => entry.toLowerCase().includes(f.value.toLowerCase()))
                )
              : [];
            console.log(
              `[availability-filter] product="${name}" keep=${keep}`,
              keep ? `matched=${JSON.stringify(matchedEntries.slice(0, 3))}` : `no matrix entry matches filters`
            );
            return keep;
          }
          // No filters: non-empty matrix means product has available variants
          console.log(`[availability-filter] product="${name}" keep=true (non-empty matrix, no filters)`);
          return true;
        }

        // Object schema: check explicit boolean flag
        const keep = product.availabilityMatrix.some(
          (entry) => entry.available === true || entry.availableForSale === true
        );
        console.log(`[availability-filter] product="${name}" keep=${keep} (object matrix)`);
        return keep;
      }

      // Schema A: variants array present — keep if any variant is available for sale
      if (Array.isArray(product.variants) && product.variants.length > 0) {
        const keep = product.variants.some((v) => v.availableForSale !== false);
        console.log(`[availability-filter] product="${name}" keep=${keep} (variants schema)`);
        return keep;
      }

      // No availability data — keep the product (benefit of the doubt)
      console.log(`[availability-filter] product="${name}" keep=true (no availability data)`);
      return true;
    });
  };

  /**
   * Converts a raw Shopify price value to a display string.
   * MCP returns prices as {amount: integer, currency: string} where amount is
   * in the smallest currency subunit (e.g. fils for QAR, cents for EUR).
   * Falls back to handling legacy string formats.
   */
  const extractPrice = (raw) => {
    if (raw == null) return null;

    // Object form: {amount: 9600, currency: "QAR"} → "QAR 96.00"
    if (typeof raw === 'object' && raw.amount != null) {
      const major = typeof raw.amount === 'number'
        ? (raw.amount / 100).toFixed(2)
        : String(raw.amount).replace(',', '.');
      console.log(`[price-debug] extractPrice object: amount=${raw.amount} currency=${raw.currency} → ${raw.currency} ${major}`);
      return { currency: raw.currency || '', amount: major };
    }

    // String form fallback: "66,00" → "66.00"
    const str = String(raw);
    const amount = /^\d+,\d{2}$/.test(str) ? str.replace(',', '.') : str;
    console.log(`[price-debug] extractPrice string: input=${str} → ${amount}`);
    return { currency: '', amount };
  };

  /**
   * Extracts a product handle from a Shopify product URL.
   * e.g. "https://store.myshopify.com/products/vintage-palette" → "vintage-palette"
   */
  const extractHandleFromUrl = (url) => {
    if (!url) return null;
    const match = url.match(/\/products\/([^/?#]+)/);
    const handle = match ? match[1] : null;
    console.log(`[upsell] extractHandleFromUrl: url="${url}" → handle="${handle}"`);
    return handle;
  };

  /**
   * Appends a supplementary upsell block to the tool result content that Claude
   * will see, sourced from the `custom.color_variant_products` metafield.
   * If no recommendations are found or shopDomain is missing, returns content unchanged.
   *
   * @param {Array} content - Raw tool response content blocks
   * @param {string|null} shopDomainArg - Shop origin URL
   * @returns {Promise<Array>} Content with optional upsell block appended
   */
  const appendUpsellRecommendations = async (content, shopDomainArg) => {
    if (!shopDomainArg || !Array.isArray(content) || content.length === 0) {
      console.log(`[upsell] appendUpsellRecommendations skipped: shopDomain=${shopDomainArg} contentLen=${content?.length}`);
      return content;
    }

    try {
      // Parse products from the first text block
      const rawText = content[0]?.text;
      const rawData = typeof rawText === 'string' ? JSON.parse(rawText) : rawText;
      const products = rawData?.products;
      console.log(`[upsell] Products in search result: ${products?.length ?? 0}`);
      if (!Array.isArray(products) || products.length === 0) return content;

      // Fetch recommendations in parallel for each product
      const enriched = await Promise.all(
        products.slice(0, AppConfig.tools.maxProductsToDisplay).map(async (p) => {
          console.log(`[upsell] Processing product: title="${p.title}" url="${p.url}"`);
          const handle = extractHandleFromUrl(p.url);
          if (!handle) {
            console.log(`[upsell] Could not extract handle from url="${p.url}"`);
            return null;
          }
          const recommended = await fetchRecommendedProductsAdmin(handle, shopDomainArg);
          if (recommended.length === 0) {
            console.log(`[upsell] No recommendations found for handle="${handle}"`);
            return null;
          }
          return { for_product: p.title || handle, recommended };
        })
      );

      const upsellData = enriched.filter(Boolean);
      if (upsellData.length === 0) {
        console.log(`[upsell] No upsell data to append — Claude will use its own expertise`);
        return content;
      }

      console.log(`[upsell] Appending upsell block for ${upsellData.length} product(s):`, JSON.stringify(upsellData));

      return [
        ...content,
        {
          type: "text",
          text: JSON.stringify({ upsell_recommendations: upsellData }),
        },
      ];
    } catch (error) {
      console.log("[upsell] Error building upsell block:", error.message);
      return content;
    }
  };

  const formatProductData = (product) => {
    const priceRaw = product.price_range?.min ?? (product.variants?.[0]?.price ?? null);
    const extracted = extractPrice(priceRaw);
    // If price_range has a top-level currency field as fallback
    const currency = extracted?.currency || product.price_range?.currency || product.variants?.[0]?.currency || '';
    const price = extracted ? `${currency} ${extracted.amount}`.trim() : 'Price not available';

    return {
      id: product.product_id || `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || 'Product',
      price: price,
      image_url: product.image_url || '',
      description: product.description || '',
      url: product.url || ''
    };
  };

  /**
   * Deep-walks a parsed JSON object and converts any Shopify money object
   * {amount: integer, currency: string} from subunit integers to decimal strings.
   * e.g. {amount: 9600, currency: "QAR"} → {amount: "96.00", currency: "QAR"}
   */
  const normalizePriceAmountsInObject = (obj) => {
    if (Array.isArray(obj)) return obj.map(normalizePriceAmountsInObject);
    if (obj !== null && typeof obj === 'object') {
      // Shopify money object: {amount: number, currency: string}
      if (typeof obj.amount === 'number' && typeof obj.currency === 'string') {
        const major = (obj.amount / 100).toFixed(2);
        console.log(`[price-debug] normalized money object: ${obj.amount} ${obj.currency} → ${major} ${obj.currency}`);
        return { ...obj, amount: major };
      }
      const result = {};
      for (const [key, val] of Object.entries(obj)) {
        result[key] = normalizePriceAmountsInObject(val);
      }
      return result;
    }
    return obj;
  };

  /**
   * Normalizes Shopify price subunit integers inside raw MCP tool response content
   * before it enters Claude's conversation history.
   */
  const normalizeToolContentPrices = (content) => {
    if (!Array.isArray(content)) return content;
    return content.map((block) => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block;
      try {
        const data = JSON.parse(block.text);
        const normalized = normalizePriceAmountsInObject(data);
        return { ...block, text: JSON.stringify(normalized) };
      } catch (e) {
        return block; // not JSON, leave untouched
      }
    });
  };

  /**
   * Adds a tool result to the conversation history
   * @param {Array} conversationHistory - The conversation history
   * @param {string} toolUseId - The ID of the tool use request
   * @param {string} content - The content of the tool result
   * @param {string} conversationId - The conversation ID
   */
  const addToolResultToHistory = async (conversationHistory, toolUseId, content, conversationId) => {
    const normalizedContent = normalizeToolContentPrices(content);
    const toolResultMessage = {
      role: 'user',
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: normalizedContent
      }]
    };

    // Add to in-memory history
    conversationHistory.push(toolResultMessage);

    // Save to database with special format to indicate tool result
    if (conversationId) {
      try {
        await saveMessage(conversationId, 'user', JSON.stringify(toolResultMessage.content));
      } catch (error) {
        console.error('Error saving tool result to database:', error);
      }
    }
  };

  return {
    handleToolError,
    handleToolSuccess,
    processProductSearchResult,
    addToolResultToHistory
  };
}

export default {
  createToolService
};
