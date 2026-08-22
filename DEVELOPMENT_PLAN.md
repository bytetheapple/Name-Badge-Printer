# Development Plan — Multi-Tenant Name Badge Kiosk

Sequenced build plan to evolve the single-congregation app into the multi-tenant
SaaS described in [MULTI_TENANT_DESIGN.md](MULTI_TENANT_DESIGN.md). Read that doc
for the architecture; this is the order of work.

## Principles

- **Production stays live.** Shir Hadash keeps working throughout. Do the refactor
  on a **branch**; use **additive migrations** (add nullable → backfill →
  constrain); verify each phase before the next.
- **Two parallel tracks.** Track A (multi-tenant platform) and Track B (printer
  auto-config) are largely independent; B is gated only on a printer recon.
- **One phase at a time.** Build → lint/type-check → isolation tests → preview →
  commit per phase → check in before moving on.

## Track B — Printer auto-config *(starts when a real printer is on hand)*

- **B0 — Recon (operator):** capture the printer web UI per
  [docs/PRINTER_RECON_CHECKLIST.md](docs/PRINTER_RECON_CHECKLIST.md).
- **B1 — `configure_printer()`:** bridge routine that logs into the web UI and
  sets the four settings (Forms-off, WiFi Infrastructure, SSID/password, auto
  power-on), with **transcript capture + firmware detection**; validated on the
  real unit.
- **B2 — Discovery & health:** mDNS discovery, "scan & add printer," and the
  **WiFi-reachability "safe to unplug"** signal.
- **B3 — Fallbacks:** guided web-UI wizard in the admin + Wireless Direct docs.

Buildable/proven single-tenant now; carries into multi-tenant unchanged.

## Track A — Multi-tenant platform *(phased)*

- **A1 — Foundations:** `organizations` / `memberships` / `platform_admins`;
  `org_id` on every table; `auth_org_ids()` + RLS rewrite; backfill Shir Hadash as
  org #1; **isolation test suite**. *Checkpoint: app works, isolation enforced.*
- **A2 — Auth & admin UX:** roles (owner/admin/staff), org switcher,
  invite/authorize users.
- **A3 — Bridge re-auth:** `bridge_tokens` + `bridge-poll`/`bridge-complete`;
  retire `service_role` on the Pi.
- **A4 — Public form & external API:** kiosk tokens (+ QR), rate limiting/caps,
  per-org API keys. *(First step that needs the product domain — see below.)*
- **A5 — Integrations & secrets:** Vault; per-org Google/CRM/selfie config.
- **A6 — Provisioning & super-admin:** manual provisioning tool, device registry,
  cross-tenant support view.
- **A7 — (later):** self-serve signup, billing, subdomains/custom domains.

## Milestones

- **M1 — "Second tenant ready":** A1–A4 + B1–B2 → onboard another congregation
  with an isolated portal and an auto-configured printer.
- **M2 — "Turnkey onboarding":** A5–A6 + B3.
- **M3 — "A business":** A7.

## Sequencing

- **Start with A1 (foundations)** on a branch — highest leverage, unblocks
  everything, low user-facing risk.
- **In parallel:** operator runs B0 recon when the printer lands; then B1.
- **Bridge coordination:** land the **A3 bridge API first**, then build B1/B2 on
  top of it so the bridge isn't refactored twice.

## Settled decisions (see MULTI_TENANT_DESIGN.md §1, §17)

Pooled + RLS · path-based routing · manual provisioning · billing deferred ·
opaque kiosk tokens + rate limiting · per-bridge scoped tokens · BYO printer
(Amazon) / we ship the Pi · printer auto-config over temporary Ethernet + wizard
fallback · **read-only overlay root** · **pull-based bridge self-update** ·
refactor on a **branch**.

## Product domain (needed by A4, not before)

The SaaS needs its own registered domain — distinct from the Shir Hadash
deployment — for:
- the **kiosk QR URLs** printed for the lobby (`app.‹domain›/k/‹token›`), and
- the **admin portal** staff log into.

Not required for A1–A3 (all DB/bridge/internal); dev uses the existing
`name-badge-printer.vercel.app`. Register/choose it **before A4/M1**, since QR
codes physically printed under one domain would need reprinting if it changes.

## Open inputs from operator

1. Printer **recon** (B0) when the unit arrives.
2. **Product domain** (before A4).
3. Ongoing: review each phase at its checkpoint.
