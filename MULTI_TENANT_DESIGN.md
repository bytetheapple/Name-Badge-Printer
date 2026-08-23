# Multi-Tenant Design — Name Badge Kiosk (SaaS)

Blueprint for turning the single-congregation Name Badge Printer into a hosted,
multi-tenant product where each customer ("organization") gets an isolated admin
portal, their own users, and their own printers — with no access to any other
tenant's data.

> Status: **design draft** — no code changes yet. This is the plan to review
> before implementation.

---

## 1. Decisions locked in

| Decision | Choice | Why |
|---|---|---|
| **Isolation model** | **Pooled** — one app, one database, isolated by `org_id` + Row-Level Security (RLS) | Standard SaaS; real isolation from RLS; one deploy, one bill. Siloed (separate Supabase project per tenant) reserved as a future premium tier. |
| **Tenant routing** | **Path-based** for public (`/k/<kiosk_token>`), login + **org switcher** for admin | Zero infra/DNS work; identical in dev and prod; upgrade to branded subdomains later without a data-model change. |
| **Onboarding** | **Manual provisioning** to start | Operator creates each org; add self-serve signup later. |
| **Billing** | **Deferred** — schema hooks now, enforcement later | Get pilots running; wire Stripe once there are paying customers. |
| **Public endpoint security** | **Opaque per-printer kiosk tokens + rate limiting** | Prevents guessing/editing a URL to reach another tenant's printer; bounds abuse. |
| **Bridge auth** | **Per-bridge scoped tokens** via a bridge API (retire `service_role` on devices) | A device-resident `service_role` key would expose every tenant; also fixes a real weakness in the current single-tenant setup. |
| **Hardware** | Customer **buys the printer** (Amazon, a named model); we don't stock/resell. **We ship the Pi** (golden image + org bridge token). Pi in the wiring closet on Ethernet; printers on WiFi (multiple per Pi); Pi+printer colocation over USB as a per-site backup. | Avoids hardware margin/support burden; matches the proven current setup; clean lobby; multi-printer per Pi. |
| **Printer provisioning** | **Pi auto-config over a temporary Ethernet link** (drives the printer's web UI to set the four settings) + transcript capture; **guided web-UI wizard** fallback; **Wireless Direct** manual last resort. | One-time step on a mature UI; a firmware change only affects new provisions; captured transcripts make failures diagnosable. See §17. |

**What does _not_ change:** badge rendering (`badge.py`), the bridge's actual
printing path (`brother_ql`), the public sign-in UX, and the feature set
(pronouns, family sign-in, selfies, custom headers). This work is an isolation
and plumbing layer beneath the existing app.

---

## 2. Core concepts

- **Organization (tenant):** one customer (a congregation). The unit of
  isolation. Everything a customer owns carries its `org_id`.
- **Membership:** links a user to an organization with a **role**. A user may
  belong to more than one org (e.g. you, the operator, for support).
- **Kiosk token:** an opaque, unguessable identifier for one printer's public
  sign-in page. Encoded in the QR code. Resolves server-side to `(org_id,
  printer_id)`. Rotatable.
- **Bridge token:** an opaque credential installed on a Raspberry Pi print
  bridge. Scopes that bridge to one org (and optionally specific printers).
- **Platform admin (super-admin):** you/the operator. Cross-tenant access for
  provisioning and support, kept entirely separate from tenant roles.

---

## 3. Data model changes

### 3.1 New tables

```sql
-- A tenant.
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,          -- human-friendly, admin-facing (e.g. "beth-shalom")
  name        text not null,
  plan        text default 'pilot',          -- billing hook (unused for now)
  status      text default 'active',         -- active | suspended
  created_at  timestamptz default now()
);

-- Which users belong to which org, and as what.
create table memberships (
  org_id     uuid not null references organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id)    on delete cascade,
  role       text not null default 'staff',  -- owner | admin | staff
  created_at timestamptz default now(),
  primary key (org_id, user_id)
);
create index on memberships (user_id);

-- Platform operators (you). Deliberately NOT a tenant role.
create table platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
```

### 3.2 `org_id` on every tenant table

Add `org_id uuid not null references organizations(id)` (with an index) to:
`form_entries`, `print_jobs`, `printers`, `printer_config`, `printer_status`,
`app_settings`.

Two singletons become **per-org rows** instead of `id = 1`:
- `app_settings` → one row per org (selfie mode, pronouns toggle, Drive folder…).
- `printer_config` / `printer_status` → per org (badge template, label media,
  bridge heartbeat). Heartbeat/status may move to be **per bridge** (see §9).

### 3.3 Public tokens on printers

```sql
alter table printers add column kiosk_token text unique
  default encode(gen_random_bytes(16), 'hex');   -- opaque; used in the public QR URL
```

### 3.4 Bridge & API-key tables

```sql
create table bridge_tokens (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text,                                   -- "Lobby Pi"
  token_hash  text not null,                          -- store a hash, show the secret once
  printer_ids uuid[] ,                                -- null = all of this org's printers
  last_seen   timestamptz,
  created_at  timestamptz default now()
);

create table api_keys (                               -- external print API (per org)
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete cascade,
  name        text,
  key_hash    text not null,
  created_at  timestamptz default now()
);
```

---

## 4. Isolation & RLS

RLS is the enforcement layer for everything reached through the **authenticated**
Supabase client (the admin portal).

### 4.1 The membership helper

```sql
create or replace function auth_org_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select org_id from memberships where user_id = auth.uid()
$$;
```

### 4.2 The policy pattern (applied to every tenant table)

```sql
alter table form_entries enable row level security;

create policy "read own org" on form_entries
  for select using (org_id in (select auth_org_ids()));

create policy "write own org" on form_entries
  for insert with check (org_id in (select auth_org_ids()));

create policy "update own org" on form_entries
  for update using (org_id in (select auth_org_ids()))
             with check (org_id in (select auth_org_ids()));
```

Platform admins get an additional cross-org read policy guarded by
`exists (select 1 from platform_admins where user_id = auth.uid())`.

### 4.3 The critical caveat — `service_role` bypasses RLS

RLS does **not** protect code that uses the `service_role` key (Edge Functions,
the bridge). Every such path must **derive `org_id` from a trusted source and
scope every query by it manually**:

| Path | Trusted source of `org_id` |
|---|---|
| Admin portal (anon/authenticated client) | RLS via `auth.uid()` — automatic |
| Public sign-in Edge Functions | the **kiosk token** in the URL → `(org_id, printer_id)` |
| External print API | the **api key** → `org_id` |
| Print bridge | the **bridge token** → `org_id` (+ allowed printers) |

**Rule:** a client-supplied `org_id`/slug is never trusted for reads. The public
form's token scopes _writes into that org only_.

---

## 5. Authentication & roles

Supabase Auth already provides per-user accounts. Roles live in `memberships`:

| Role | Can |
|---|---|
| **owner** | Everything in the org: manage members, printers, settings, billing (later); delete the org. Created at provisioning. |
| **admin** | Manage printers, settings, entries, integrations; invite staff. Not billing/org-deletion. |
| **staff** | View entries, reprint, run kiosks, test-print. No settings/members. |

**Invite / authorize flow** (an owner/admin authorizing another user for *their*
org only): insert a pending `membership` for an email → invite email → invitee
signs up/accepts → membership activates. RLS guarantees an owner can only create
memberships for orgs they belong to.

**Optional optimization:** a Supabase custom-access-token hook can stamp the
user's `org_ids` into the JWT so Edge Functions read them from the verified token
instead of re-querying. Nice-to-have, not required for correctness.

---

## 6. Routing & URLs (path-based)

### 6.1 Admin portal

Authenticated. The tenant is derived from the logged-in user's membership, so the
URL does **not** need the tenant in it:

- `app.badgekiosk.com/admin` → loads the user's org(s); an **org switcher**
  (top-bar dropdown) handles anyone in more than one (mainly you).

### 6.2 Public sign-in (QR)

Unauthenticated → the tenant/printer **must** come from the URL, via the opaque
kiosk token (never a guessable slug):

- `app.badgekiosk.com/k/<kiosk_token>`

React Router reads `:token`; `public-config`/`submit-badge` resolve it to
`(org_id, printer_id)` server-side.

### 6.3 Upgrade path (later, no data-model change)

Because every org already has a `slug`, you can later add **subdomains**
(`beth-shalom.badgekiosk.com`) as a premium/branding option, or full **custom
domains** (`signin.bethshalom.org` via CNAME). The kiosk token remains the public
identifier regardless of host.

---

## 7. Public endpoint & kiosk-token security

The public sign-in page is intentionally open (anyone in the lobby can print) and
reachable from the internet (that's what lets a lobby phone queue a job for the
on-prem bridge). That openness must be contained — **independently of routing
shape** (subdomains have the identical exposure).

1. **Opaque tokens, not guessable names.** The QR encodes a random
   `kiosk_token`, not `?printer=lobby`. Nothing meaningful to hand-edit; you
   can't guess another tenant's token. Kills the "edit the path to hit another
   customer's printer" attack.
2. **Rate limiting** on the public submit endpoint — per token and per IP (e.g.
   N badges/minute), with a cooldown/CAPTCHA when tripped.
3. **Queue & submission caps** — max pending jobs per printer; hard max badges
   per submission (also bounds the family feature).
4. **Rotatable tokens** — a leaked/abused token is regenerated and the QR
   reprinted. Cheap recovery.
5. **Structural containment** — a bridge only ever pulls *its own org's* jobs, so
   the worst case is bounded to a single printer whose token an attacker holds;
   they can never reach a different printer or tenant. No token → no access.

Sketch of the rate-limit check (rolling window):

```sql
create table submit_events (
  kiosk_token text, ip text, at timestamptz default now()
);
-- reject if count(*) in the last minute for this token/ip exceeds a threshold
```

---

## 8. Public sign-in Edge Functions (org-aware)

- **`public-config`** — input: `kiosk_token`. Resolves org; returns that org's
  `selfie_mode`, `pronouns_enabled`, header/logo, etc.
- **`submit-badge`** — input: `kiosk_token` + form fields. Resolves
  `(org_id, printer_id)`; rate-limits; writes `form_entries` + `print_jobs`
  **stamped with `org_id`**; triggers that org's integrations (§11).
- **`job-status`** — unchanged shape, but only returns a job if it belongs to the
  same org as the token used to create it.

---

## 9. Print bridge redesign (per-bridge auth)

**Today:** the Pi runs `db.py` talking to PostgREST with the **`service_role`
key** and polls all `print_jobs`. Unacceptable in multi-tenant (one leaked device
key = every tenant exposed).

**New model:** the bridge holds only an opaque **bridge token** and talks to a
thin authenticated bridge API; `service_role` never leaves the server.

New Edge Functions (auth: `x-bridge-key` header → `bridge_tokens` row → org):

- **`bridge-poll`** → returns the next queued job for that bridge's org (and
  allowed printers), claiming it atomically. Also records `last_seen` (heartbeat)
  and accepts printer status.
