import { defineRailway, preserve, project, service, volume } from "railway/iac";

/*
 * Stock-out Watch on Railway (ADR 0012: one instance, own volume).
 * Region: Singapore, closest to India and to Performity. Static outbound IPs (Pro plan) are per
 * region, so the region is fixed before Performity allow-lists our IP.
 * Secrets are never written here: preserve() keeps the values set in the Railway dashboard.
 */
const REGION = "asia-southeast1-eqsg3a";

export default defineRailway(() => {
  const data = volume("web-volume", {
    region: REGION,
    sizeMB: 5000,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });
  const web = service("web", {
    replicas: { [REGION]: 1 },                 // exactly one: pulls must never run twice
    volumeMounts: { "/data": data },
    healthcheck: "/health",
    healthcheckTimeout: 60,
    /* Every variable the app reads (SECURITY.md, modules/stock-watch/.env.example) is preserve(): this file is
       omit=delete, so a variable set in the dashboard but missing here would be deleted by `railway config apply`
       (final critic r2 X1: the live Performity key and URL, and the webhooks). Add a new variable here before
       setting it in the dashboard. PORT, NODE_ENV and DATA_DIR come from the Dockerfile. */
    env: {
      ADMIN_PASSWORD: preserve(),
      VIEW_PASSWORD: preserve(),
      RAILWAY_RUN_UID: preserve(),
      KEEP_DAYS: preserve(),   // backups kept (SW-055)
      PERFORMITY_POC_API_URL: preserve(),
      PERFORMITY_POC_API_KEY: preserve(),
      PERFORMITY_BRAND_ID: preserve(),
      PERFORMITY_ORIGIN: preserve(),
      TOKEN_API_URL: preserve(),
      TOKEN_API_KEY: preserve(),
      SHOPIFY_STORE: preserve(),
      SHOPIFY_API_VERSION: preserve(),
      SHOPIFY_CLIENT_ID: preserve(),
      SHOPIFY_CLIENT_SECRET: preserve(),
      SHOPIFY_ACCESS_TOKEN: preserve(),
      AZURE_KEY_VAULT_URL: preserve(),
      AZURE_TENANT_ID: preserve(),
      AZURE_CLIENT_ID: preserve(),
      AZURE_CLIENT_SECRET: preserve(),
      ALERT_WEBHOOK_URL: preserve(),
      DIGEST_WEBHOOK_URL: preserve(),
      DIGEST_WEBHOOK_URL_CEO: preserve(),
      DIGEST_WEBHOOK_URL_FOUNDER: preserve(),
      DIGEST_WEBHOOK_URL_OPS: preserve(),
      DIGEST_WEBHOOK_URL_BUYER: preserve(),
      DIGEST_WEBHOOK_URL_MARKETING: preserve(),
      DIGEST_WEBHOOK_URL_FINANCE: preserve(),
      DIGEST_WEBHOOK_URL_WAREHOUSE: preserve(),
      PUBLIC_URL: preserve(),
      STOP_WAIT_MS: preserve(),
      SYNC_MINUTES: preserve(),
      YEAR_CALLS_PER_RUN: preserve(),   // 1.4.0: ShopifyQL reads per pull for the 12-month history
    },
  });
  return project("stock-watch", { resources: [web, data] });
});
