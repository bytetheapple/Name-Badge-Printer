# Phase A5b — "Connect Google" (OAuth) for per-tenant Sheets/Drive

A follow-on to A5 that adds a **click-to-connect Google account** option, so a
non-technical tenant can sync sign-ins to a Google Sheet (and upload selfies to
Drive) **without creating a service account**. The A5 service-account path stays
as an "advanced" option.

> Builds directly on A5 (`supabase/migrations/20260823120000_mt_a5_integrations.sql`,
> `supabase/functions/_shared/integration.ts`, `Integrations.tsx`). Read A5 first.

---

## 1. Why

- **A5 today** stores per-org Google credentials in Vault, but the only Google
  *Drive* credential it accepts is a **service-account key** (`kind='google_drive'`,
  secret = PEM, `config.sa_client_email`) — fine for a developer, far too
  technical for a synagogue admin. Sheet sync is a separate `kind='google_form'`
  (an anonymous Form `formResponse` POST that requires the admin to build a Form).
- **A5b** lets the admin click **"Connect Google,"** approve once, and the app
  creates a "Sign-ins" Sheet in *their* Drive and appends rows — no service
  account, no key file, no manual sharing, no Form-building.

Two structural wins:
- **Least-privilege scope `drive.file`** — the app can only touch files it
  creates. This is a *non-sensitive* scope, so it **avoids Google's restricted-scope
  security assessment (CASA)** that full Sheets/Drive scopes trigger — important
  for a small vendor.
- Files land in the **customer's own Drive on their quota**, which **removes the
  Shared-Drive workaround** A5's service account needs (service accounts have zero
  storage).

---

## 2. What A5b reuses vs. adds

**Reuses unchanged:**
- `integration_for(org, kind)` RPC and `resolveSettings()` / `integrationFor()`
  (`_shared/integration.ts`) — they already carry `{enabled, config, secret}`; the
  `secret` becomes an OAuth **refresh token** instead of a PEM, no change needed.
- The write-only Vault pattern (`set_integration_secret` / `integration_has_secret`)
  and the env-fallback rule (single-org only).
- The `oauth2.googleapis.com/token` fetch shape already in
  `upload-selfie/getAccessToken` — swap `grant_type=jwt-bearer` for
  `grant_type=refresh_token`.

**Adds (greenfield — the app has no browser-redirect OAuth today):**
- A platform Google OAuth client + consent screen (one-time).
- An authorization-code + PKCE flow: a **begin** Edge Function and a **callback**
  Edge Function.
- A new integration `kind='google_oauth'`, a short-lived `oauth_pending` table,
  and a service-role RPC to finalize the connection.
- A "Connect / Disconnect Google" control in `Integrations.tsx`.

---

## 3. Data model delta (A5b migration)

```sql
-- 1. New integration kind for an OAuth-connected Google account.
alter table public.integrations drop constraint integrations_kind_check;
alter table public.integrations add constraint integrations_kind_check
  check (kind in ('google_form','shulcloud','google_drive','google_oauth'));

-- 2. Short-lived PKCE/state store for the auth-code flow.
create table public.oauth_pending (
  state         text primary key,
  org_id        uuid not null references public.organizations(id) on delete cascade,
  code_verifier text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '10 minutes'
);
alter table public.oauth_pending enable row level security;   -- no policies
revoke all on public.oauth_pending from anon, authenticated;  -- browser gets nothing; service_role bypasses RLS

-- 3. Finalize helper (service_role only): store the refresh token + connected email.
--    Runs from the callback, which has no auth.uid(), so it CANNOT use the
--    admin-checked set_integration_secret; the org is trusted because it came
--    from a validated oauth_pending row created by a verified admin.
create or replace function public.complete_google_oauth(
  p_org uuid, p_refresh_token text, p_email text
) returns void
language plpgsql security definer set search_path = public, vault as $$
declare v_secret uuid;
begin
  insert into public.integrations (org_id, kind, enabled, config)
    values (p_org, 'google_oauth', true, jsonb_build_object('connected_email', p_email))
    on conflict (org_id, kind) do update
      set enabled = true,
          config  = public.integrations.config
                    || jsonb_build_object('connected_email', p_email),
          updated_at = now()
    returning secret_id into v_secret;
  if v_secret is null then
    update public.integrations
      set secret_id = vault.create_secret(p_refresh_token, 'org:'||p_org||':google_oauth', 'oauth refresh token')
      where org_id = p_org and kind = 'google_oauth';
  else
    perform vault.update_secret(v_secret, p_refresh_token);
  end if;
end $$;
revoke all on function public.complete_google_oauth(uuid, text, text) from public;
grant execute on function public.complete_google_oauth(uuid, text, text) to service_role;
```

`config` for `google_oauth` holds non-secret state: `connected_email`,
`sheet_id` (the app-created Sheet, set on first sync), `drive_folder_id` (optional,
for selfies), `scopes`. Column grants inherit A5's row (browser never sees
`secret_id`).

---

## 4. OAuth flow (two new Edge Functions)

Platform-level config (Edge Function env, **not** per-org):
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`
(= the callback function URL). Scopes: `openid email
https://www.googleapis.com/auth/drive.file`.