- **`bridge-complete`** → marks a job `printed`/`failed` — only if the job
  belongs to the bridge's org.
- Custom-header fetches (`resolve_header`) continue to work against org-namespaced
  storage URLs (§10).

Bridge `.env` changes from `SUPABASE_URL` + `SERVICE_ROLE_KEY` to `SUPABASE_URL`
+ `BRIDGE_TOKEN`. Owners generate a token in the admin ("Add print server");
it's shown once and stored hashed.

This also hardens the current single-tenant deployment and is worth doing on its
own merits.

The bridge also gains three provisioning-related jobs — **mDNS printer
discovery**, **printer auto-configuration over Ethernet**, and a **health
check** — detailed in §17.

---

## 10. Storage

`badge-headers` objects become **org-namespaced**: path `‹org_id›/‹hash›.png`.
Storage RLS scopes read/write by membership; the bridge fetches via the public
URL (still fine — content-addressed, and now org-prefixed so nothing crosses
tenants). Per-org deletion becomes a prefix operation.

---

## 11. Per-tenant integrations & secrets

Today Google Sheets/Drive, ShulCloud, and selfie upload use **global** secrets.
Each org now configures **their own**:

- Google: their Sheet/Drive target + credentials. **Recommended tenant-friendly
  method is OAuth "Connect Google" with the least-privilege `drive.file` scope
  (Phase A5b — `docs/PHASE_A5B_GOOGLE_OAUTH.md`); the per-org service account is an
  advanced option, and the anonymous Form POST a no-credential option.**
