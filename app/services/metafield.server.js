/**
 * Metafield Service
 * Fetches the `custom.color_variant_products` (Recommended Products) metafield.
 *
 * Two approaches:
 *  - fetchRecommendedProductsAdmin: uses the Admin API via stored offline session (no extra env vars needed)
 *  - fetchRecommendedProducts: uses the Storefront API (requires SHOPIFY_STOREFRONT_TOKEN + metafield storefront access enabled)
 */

import shopify from "../shopify.server.js";
import prisma from "../db.server.js";

const STOREFRONT_API_VERSION = "2025-10";

const STOREFRONT_RECOMMENDED_PRODUCTS_QUERY = `
  query RecommendedProducts($handle: String!) {
    product(handle: $handle) {
      metafield(namespace: "custom", key: "color_variant_products") {
        type
        value
        references(first: 10) {
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

// Per-shop token cache. Tokens are permanent until deleted, so we only create
// one per shop per process lifetime. On restart a new one is created (safe —
// Shopify allows up to 100 per app per shop).
const storefrontTokenCache = new Map();

/**
 * Resolves a hostname (possibly a custom domain like "encantoshop.es") to the
 * corresponding ".myshopify.com" shop domain required by shopify.unauthenticated.admin().
 * For myshopify.com hostnames, returns as-is. For custom domains, looks up the
 * offline session in the database.
 */
async function resolveMyshopifyDomain(hostname) {
  if (hostname.endsWith(".myshopify.com")) return hostname;

  const session = await prisma.session.findFirst({
    where: { shop: { endsWith: ".myshopify.com" } },
    select: { shop: true },
    orderBy: { id: "desc" },
  });

  if (!session) throw new Error(`No myshopify session found for custom domain: ${hostname}`);
  console.log(`[metafield:admin] Resolved custom domain "${hostname}" → "${session.shop}"`);
  return session.shop;
}

async function getStorefrontToken(hostname) {
  if (storefrontTokenCache.has(hostname)) {
    return storefrontTokenCache.get(hostname);
  }

  const shopDomain = await resolveMyshopifyDomain(hostname);
  const { admin } = await shopify.unauthenticated.admin(shopDomain);
  const response = await admin.graphql(`#graphql
    mutation {
      storefrontAccessTokenCreate(input: { title: "chatbot-metafield-token" }) {
        storefrontAccessToken { accessToken }
        userErrors { field message }
      }
    }
  `);
  const data = await response.json();
  const errors = data?.data?.storefrontAccessTokenCreate?.userErrors ?? [];
  const token = data?.data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;

  if (!token) {
    throw new Error(`storefrontAccessTokenCreate failed: ${JSON.stringify(errors)}`);
  }

  storefrontTokenCache.set(hostname, token);
  console.log(`[metafield] Created and cached Storefront token for ${hostname}`);
  return token;
}

/**
 * Fetches recommended products via the Admin GraphQL API using a stored offline session.
 * No extra env vars or Shopify admin settings needed — the Admin API always has metafield access.
 *
 * @param {string} productHandle - Shopify product handle (e.g. "ctr-w0635-brush")
 * @param {string} shopDomain - Full shop origin (e.g. "https://drmtdf-we.myshopify.com")
 * @returns {Promise<Array<{title: string, handle: string, url: string}>>}
 */
/**
 * Fetches recommended products via the Storefront API using a token created
 * dynamically through the Admin API (storefrontAccessTokenCreate). The token
 * is cached in memory for the lifetime of the process.
 *
 * @param {string} productHandle - Shopify product handle (e.g. "ctr-w0635-brush")
 * @param {string} shopDomain - Full shop origin (e.g. "https://drmtdf-we.myshopify.com")
 * @returns {Promise<Array<{title: string, handle: string, url: string}>>}
 */
export async function fetchRecommendedProductsAdmin(productHandle, shopDomain) {
  if (!productHandle || !shopDomain) {
    console.log(`[metafield:admin] Skipped: productHandle=${productHandle} shopDomain=${shopDomain}`);
    return [];
  }

  try {
    const hostname = new URL(shopDomain).hostname;
    const token = await getStorefrontToken(hostname);
    const endpoint = `https://${hostname}/api/${STOREFRONT_API_VERSION}/graphql.json`;

    console.log(`[metafield:admin] Storefront request via dynamic token: handle="${productHandle}"`);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({
        query: STOREFRONT_RECOMMENDED_PRODUCTS_QUERY,
        variables: { handle: productHandle },
      }),
      signal: AbortSignal.timeout(4000),
    });

    const data = await response.json();
    console.log(
      `[metafield:admin] Raw response for "${productHandle}":`,
      JSON.stringify(data?.data ?? data?.errors ?? data),
    );

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.log(`[metafield:admin] GraphQL errors:`, JSON.stringify(data.errors));
      return [];
    }

    const nodes = data?.data?.product?.metafield?.references?.nodes ?? [];
    console.log(
      `[metafield:admin] Found ${nodes.length} recommended product(s) for "${productHandle}":`,
      nodes.map((n) => n.handle),
    );

    return nodes.map((node) => ({
      title: node.title,
      handle: node.handle,
      url: `https://${hostname}/products/${node.handle}`,
    }));
  } catch (error) {
    console.log(`[metafield:admin] Error for "${productHandle}":`, error.message);
    return [];
  }
}

/**
 * Fetches the curated recommended products for a given product handle via the
 * `custom.color_variant_products` (list.product_reference) metafield.
 * Requires the metafield to have Storefront API access enabled in Shopify admin
 * AND a valid SHOPIFY_STOREFRONT_TOKEN env var with `unauthenticated_read_metafields` scope.
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
        query: STOREFRONT_RECOMMENDED_PRODUCTS_QUERY,
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
    console.log(
      `[metafield] Raw Storefront response for "${productHandle}":`,
      JSON.stringify(data?.data ?? data?.errors ?? data),
    );

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.log(
        `[metafield] Storefront GraphQL errors for "${productHandle}":`,
        JSON.stringify(data.errors),
      );
      return [];
    }

    const nodes = data?.data?.product?.metafield?.references?.nodes ?? [];
    console.log(
      `[metafield] Found ${nodes.length} recommended product(s) for "${productHandle}":`,
      nodes.map((n) => n.handle),
    );

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
