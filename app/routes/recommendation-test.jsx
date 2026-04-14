import { fetchRecommendedProducts, fetchRecommendedProductsAdmin } from "../services/metafield.server";
import shopify from "../shopify.server";

const VERSION = "1.0.5";
const FIXED_PRODUCT_HANDLE = "ctr-w0635-brush";
const FIXED_SHOP_ORIGIN = "https://drmtdf-we.myshopify.com";
const STOREFRONT_API_VERSION = "2025-10";

// Admin API: product() requires a GID — look up by handle via products(query:) instead
const ADMIN_RAW_QUERY = `#graphql
  query RecommendedProducts($query: String!) {
    products(first: 1, query: $query) {
      nodes {
        handle
        metafield(namespace: "custom", key: "color_variant_products") {
          type
          value
          references(first: 10) {
            nodes {
              ... on Product {
                id
                handle
                title
              }
            }
          }
        }
      }
    }
  }
`;

// Storefront API: product() accepts handle: directly
const STOREFRONT_RAW_QUERY = `
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

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  const requestHeaders =
    request.headers.get("Access-Control-Request-Headers") ||
    "Content-Type, Accept";

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": requestHeaders,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

function getGraphqlDiagnosis(rawGraphql) {
  const graphqlErrors = rawGraphql?.responseBody?.errors;
  const missingMetafieldScope = graphqlErrors?.find(
    (error) => error?.extensions?.requiredAccess === "`unauthenticated_read_metafields` access scope.",
  );

  return {
    storefrontTokenPresent: !!rawGraphql?.tokenPresent,
    missingMetafieldScope: !!missingMetafieldScope,
    nextStep: missingMetafieldScope
      ? "Use a valid Storefront access token, ensure the metafield definition has `access.storefront = public_read`, and verify Headless channel Storefront API permissions. Shopify's current access-scope docs do not list `unauthenticated_read_metafields` as a requestable app scope."
      : null,
  };
}

async function createStorefrontTokenAndFetch(handle, shopOrigin) {
  const hostname = new URL(shopOrigin).hostname;
  const { admin } = await shopify.unauthenticated.admin(hostname);

  // Step 1: create a Storefront API token via Admin API mutation
  const tokenResponse = await admin.graphql(`#graphql
    mutation {
      storefrontAccessTokenCreate(input: { title: "chatbot-metafield-token" }) {
        storefrontAccessToken {
          accessToken
          accessScopes { handle }
        }
        userErrors { field message }
      }
    }
  `);
  const tokenData = await tokenResponse.json();
  const userErrors = tokenData?.data?.storefrontAccessTokenCreate?.userErrors ?? [];
  const tokenObj = tokenData?.data?.storefrontAccessTokenCreate?.storefrontAccessToken;

  if (!tokenObj?.accessToken) {
    return { step: "create_token", error: userErrors, raw: tokenData };
  }

  const scopes = tokenObj.accessScopes.map((s) => s.handle);
  const hasMetafieldScope = scopes.includes("unauthenticated_read_metafields");

  // Step 2: query Storefront API with the newly created token
  const endpoint = `https://${hostname}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const sfResponse = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Storefront-Access-Token": tokenObj.accessToken,
    },
    body: JSON.stringify({
      query: STOREFRONT_RAW_QUERY,
      variables: { handle },
    }),
  });
  const sfBody = await sfResponse.json();

  return {
    step: "storefront_query",
    tokenScopes: scopes,
    hasMetafieldScope,
    storefrontStatus: sfResponse.status,
    storefrontBody: sfBody,
  };
}

async function fetchRawAdminGraphql(handle, shopOrigin) {
  const hostname = new URL(shopOrigin).hostname;
  const { admin } = await shopify.unauthenticated.admin(hostname);
  const response = await admin.graphql(ADMIN_RAW_QUERY, {
    variables: { query: `handle:${handle}` },
  });
  const body = await response.json();
  return {
    shop: hostname,
    status: response.status,
    ok: response.ok,
    responseBody: body,
  };
}

