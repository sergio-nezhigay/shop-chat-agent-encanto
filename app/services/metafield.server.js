/**
 * Metafield Service
 * Fetches the `custom.color_variant_products` (Recommended Products) metafield
 * via the Shopify Storefront API (metafield has storefront access enabled).
 * Uses the storefront's own domain — works with custom domains, no admin session needed.
 */

const STOREFRONT_API_VERSION = "2025-10";

// Storefront API query — works because custom.color_variant_products has storefront access
const RECOMMENDED_PRODUCTS_QUERY = `
  query RecommendedProducts($handle: String!) {
    product(handle: $handle) {
      metafield(namespace: "custom", key: "color_variant_products") {
        references(first: 5) {
          nodes {
            ... on Product {
              handle
              title
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetches the curated recommended products for a given product handle via the
 * `custom.color_variant_products` (list.product_reference) metafield.
 * Requires the metafield to have Storefront API access enabled in Shopify admin.
 *
 * @param {string} productHandle - Shopify product handle (e.g. "ctr-w0635-brush")
 * @param {string} shopDomain - Full shop origin (e.g. "https://encantoshop.es")
 * @returns {Promise<Array<{title: string, handle: string, url: string}>>}
 */
export async function fetchRecommendedProducts(productHandle, shopDomain) {
  if (!productHandle || !shopDomain) {
    console.log(`[metafield] Skipped: productHandle=${productHandle} shopDomain=${shopDomain}`);
    return [];
  }

  try {
    const hostname = new URL(shopDomain).hostname;
    const endpoint = `https://${hostname}/api/${STOREFRONT_API_VERSION}/graphql.json`;
    console.log(`[metafield] Storefront API request: handle="${productHandle}" endpoint="${endpoint}"`);

    const storefrontToken = process.env.SHOPIFY_STOREFRONT_TOKEN;
    console.log(`[metafield] Storefront token present: ${!!storefrontToken}`);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(storefrontToken ? { "X-Shopify-Storefront-Access-Token": storefrontToken } : {}),
      },
      body: JSON.stringify({
        query: RECOMMENDED_PRODUCTS_QUERY,
        variables: { handle: productHandle },
      }),
      signal: AbortSignal.timeout(4000),
    });

    console.log(`[metafield] Storefront API HTTP status: ${response.status}`);

    if (!response.ok) {
      const body = await response.text();
      console.log(`[metafield] Storefront API error body: ${body}`);
      return [];
    }

    const data = await response.json();
    console.log(`[metafield] Raw Storefront response for "${productHandle}":`, JSON.stringify(data?.data ?? data?.errors ?? data));

    const nodes = data?.data?.product?.metafield?.references?.nodes ?? [];
    console.log(`[metafield] Found ${nodes.length} recommended product(s) for "${productHandle}":`, nodes.map(n => n.handle));

    return nodes.map((node) => ({
      title: node.title,
      handle: node.handle,
      url: `https://${hostname}/products/${node.handle}`,
    }));
  } catch (error) {
    console.log(`[metafield] Error fetching recommendations for "${productHandle}":`, error.message);
    return [];
  }
}