- CRM (ShulCloud or other): their form endpoint/credentials.
- Selfie: their Drive folder.

**Secret storage:** move per-org credentials into **Supabase Vault** (or an
encrypted column with a KMS key) rather than plaintext env vars. Integration
config (which is enabled, targets) lives in a per-org `integrations` table; the
sync functions look up the calling org's config + secrets. This is a meaningful
chunk and easy to underestimate.

Orgs with no integration configured simply skip it (matches today's "skipped"
sync status).

---

## 12. Provisioning & onboarding (manual first)

Operator-run flow to stand up a new congregation:

1. Insert `organizations` (slug, name).
2. Invite the owner (Supabase Auth admin invite) → insert `membership(owner)`.
3. Seed default `app_settings` + `printer_config` rows for the org.
4. Create their first `printer` (generates a `kiosk_token`) and issue a
   `bridge_token`.
5. Hand off: QR (from the kiosk token), bridge token for their Pi, owner login.

Start as a **script or a small super-admin screen**; graduate to self-serve
signup later (self-serve just automates steps 1–5 behind a signup form + email
verification).

**Super-admin console:** a guarded area (visible only to `platform_admins`) to
list orgs, provision, impersonate-for-support (read-only), and later see billing.

---

## 13. Billing (deferred)

Leave hooks, don't build enforcement:
- `organizations.plan` / `.status` columns already present.
- Reserve a `stripe_customer_id` column when you start.
- Later: Stripe subscription per org; a webhook flips `status` to `suspended` on
  non-payment; suspended orgs' kiosks show a friendly "temporarily unavailable."
