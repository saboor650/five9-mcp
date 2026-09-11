// Five9 "New Platform" REST client — OAuth 2.0 client-credentials, bearer-token
// APIs (Enhanced Routing, Agent Sessions, …). Separate surface from the SOAP
// Configuration/Statistics Web Services in five9.js.
//
// Design goals: match five9.js — zero dependencies, stateless per request. A
// bearer token is fetched on demand and cached in-memory for the life of one
// client instance (i.e. one Worker request); cross-request caching (KV) is a
// deliberate future optimization, not needed for correctness.
//
// Docs: https://documentation.five9.com/bundle/api-docs (Getting Started).
//   Auth:  POST https://{baseUrl}/oauth2/v1/token  (grant_type=client_credentials,
//          Consumer Key/Secret as HTTP Basic) -> { access_token, expires_in, … }
//          (Five9's getting-started doc says /v1/auth/token, but the live
//           endpoint is /oauth2/v1/token — verified against a real domain.)
//   Calls: Authorization: Bearer {token}
//   Rate limits: 5 req/s/user, 5 parallel users; 429 -> honor Retry-After then
//                exponential backoff (1s,2s,4s,8s); 5xx -> backoff, ≤5 retries.
//   Concurrency: ETag on reads, If-Match on writes -> 412 Precondition Failed.

import { Five9Error } from './five9.js';

// A REST error that the MCP layer surfaces gracefully (extends Five9Error so
// index.js's `e instanceof Five9Error` catch turns it into an isError result).
export class Five9RestError extends Five9Error {}

