/**
 * Metafield Service
 * Fetches the `custom.color_variant_products` metafield via the Storefront API,
 * using a token created dynamically through the Admin API (storefrontAccessTokenCreate).
 * The token is cached in memory for the process lifetime.
 */

import shopify from "../shopify.server.js";
import prisma from "../db.server.js";

const STOREFRONT_API_VERSION = "2025-10";

const RECOMMENDED_PRODUCTS_QUERY = `
  query RecommendedProducts($handle: String!) {
    product(handle: $handle) {
      metafield(namespace: "custom", key: "color_variant_products") {
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
 * For custom domains, looks up the offline session in the database.
 */
async function resolveMyshopifyDomain(hostname) {
  if (hostname.endsWith(".myshopify.com")) return hostname;

  const session = await prisma.session.findFirst({
    where: { shop: { endsWith: ".myshopify.com" } },
    select: { shop: true },
    orderBy: { id: "desc" },
  });

  if (!session) throw new Error(`No myshopify session found for custom domain: ${hostname}`);
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
  return token;
}

/**
 * Fetches the curated companion products for a given product handle from the
 * `custom.color_variant_products` (list.product_reference) metafield.
 *
 * @param {string} productHandle - Shopify product handle (e.g. "ctr-w0635-brush")
 * @param {string} shopDomain - Full shop origin (e.g. "https://encantoshop.es")
 * @returns {Promise<Array<{title: string, handle: string, url: string}>>}
 */
export async function fetchRecommendedProductsAdmin(productHandle, shopDomain) {
  if (!productHandle || !shopDomain) return [];

  try {
    const hostname = new URL(shopDomain).hostname;
    const token = await getStorefrontToken(hostname);
    const endpoint = `https://${hostname}/api/${STOREFRONT_API_VERSION}/graphql.json`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": token,
      },
      body: JSON.stringify({
        query: RECOMMENDED_PRODUCTS_QUERY,
        variables: { handle: productHandle },
      }),
      signal: AbortSignal.timeout(4000),
    });

    const data = await response.json();

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      console.error(`[metafield] GraphQL errors for "${productHandle}":`, JSON.stringify(data.errors));
      return [];
    }

    const nodes = data?.data?.product?.metafield?.references?.nodes ?? [];
    return nodes.map((node) => ({
      title: node.title,
      handle: node.handle,
      url: `https://${hostname}/products/${node.handle}`,
    }));
  } catch (error) {
    console.error(`[metafield] Error for "${productHandle}":`, error.message);
    return [];
  }
}