**`google-oauth-begin`** (auth: the admin's user JWT)
1. Verify the caller is an **owner/admin of `org_id`** (query `memberships` with
   service_role, or reuse `auth_is_org_admin` via the user's token).
2. Generate `state` (random) + `code_verifier` (random) + `code_challenge` =
   base64url(sha256(verifier)); insert into `oauth_pending`.
3. Return (or 302 to) the Google authorize URL:
   `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=…&
   response_type=code&scope=…&access_type=offline&prompt=consent&
   code_challenge=…&code_challenge_method=S256&state=…`
   (`access_type=offline` + `prompt=consent` guarantee a **refresh token**.)

**`google-oauth-callback`** (public redirect target — the first non-JSON,
redirect-handling Edge Function in the app)
1. Read `code` + `state`; look up `oauth_pending` (reject if missing/expired) →
   trusted `org_id` + `code_verifier`. **Org comes from the stored state, never
   from the client** (multi-tenant trusted-org rule).
2. Exchange at `oauth2.googleapis.com/token`
   (`grant_type=authorization_code`, `code`, `code_verifier`, client id/secret,
   redirect_uri) → `refresh_token` + `id_token` (for the connected email).
3. `complete_google_oauth(org, refresh_token, email)`; delete the pending row.
4. **302 back** to `…/settings?connected=google` (success) or `?google_error=…`.

---

## 5. Sync-function changes (precedence)

Add an OAuth access-token helper (e.g. `_shared/google.ts` `oauthAccessToken(refreshToken)`
→ `grant_type=refresh_token`), reusing upload-selfie's token fetch.

- **`google-sync` (sheet sync):** if the org has an **enabled `google_oauth`**
  integration, write rows via the **Sheets API** — create the "Name Badge
  Sign-ins" spreadsheet on first use (store `sheet_id` in config),
  `spreadsheets.values.append` thereafter. Otherwise keep today's `google_form`
  POST. *(drive.file lets the app read/write a spreadsheet it created.)*
- **`upload-selfie`:** if `google_oauth` enabled, get an access token via the
  refresh token and upload to the **user's Drive** (no `supportsAllDrives`/Shared
  Drive needed). Otherwise keep the `google_drive` service-account path.
- **Precedence:** `google_oauth` (if enabled) → legacy `google_form`/`google_drive`
  → env fallback (single-org). Fully backward-compatible: Shir Hadash keeps its
  current setup until it chooses to connect via OAuth.

---

## 6. UI (`Integrations.tsx`)

- Add an `oauth` flavor to the `Spec`/render. The Google card shows:
  - **Not connected:** a **"Connect Google"** button → calls `google-oauth-begin`
    and redirects to Google.
  - **Connected:** the `connected_email`, a note of what it powers (**sheet sync +
    selfies**), an enable toggle, and **"Disconnect"** (deletes the integration →
    A5's delete trigger purges the Vault secret).
  - On return, read `?connected=google` and refresh state.
- Keep the **service-account** fields (email + PEM textarea) behind an
  **"Advanced"** disclosure for orgs that prefer A5's method.

---

## 7. Google Cloud setup (one-time, platform)

- OAuth **consent screen**: app name, support email, authorized domain, scopes
  (`openid`, `email`, `drive.file`). **Publish to production** — in "Testing,"
  refresh tokens expire after 7 days and only whitelisted users can connect.
- With only non-sensitive scopes, verification is light (brand/domain), but an
  "unverified app" screen shows until verified, with a ~100-user cap — fine for
  pilots; **verify before scaling**. *(Confirm current Google requirements at
  build time — they change.)*
- Create an **OAuth client (Web application)**; set the redirect URI to the
  `google-oauth-callback` function URL.

---

## 8. Security

- **Trusted org from state:** the callback derives `org_id` from `oauth_pending`,
  never from the request — same rule as kiosk/bridge tokens.
- **Admin-gated begin:** only an org owner/admin can start a connect.
- **Refresh token is write-only** in Vault (reuse A5); never returned to the
  browser; `complete_google_oauth` is service-role-only.
- **PKCE + state** protect the code exchange and bind it to the initiating org.
- **Revocation handling:** on `invalid_grant` when refreshing, mark the
  integration `enabled=false` and surface "Reconnect Google" in the UI.
- `oauth_pending` rows expire (10 min); a periodic cleanup (or opportunistic
  delete) removes stragglers.

---

## 9. Apply steps (when built)

1. Create the platform Google OAuth client + consent screen (§7); set the three
   `GOOGLE_OAUTH_*` env vars on the Edge Functions.
2. Apply the A5b migration (SQL editor) — kind constraint, `oauth_pending`,
   `complete_google_oauth`.
3. `supabase functions deploy google-oauth-begin google-oauth-callback google-sync upload-selfie`.
4. Deploy the app (Vercel) — Settings → Integrations gains "Connect Google."
5. Re-run `isolation_test.sql` / `roles_test.sql`; add an OAuth-path check to the
   integration tests.

---

## 10. Testing

- **Isolation:** a `google_oauth` connection and its Vault secret for org A are
  invisible/untouchable by org B; the callback can only ever write to the org in
  its `oauth_pending` row.
- **Happy path:** connect → app creates the Sheet in the tester's Drive → a
  sign-in appends a row; a selfie lands in their Drive on their quota.
- **Revocation:** revoke access in the Google account → next sync flips to
  disabled and the UI prompts reconnect.

---

## 11. Not in A5b

- Google Sheets **read/import**, choosing an existing sheet via the Google Picker
  (a nice later add — `drive.file` supports Picker-granted files), calendar/other
  Google products, and non-Google destinations (webhook/Zapier). The **Form POST**
  and **service-account** methods remain available.