async function fetchRawStorefrontGraphql(handle, shopOrigin) {
  const hostname = new URL(shopOrigin).hostname;
  const endpoint = `https://${hostname}/api/${STOREFRONT_API_VERSION}/graphql.json`;
  const storefrontToken = process.env.SHOPIFY_STOREFRONT_TOKEN || "";

  const requestBody = {
    query: STOREFRONT_RAW_QUERY,
    variables: { handle },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(storefrontToken
        ? { "X-Shopify-Storefront-Access-Token": storefrontToken }
        : {}),
    },
    body: JSON.stringify(requestBody),
  });

  const text = await response.text();
  let body;

  try {
    body = JSON.parse(text);
  } catch (parseError) {
    body = text;
  }

  return {
    endpoint,
    status: response.status,
    ok: response.ok,
    tokenPresent: !!storefrontToken,
    requestBody,
    responseBody: body,
  };
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request),
    });
  }

  console.log(`[recommendation-test] v${VERSION} Request received`);
  console.log("[recommendation-test] Fixed product handle:", FIXED_PRODUCT_HANDLE);
  console.log("[recommendation-test] Fixed shop origin:", FIXED_SHOP_ORIGIN);

  let products = [];
  let adminProducts = [];
  let adminError = null;
  let fetchError = null;
  let rawGraphql = null;
  let rawAdminGraphql = null;
  let dynamicTokenResult = null;

  // Approach 1: fetchRecommendedProductsAdmin — dynamic Storefront token via Admin API
  try {
    adminProducts = await fetchRecommendedProductsAdmin(FIXED_PRODUCT_HANDLE, FIXED_SHOP_ORIGIN);
    console.log(`[recommendation-test] fetchRecommendedProductsAdmin returned ${adminProducts.length} products`);
  } catch (err) {
    adminError = err instanceof Error ? err.message : String(err);
    console.error("[recommendation-test] fetchRecommendedProductsAdmin failed:", err);
  }

  // Approach 1 raw diagnostic — Admin API products(query:), needs read_products scope
  try {
    rawAdminGraphql = await fetchRawAdminGraphql(FIXED_PRODUCT_HANDLE, FIXED_SHOP_ORIGIN);
    console.log("[recommendation-test] raw Admin GraphQL status:", rawAdminGraphql.status);
  } catch (err) {
    rawAdminGraphql = { error: err instanceof Error ? err.message : String(err) };
    console.error("[recommendation-test] raw Admin GraphQL failed:", err);
  }

  // Approach 2: Create Storefront token via Admin API mutation, then query Storefront API
  try {
    dynamicTokenResult = await createStorefrontTokenAndFetch(FIXED_PRODUCT_HANDLE, FIXED_SHOP_ORIGIN);
    console.log("[recommendation-test] dynamic token approach step:", dynamicTokenResult.step);
  } catch (err) {
    dynamicTokenResult = { error: err instanceof Error ? err.message : String(err) };
    console.error("[recommendation-test] dynamic token approach failed:", err);
  }

  // Approach 3: Storefront API with SHOPIFY_STOREFRONT_TOKEN env var (if set)
  try {
    products = await fetchRecommendedProducts(FIXED_PRODUCT_HANDLE, FIXED_SHOP_ORIGIN);
    console.log(`[recommendation-test] fetchRecommendedProducts returned ${products.length} products`);
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
    console.error("[recommendation-test] fetchRecommendedProducts failed:", err);
  }

  try {
    rawGraphql = await fetchRawStorefrontGraphql(FIXED_PRODUCT_HANDLE, FIXED_SHOP_ORIGIN);
    console.log("[recommendation-test] raw Storefront GraphQL status:", rawGraphql.status);
  } catch (err) {
    rawGraphql = { error: err instanceof Error ? err.message : String(err) };
    console.error("[recommendation-test] raw Storefront GraphQL failed:", err);
  }

  const responseBody = {
    version: VERSION,
    fixedHandle: FIXED_PRODUCT_HANDLE,
    fixedShopOrigin: FIXED_SHOP_ORIGIN,
    // Primary result: dynamic Storefront token via Admin API
    adminProducts,
    adminError,
    // Raw diagnostic for the dynamic token approach
    dynamicToken: dynamicTokenResult,
    // Raw Admin API attempt (blocked by missing read_products scope)
    rawAdminGraphql,
    // Storefront API with env var token (needs SHOPIFY_STOREFRONT_TOKEN)
    storefrontProducts: products,
    storefrontError: fetchError,
    rawGraphql,
    diagnosis: getGraphqlDiagnosis(rawGraphql),
    debug: {
      note: "This route always uses the fixed handle and shop origin for easy testing.",
    },
  };

  return new Response(JSON.stringify(responseBody, null, 2), {
    status: fetchError ? 500 : 200,
    headers: {
      ...getCorsHeaders(request),
      "Content-Type": "application/json",
    },
  });
}