- Plan limits (printers, sign-ins/month) enforced in the org-aware Edge Functions.

---

## 14. Migrating the existing (single-tenant) deployment

Shir Hadash becomes **org #1** with zero data loss:

1. Run the schema migrations (new tables + `org_id` columns, nullable at first).
2. Insert the org; backfill every existing row's `org_id` to it; then set the
   columns `not null`.
3. Create owner membership(s) for the current admin user(s).
4. Generate `kiosk_token`s for existing printers; reprint QR codes to the `/k/…`
   form.
5. Issue a bridge token; update the Pi's `.env` and switch it to the bridge API;
   retire the `service_role` key from the device.
6. Migrate current integration secrets into the org's integration config/Vault.

---

## 15. Security checklist

- [ ] RLS enabled on **every** tenant table; policies scoped by `auth_org_ids()`.
- [ ] Every `service_role`/Edge path derives `org_id` from a trusted token, never
      from client input, and scopes every query by it.
- [ ] `service_role` removed from all Pi bridges; bridges use scoped tokens.
- [ ] Public endpoints: opaque kiosk tokens, rate limits, queue/submission caps,
      token rotation.
- [ ] Secrets in Vault, per org; no cross-org secret access.
- [ ] **Isolation test suite:** logged in as org A, assert zero rows of org B on
      every table and every function; a kiosk/bridge/api token for org A can
      never touch org B.
- [ ] Storage objects org-namespaced; storage RLS scoped by membership.

---

## 16. Phased roadmap

1. **Foundations** — org/membership tables, `org_id` everywhere, RLS rewrite,
   backfill Shir Hadash as org #1. *(App keeps working, now tenant-ready.)*
2. **Auth & admin UX** — roles, invite/authorize users, org switcher.
3. **Bridge re-auth** — bridge tokens + `bridge-poll`/`bridge-complete`; retire
   device `service_role`.
4. **Hardware provisioning** — bridge mDNS discovery + printer health check;
   printer auto-config over Ethernet (after printer recon, §17) with transcript
   capture; guided wizard fallback. *(Can be prototyped single-tenant in parallel.)*
5. **Public form & external API** — kiosk tokens, rate limiting, per-org API keys.
6. **Per-tenant integrations & secrets** — Vault, per-org Google/CRM/selfie config.
   - **A5b:** "Connect Google" OAuth (`drive.file`) as the tenant-friendly Google
     method — `docs/PHASE_A5B_GOOGLE_OAUTH.md`.
7. **Provisioning & super-admin** — manual provisioning tooling; cross-tenant ops.
8. **(Later)** self-serve signup, billing, subdomains/custom domains, dedicated
   silo tier.

Phases 1–5 give a safely-isolated product you could onboard a second congregation
onto; 6–8 make it a business.

---

## 17. Hardware & printer provisioning

### 17.1 Model

- **Customer buys the printer** (Brother QL-820NWB) from Amazon; we don't stock or
  resell it (avoids thin hardware margin and DOA/warranty support). We publish the
  exact model + a short parts list.
- **We ship the Raspberry Pi** — that's the appliance we control: golden SD image,
  bridge service, per-org bridge token. It lives in the **wiring closet on
  Ethernet** by default.
- **Printers run on WiFi** in the lobby, **multiple per Pi**. The printer's **RJ45
  jack is used only as a temporary provisioning cable**, not for runtime.
