import { shopifyEnv, hasShopifyCredentials } from "../config.ts";
import type { Logger } from "../logger.ts";
import { sleep } from "../util.ts";

export class ShopifyError extends Error {
  retryable: boolean;
  constructor(msg: string, retryable = false) { super(msg); this.name = "ShopifyError"; this.retryable = retryable; }
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string; extensions?: { code?: string } }[];
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable: number; restoreRate: number } } };
}

/**
 * Minimal Admin GraphQL client. Auth, in order of preference:
 *  1. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET -> client-credentials grant (Dev Dashboard app installed
 *     on this store; token is short-lived, fetched per run, held in memory only, never logged or stored)
 *  2. SHOPIFY_ADMIN_ACCESS_TOKEN (an existing offline Admin API token)
 */
export class ShopifyClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private log: Logger;
  constructor(log: Logger) { this.log = log; }

  static available() { return hasShopifyCredentials(); }

  private async accessToken(): Promise<string> {
    if (shopifyEnv.clientId && shopifyEnv.clientSecret) {
      if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
      const res = await fetch(`https://${shopifyEnv.storeDomain}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: shopifyEnv.clientId, client_secret: shopifyEnv.clientSecret, grant_type: "client_credentials" }),
      });
      if (!res.ok) throw new ShopifyError(`Client-credentials token request failed: HTTP ${res.status}. Check that the app is installed on ${shopifyEnv.storeDomain} and the client ID/secret are correct.`);
      const j = (await res.json()) as { access_token: string; expires_in?: number; scope?: string };
      this.token = j.access_token;
      this.tokenExpiresAt = Date.now() + (j.expires_in ?? 86_400) * 1000;
      this.log.info("shopify", "obtained Admin API access token via client credentials", { scopes: j.scope });
      return this.token;
    }
    if (shopifyEnv.accessToken) return shopifyEnv.accessToken;
    throw new ShopifyError("No Shopify Admin API credentials configured (see README: Shopify authorization)");
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}, attempts = 5): Promise<T> {
    const url = `https://${shopifyEnv.storeDomain}/admin/api/${shopifyEnv.apiVersion}/graphql.json`;
    for (let i = 1; ; i++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await this.accessToken() },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        if (i >= attempts) throw e;
        await sleep(1000 * 2 ** i);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new ShopifyError(`Shopify rejected the credentials (HTTP ${res.status}). The app may be missing required scopes: write_products, read_products, write_inventory, read_inventory, read_locations.`);
      }
      if (res.status === 429 || res.status >= 500) {
        if (i >= attempts) throw new ShopifyError(`Shopify HTTP ${res.status} after ${attempts} attempts`, true);
        const wait = Number(res.headers.get("Retry-After") || 0) * 1000 || 1000 * 2 ** i;
        this.log.warn("shopify", `HTTP ${res.status}; retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      const body = (await res.json()) as GqlResponse<T>;
      const throttled = body.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled) {
        if (i >= attempts) throw new ShopifyError("Shopify GraphQL throttled", true);
        const st = body.extensions?.cost?.throttleStatus;
        const wait = st ? Math.ceil((200 / Math.max(st.restoreRate, 1)) * 1000) : 2000 * i;
        await sleep(wait);
        continue;
      }
      if (body.errors?.length) throw new ShopifyError(`GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
      const avail = body.extensions?.cost?.throttleStatus?.currentlyAvailable;
      if (avail != null && avail < 100) await sleep(1500); // stay well inside the bucket
      return body.data as T;
    }
  }
}
