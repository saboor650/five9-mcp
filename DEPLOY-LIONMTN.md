# Deploying the Lion Mountain fork

This fork of [ryanshatz/five9-mcp](https://github.com/ryanshatz/five9-mcp) lives on branch `lionmtn`.
One Worker serves one client domain; your Orchard Worker already has its Five9 secrets, so the
upgrade is a redeploy of the same Worker name.

## 1. Put the fork on GitHub (once)

```bash
cd five9-mcp
git remote add origin git@github.com:<your-org>/five9-mcp.git   # your fork
git push -u origin lionmtn
git push origin main                                             # keeps upstream history for later merges
```

Keep the repo **private**: `src/about.js` names Lion Mountain and the playbooks describe client designs.

## 2. Configure labels

In `wrangler.toml` (or the Cloudflare dashboard → Worker → Settings → Variables):

```toml
DOMAIN_LABEL = "Orchard Technologies Inc"
CLIENT_LABEL = "Orchard Technologies"
```

Secrets (`FIVE9_USERNAME`, `FIVE9_PASSWORD`, `MCP_AUTH_TOKEN`, optional REST keys) are unchanged —
do not re-enter them.

## 3. Test and deploy

```bash
npm test                # 37 tests, no Five9 access needed
npx wrangler deploy     # same Worker name = same URL, Cowork connector keeps working
```

Open `https://<worker>.workers.dev/` — the landing page should list **82 tools**.

## 4. First-run verification (read-only → harmless writes)

Do these in Cowork, in order. Each one exercises a code path that unit tests cannot
prove against a live domain.

1. `about` — confirm it says Orchard Technologies Inc / Lion Mountain.
2. `list_ivr_modules` on "Orchard Main IVR" — inventory should match the designer.
3. `patch_ivr_script` with `dry_run: true` and one `rename_module` op — review the change list.
4. `manage_web_connector modify` — verified live on 2026-09-03: trigger dispositions, URL, and POST
   fields all round-trip. One Five9 quirk: a connector with POST fields but **no URL variables**
   cannot be modified (Five9 rejects the POST fields as unknown call variables); the tool says so
   and accepts `variables: {"session_id": "Call.session_id"}` in the same call as the workaround.
   `wfa-last-agent-call-ended` is such a connector — add that URL variable once (the WFA webhook
   ignores query parameters) and it becomes API-editable.
5. `modify_vcc_configuration` with a value already in place, e.g.
   `{"miscOptions": {"voicemailTimeout": 20}}` — then `get_vcc_configuration`.
6. `find_calls` with `hours: 24, ani: "<your test phone>"`.
7. `bulk_create_users` with a two-row CSV and `dry_run: true` (default).

Only after 4 and 5 succeed should the write versions be used for real changes.

## 5. Keeping up with upstream

```bash
git fetch upstream            # upstream = https://github.com/ryanshatz/five9-mcp.git
git merge upstream/main       # resolve conflicts in tools.js / five9.js if any
npm test && npx wrangler deploy
```