- **Per-site backup:** where the network is segmented or WiFi is unreliable,
  colocate the Pi and one printer and connect them by **USB**.

### 17.2 The four printer settings (all via the web UI)

A factory-fresh QL-820NWB needs exactly these set once:

1. **Forms mode → off** (use the raster/command mode the bridge prints with).
2. **WiFi → Infrastructure mode.**
3. **WiFi SSID + password.**
4. **Auto power-on after a power outage.**

Fragility is bounded: it's a **one-time** step on a **mature** product, and a
firmware change can only affect a *future* provision, never an already-configured
printer — so a broken field fails one setup, not the fleet.

### 17.3 Pi auto-config over Ethernet (primary path)

1. Customer plugs the new printer into **any Ethernet jack** (even beside the Pi)
   and powers it on.
2. Bridge **discovers** it (DHCP + mDNS) and reads **model + firmware + serial**.
3. Bridge **logs into the web UI** and pushes the four settings. The WiFi
   credentials are supplied **just-in-time** from the app → that org's bridge over
   the authenticated channel, used for the provisioning step and **not persisted
   in the cloud**.
4. Printer joins WiFi; bridge **verifies the WiFi interface is up and reachable**
   → the app shows **"✓ On WiFi — you can remove the Ethernet cable."**
5. Bridge runs a **health check + test print**; the printer is live.

**Implementation:** a bridge `configure_printer()` routine drives the web UI over
an HTTP session (Python `requests`). Exact form fields/endpoints come from a
one-time **recon** on a real unit (see `docs/PRINTER_RECON_CHECKLIST.md`).

**Diagnosability (build this alongside):** every attempt records a **provisioning
transcript** — detected model/firmware/serial and each request/response — with
the **WiFi password redacted**. It is retrievable over **Raspberry Pi Connect**
and uploaded as a **redacted provisioning report** to the super-admin console, so
failures (e.g. a new firmware revision) are debuggable without remoting in.
Firmware-keyed profiles absorb any field drift.

### 17.4 Fallbacks

- **Guided web-UI wizard:** the app walks the customer through the printer's own
  web page to set WiFi, then verifies + test-prints. Used automatically when
  auto-config can't complete.
- **Wireless Direct:** manual last resort (Brother app / laptop to the printer's
  own AP).

### 17.5 Bridge discovery & health check

- **mDNS discovery** resolves each printer by its stable Brother name, so DHCP IP
  changes never break printing (the exact failure seen at Shir Hadash) and "scan &
  add printer" needs no typed IPs.
- **Health check:** reachable, Forms-off/raster, right media, WiFi connected.

### 17.6 Raspberry Pi remote access & device registry

- **Raspberry Pi Connect** (operator account) for support — no per-customer SSH
  credentials stored.
- A **device registry** holds **metadata only** (hostname = org slug, Pi serial,
  Connect device name, last-seen), never credentials.

### 17.7 Pi appliance hardening

- **SD-card corruption resilience** — **read-only / overlay root filesystem**
  (`overlayroot`), so an abrupt power loss can't corrupt the card. *(A UPS was
  considered and rejected as not dependable enough.)*
- **Fleet software updates** — **pull-based self-update**: each bridge checks for
  and applies a new version on a schedule/at boot, so patches roll out without
  SSHing into every Pi.
- Official Pi PSU, NTP, `systemd Restart=always` (already in place).

### 17.8 Pre-install site-readiness checklist

- Pi (Ethernet) and printers (WiFi) share **one network segment** — mDNS + port
  9100 don't cross VLANs; watch guest-WiFi/VLAN splits. Fall back to USB
  colocation if segmented.
- An Ethernet jack is available **somewhere** for the provisioning step.
- Power available at the lobby printer station.

### 17.9 Near-term dependency

Building `configure_printer()` requires a **web-UI recon on a real printer**
(arriving shortly). Capture per `docs/PRINTER_RECON_CHECKLIST.md`, then implement.

---

## 18. Open questions / future

- **Subdomains / custom domains** — offer as branding upgrade once demand appears.
- **Dedicated silo tier** — a separate Supabase project for a customer needing
  physical isolation; premium pricing.
- **Regionality / data residency** — not a concern now; note for later.
- **Hardware fulfilment** — *decided:* we ship the Pi (pre-provisioned); the
  customer buys the printer (Amazon) and it is auto-configured on site (§17). Open
  sub-decisions live in §17.7 (SD resilience, fleet updates).