// Region -> API base URL. See "Getting Started with Five9 New Platform APIs".
export const REGION_BASE_URLS = {
  US: 'https://api.prod.us.five9.net',
  'US-ALPHA': 'https://api.alpha.us.five9.net',
  CA: 'https://api.prod.ca.five9.net',
  EU: 'https://api.prod.eu.five9.net',
  IN: 'https://api.prod.in.five9.net',
  UK: 'https://api.prod.uk.five9.net',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Backoff schedule for 429/5xx retries: 1s, 2s, 4s, 8s, 8s…
const backoffMs = (attempt) => [1000, 2000, 4000, 8000][Math.min(attempt, 3)];

// Only ever send the bearer token to Five9's own hosts. `base_url` is a
// caller-supplied override (and rest_call is reachable by the connected AI),
// so an unrestricted host would let a prompt-injected call exfiltrate a live
// Five9 access token to an attacker-controlled server. Allow https to
// *.five9.net / *.five9.com only.
export function assertFive9Host(base) {
  let host;
  try { host = new URL(base).hostname.toLowerCase(); } catch {
    throw new Five9RestError(`Invalid base URL: ${base}`);
  }
  if (!/^https:/i.test(base)) {
    throw new Five9RestError(`Refusing to send a Five9 token over non-HTTPS URL: ${base}`);
  }
  if (host !== 'five9.net' && host !== 'five9.com' && !host.endsWith('.five9.net') && !host.endsWith('.five9.com')) {
    throw new Five9RestError(`Refusing to send a Five9 token to non-Five9 host "${host}". base_url must be a *.five9.net / *.five9.com endpoint.`);
  }
}

export class Five9RestClient {
  // cfg: { restCredentials: { <name>: {key, secret} }, restConsumerKey,
  //        restConsumerSecret, restDomainId, restRegion, restBaseUrl } — see
  //        config.js. Supports multiple named credentials (different API
  //        families), e.g. 'default' (all-apis-access) and 'data-tables'.
  constructor(cfg) {
    this.credentials = { ...(cfg?.restCredentials || {}) };
    if (!this.credentials.default && cfg?.restConsumerKey) {
      this.credentials.default = { key: cfg.restConsumerKey, secret: cfg.restConsumerSecret };
    }
    this.domainId = cfg?.restDomainId || '';
    // Every New Platform path is /<svc>/v1/domains/{domainId}/... . When
    // FIVE9_DOMAIN_ID is not configured the placeholder used to expand to the
    // empty string, producing /campaigns/v1/domains//campaigns — which a few
    // services tolerate and most answer with a bare 404, so the failure looked
    // like "that endpoint does not exist" rather than "the domain is missing"
    // (cost an afternoon on Orchard 143050, 9/11/2026). Resolve it lazily
    // instead: callers hand us a resolver (SOAP getVCCConfiguration), and an
    // unresolvable domain is a loud error, never an empty path segment.
    this._domainIdResolver = typeof cfg?.domainIdResolver === 'function' ? cfg.domainIdResolver : null;
    this._domainIdPromise = null;
    this.region = (cfg?.restRegion || 'US').toUpperCase();
    this.baseUrl = (cfg?.restBaseUrl || REGION_BASE_URLS[this.region] || REGION_BASE_URLS.US).replace(/\/+$/, '');
    this.maxRetries = 5;
    this._tokens = {}; // credentialName -> { token, expiry }
  }

  // OAuth 2.0 client-credentials grant for a named credential (default
  // 'default'). Cached per credential until ~30s before expiry.
  async getToken(credentialName = 'default') {
    const cred = this.credentials[credentialName];
    if (!cred?.key || !cred?.secret) {
      throw new Five9RestError(
        credentialName === 'default'
          ? 'No New Platform credential configured — set FIVE9_CONSUMER_KEY / FIVE9_CONSUMER_SECRET (and FIVE9_DOMAIN_ID, FIVE9_REST_REGION). Generate them under Admin Console > API Access Control.'
          : `No '${credentialName}' New Platform credential configured — set its consumer key/secret (e.g. FIVE9_DT_CONSUMER_KEY / FIVE9_DT_CONSUMER_SECRET for data-tables).`
      );
    }
    const cached = this._tokens[credentialName];
    if (cached && Date.now() < cached.expiry) return cached.token;
    const res = await fetch(`${this.baseUrl}/oauth2/v1/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + btoa(`${cred.key}:${cred.secret}`),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Five9RestError(`Five9 token request failed for '${credentialName}' (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Five9RestError(`Five9 token response was not JSON: ${text.slice(0, 200)}`);
    }
    if (!data.access_token) {
      throw new Five9RestError(`Five9 token response had no access_token: ${text.slice(0, 200)}`);
    }
    const ttl = Number(data.expires_in) || 3600;
    this._tokens[credentialName] = { token: data.access_token, expiry: Date.now() + Math.max(30, ttl - 30) * 1000 };
    return data.access_token;
  }

  // Which credential names are configured.
  credentialNames() { return Object.keys(this.credentials).filter((n) => this.credentials[n]?.key); }

  // The domain id, from config or (once, cached) from the resolver.
  async getDomainId() {
    if (this.domainId) return this.domainId;
    if (!this._domainIdResolver) {
      throw new Five9RestError(
        'No Five9 domain id available for a New Platform path containing {domainId}. '
        + 'Set FIVE9_DOMAIN_ID (Admin Console > API Access Control shows it in the endpoint URLs), '
        + 'or call through callTool() so the SOAP fallback resolver is attached.'
      );
    }
    if (!this._domainIdPromise) {
      this._domainIdPromise = Promise.resolve()
        .then(() => this._domainIdResolver())
        .then((id) => {
          const v = String(id ?? '').trim();
          if (!v) throw new Five9RestError('Domain id lookup returned nothing — set FIVE9_DOMAIN_ID explicitly.');
          this.domainId = v;
          return v;
        })
        .catch((e) => { this._domainIdPromise = null; throw e; });
    }
    return this._domainIdPromise;
  }

  // Substitute path placeholders and normalize to a leading slash.
  async _resolvePath(path) {
    let p = String(path || '');
    if (p.includes('{domainId}')) {
      p = p.replace(/\{domainId\}/g, encodeURIComponent(await this.getDomainId()));
    }
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }

  // Authenticated REST call with rate-limit / retry handling. Returns
  // { status, etag, data } where data is parsed JSON (or text, or null).
  async request(method, path, { query, body, ifMatch, headers, credential = 'default', baseUrl } = {}) {
    const base = (baseUrl || this.baseUrl).replace(/\/+$/, '');
    assertFive9Host(base); // fail before any token is fetched or sent
    const token = await this.getToken(credential);
    let url = base + (await this._resolvePath(path));
    if (query && Object.keys(query).length) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    const h = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(headers || {}) };
    let payload;
    if (body !== undefined && body !== null) {
      h['Content-Type'] = 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    if (ifMatch) h['If-Match'] = ifMatch;

    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { method: (method || 'GET').toUpperCase(), headers: h, body: payload });
      // 429: honor Retry-After (seconds) if present, else backoff.
      if (res.status === 429 && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('Retry-After'));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs(attempt));
        continue;
      }
      // 5xx: transient — retry with backoff.
      if (res.status >= 500 && res.status < 600 && attempt < this.maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      return this._parse(res, method, url);
    }
  }

  async _parse(res, method, url) {
    const etag = res.headers.get('ETag') || undefined;
    const text = await res.text();
    if (res.status === 412) {
      throw new Five9RestError(`Five9 REST 412 Precondition Failed on ${method} ${url} — the resource changed since your ETag; re-read it and retry with the new If-Match.`);
    }
    if (!res.ok) {
      throw new Five9RestError(`Five9 REST HTTP ${res.status} on ${method} ${url}: ${text.slice(0, 400)}`);
    }
    let data = null;
    if (text) {
      const ct = res.headers.get('Content-Type') || '';
      if (ct.includes('json')) {
        try { data = JSON.parse(text); } catch { data = text; }
      } else {
        data = text;
      }
    }
    return { status: res.status, etag, data };
  }

  // Acquire a token and report connection metadata (no business call).
  async checkConnection(credential = 'default') {
    await this.getToken(credential);
    let domainId = null;
    let domainIdError;
    try { domainId = await this.getDomainId(); } catch (e) { domainIdError = e.message; }
    return {
      ok: true,
      baseUrl: this.baseUrl,
      region: this.region,
      domainId,
      ...(domainIdError ? { domainIdError } : {}),
      credential,
      configuredCredentials: this.credentialNames(),
      tokenType: 'Bearer',
      note: 'OAuth client-credentials token acquired successfully. This verifies API Access Control is enabled and the Consumer Key/Secret are valid.',
    };
  }

  // ---- Typed New Platform endpoints (paths verified against a live domain) ----

  // Cursor-paged GET. Returns { items, count, nextCursor } — pass nextCursor
  // back as `cursor` to fetch the following page. `credential` selects the API
  // family credential (default 'default').
  async listPaged(path, { cursor, limit, credential } = {}) {
    const query = {};
    if (limit) query.pageLimit = String(limit);
    if (cursor) query.pageCursor = cursor;
    const { data } = await this.request('GET', path, { query, credential });
    const items = Array.isArray(data?.items) ? data.items : [];
    let nextCursor = null;
    const next = data?.paging?.next;
    if (next) { const m = /[?&]pageCursor=([^&]+)/.exec(next); nextCursor = m ? decodeURIComponent(m[1]) : null; }
    return { items, count: items.length, nextCursor };
  }

  // Circles — list / get / create / delete. No SOAP equivalent.
  listCircles(opts) { return this.listPaged('/circles/v1/domains/{domainId}/circles', opts); }
  async getCircle(id) {
    if (!id) throw new Five9RestError('circle_id is required.');
    const { data } = await this.request('GET', `/circles/v1/domains/{domainId}/circles/${encodeURIComponent(id)}`);
    return data;
  }
  async createCircle(fields) {
    if (!fields?.name) throw new Five9RestError('name is required.');
    const { data } = await this.request('POST', '/circles/v1/domains/{domainId}/circles', { body: fields });
    return { ok: true, created: fields.name, id: data?.id ?? null, circle: data };
  }
  async deleteCircle(id) {
    if (!id) throw new Five9RestError('circle_id is required.');
    await this.request('DELETE', `/circles/v1/domains/{domainId}/circles/${encodeURIComponent(id)}`);
    return { ok: true, deleted: id };
  }

  // Phone numbers (read). The raw records are ~120 lines each; callers almost
  // always want the summary, so fold them here rather than in the tool layer.
  async listPhoneNumbers({ cursor, limit, sms_enabled, unassigned, area_code, search } = {}) {
    const page = await this.listPaged('/numbers/v1/domains/{domainId}/phone-numbers', { cursor, limit: limit || 100 });
    let items = page.items || [];
    if (sms_enabled === true) items = items.filter((n) => n?.sms?.enabled === true);
    if (sms_enabled === false) items = items.filter((n) => n?.sms?.enabled !== true);
    if (unassigned === true) items = items.filter((n) => !n?.assigneeName);
    if (unassigned === false) items = items.filter((n) => !!n?.assigneeName);
    if (area_code) items = items.filter((n) => n?.geoData?.areaCode === String(area_code));
    if (search) {
      const q = String(search).replace(/\D/g, '');
      if (q) items = items.filter((n) => String(n?.number || '').includes(q));
    }
    const numbers = items.map((n) => ({
      number: n.number,
      areaCode: n?.geoData?.areaCode ?? null,
      city: (n?.geoData?.cities || [])[0] ?? null,
      state: n?.geoData?.state ?? null,
      assignedTo: n.assigneeName ?? null,
      voice: n?.voice?.enabled === true,
      sms: n?.sms?.enabled === true,
      smsDirection: n?.sms?.direction ?? null,
      smsProvider: n?.sms?.provider?.providerId ?? null,
      smsProviderStatus: n?.sms?.provider?.status ?? null,
      mms: n?.sms?.mms?.enabled === true,
      campaignRegistryId: n?.sms?.campaignRegistry?.campaignRegistryId ?? null,
      dnisId: n.dnisId ?? null,
      comment: n.comment || undefined,
    }));
    return { numbers, count: numbers.length, nextCursor: page.nextCursor };
  }

  // One campaign with the digital fields the SOAP campaign object omits.
  // NOTE: the LIST endpoint does not return them — you must GET by id.
  async getCampaignDigital(campaignId) {
    if (!campaignId) throw new Five9RestError('campaign_id is required.');
    const { data, etag } = await this.request('GET', `/campaigns/v1/domains/{domainId}/campaigns/${encodeURIComponent(campaignId)}`);
    return {
      campaignId: data?.campaignId,
      name: data?.name,
      type: data?.type,
      state: data?.state,
      timezone: data?.timezone ?? null,
      maxNumVoiceLines: data?.maxNumVoiceLines ?? null,
      maxNumTextInteractions: data?.maxNumTextInteractions ?? null,
      maxNumVivrSessions: data?.maxNumVivrSessions ?? null,
      smsReady: Number(data?.maxNumTextInteractions || 0) > 0,
      skills: (data?.skills || []).map((s) => s.skillId),
      dnises: (data?.dnises || []).map((d) => d.uri?.split('/').pop() || d.numberId),
      defaultScriptId: data?.defaultScript?.ewScriptId ?? null,
      etag,
      note: 'Chat Profile and Digital Skill are not exposed by this API (or by SOAP) - Admin Console only. Do not PUT this endpoint: it ignores dnises and silently drops skills.',
    };
  }

  // New Platform voice prompts (read).
  listNpPrompts(opts) { return this.listPaged('/prompts/v1/domains/{domainId}/prompts', opts); }

  // Interaction dispositions (read-only via this API; richer than SOAP).
  listDispositions(opts) { return this.listPaged('/interactions/v1/domains/{domainId}/dispositions', opts); }
  async getDisposition(id) {
    if (!id) throw new Five9RestError('disposition_id is required.');
    const { data } = await this.request('GET', `/interactions/v1/domains/{domainId}/dispositions/${encodeURIComponent(id)}`);
    return data;
  }

  // Domain metadata (id, name, tenant, service endpoints).
  async getDomainInfo() {
    const { data } = await this.request('GET', '/domains/v1/domains/{domainId}');
    return data;
  }

  // Data Tables — structured lookup tables (uses the 'data-tables' credential).
  listDataTables(opts = {}) {
    return this.listPaged('/data-tables/v1/domains/{domainId}/data-tables', { ...opts, credential: 'data-tables' });
  }
  getDataTableRows(tableId, opts = {}) {
    if (!tableId) throw new Five9RestError('table_id is required.');
    return this.listPaged(`/data-tables/v1/domains/{domainId}/data-tables/${encodeURIComponent(tableId)}/data`, { ...opts, credential: 'data-tables' });
  }
}
