# Name Badge Printer — Design

New-member name badge printer for Shir Hadash.

A visitor scans a QR code posted by the printer, fills out a short form (name,
phone, email), and taps **Print**. A Brother QL-820NWB label printer on the
local network prints their name badge. An admin console lets staff configure the
printer, review/export submissions, monitor printer status, and send test prints.
Each submission is also pushed into an existing Google Form.

---

## 1. The core architectural constraint

The **QL-820NWB lives on the local network** (a LAN IP such as `192.168.x.x`).
A cloud-hosted web app (Vercel) **cannot reach a device on that LAN**, and there
is no usable cloud print API for these Brother label printers. AirPrint doesn't
help either — it's LAN/Bonjour only.

Therefore printing must be initiated by something **physically on the printer's
network**. The solution is a small always-on **print bridge** (a Python service
on a Raspberry Pi, or any always-on machine on that LAN) that watches Supabase
for print jobs and does the actual printing.

**Supabase is the message bus.** The visitor's phone and the printer never talk
directly — the phone writes a print job to Supabase, and the bridge (subscribed
via Realtime) picks it up. This is what lets a cloud app drive a local printer.

---

## 2. System architecture

```
   ┌─────────────┐   scan QR    ┌──────────────────────┐
   │  Visitor's  │─────────────▶│  Public form (React)  │
   │    phone    │◀── status ───│   on Vercel           │
   └─────────────┘   (Realtime) └──────────┬───────────┘
                                            │ POST (validated)
                                            ▼
                                 ┌──────────────────────┐
   ┌─────────────┐  login/RLS    │      Supabase         │
   │ Admin (you) │──────────────▶│  Postgres · Auth ·    │
   │  React SPA  │◀── Realtime ──│  Realtime · Edge Fns  │
   └─────────────┘               └───┬───────────────┬──┘
                                     │ Realtime push  │ Edge Fn
                                     ▼                ▼
                          ┌──────────────────┐   ┌──────────┐
                          │  Print bridge    │   │  Google  │
                          │  (Python on Pi)  │   │  Form     │
                          │  brother_ql +    │   └──────────┘
                          │  Pillow          │
                          └────────┬─────────┘
                                   │ TCP 9100 (LAN)
                                   ▼
                          ┌──────────────────┐
                          │   QL-820NWB       │
                          └──────────────────┘
```

---

## 3. Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Public form + Admin UI | **React on Vercel** | Matches the existing app pattern; form works on any phone/cellular |
| Database / Auth / Realtime | **Supabase** | Postgres, Auth, Realtime, Edge Functions |
| Server-side actions | **Supabase Edge Functions** | Validated public writes; Google submission; holds secrets |
| Local print bridge | **Python** on a Raspberry Pi (3B+ or better) | `brother_ql` + `Pillow`; runs as a `systemd` service |
| Excel export | **SheetJS (`xlsx`)** client-side | Export filtered table, no server round-trip |
| QR code | Static QR encoding the form URL | Generated once, posted by the printer |

**Bridge hardware:** Raspberry Pi 3B+ is sufficient (the workload is an idle
websocket plus an occasional small-label render). Any always-on Mac or NAS on the
printer's LAN can host the bridge instead.

---

## 4. Data model (Supabase / Postgres)

| Table | Purpose | Key columns |
|---|---|---|
| `form_entries` | Every submission from the QR form | `id`, `name`, `phone`, `email`, `created_at`, `google_sync_status` (pending/sent/failed), `source_ip` |
| `print_jobs` | One row per print request (incl. reprints & tests) | `id`, `entry_id` (nullable for tests), `type` (badge/test), `status` (queued/printing/printed/failed), `attempts`, `error`, `created_at`, `printed_at` |
| `printer_config` | Single-row config the admin edits | `printer_ip`, `port` (9100), `label_media`, `dpi`, `badge_template` (JSON) |
| `printer_status` | Written by the bridge, read by admin | `bridge_last_seen`, `printer_reachable`, `media_type`, `media_width`, `error_state`, `updated_at` |
| Auth users | Admins | Managed by Supabase Auth |

Row-Level Security is applied to every table (see §10).

---

## 5. Print job lifecycle (the heart of the system)

```
 [queued] ──bridge claims──▶ [printing] ──success──▶ [printed]
    │                            │
    │ (no bridge / timeout)      └──error──▶ [failed]
    ▼
 phone shows "waiting…"          phone shows ✓ or "see attendant"
```

1. Visitor submits the form → an Edge Function creates a `form_entries` row **and**
   a `print_jobs` row (`queued`).
2. The bridge, subscribed via Realtime, **atomically claims** the job
   (`UPDATE … SET status='printing' WHERE status='queued'` — the guard prevents
   double-printing even with multiple bridges).
3. The bridge renders the badge, sends it to the printer, and sets `printed`
   (or `failed` with an error message).
4. The visitor's phone is subscribed to *their* job's status and shows
   **"Printing… → Printed ✓"**, or a friendly "please see the attendant" on
   failure/timeout.

If the Pi is off or the printer is out of labels, the job stays `queued`/`failed`,
the visitor gets a clear message, and the backlog is visible in the admin panel —
nothing silently disappears.

---

## 6. Feature: Public form (the QR flow)

- **QR code** encodes one static URL (the form). Generated once, posted by the
  printer. The admin console can display/download it.
- **Form:** Name, Phone, Email + a **Print** button. Mobile-first; hosted on
  Vercel so it works on cellular.
- On submit, the form calls a **Supabase Edge Function** (not a raw table insert)
  so input is validated and the entry + job are created server-side without
  exposing table internals to the public `anon` role.
- After submit: a **live status screen** ("Printing your badge…") driven by
  Realtime.
- **No rate limiting / CAPTCHA** — the printer is in a protected, staffed area,
  so the form auto-prints on submit. (Rate-limiting can be added later if ever
  needed.)

---

## 7. Feature: Print bridge (Python service on the Pi)

A small, single-purpose service:

- **Subscribe** to `print_jobs` (Realtime); process `queued` jobs.
- **Render** the badge as a PNG (Pillow) from the entry data + `badge_template`,
  then hand it to **`brother_ql`**, which converts to the QL-820NWB raster format
  and sends it over **TCP 9100**.
- **Heartbeat:** every ~15s, write to `printer_status` — bridge alive, printer
  reachable (TCP check), media type/errors read back from the printer.
- **Config-aware:** reads `printer_config` and subscribes to changes, so changing
  the printer IP in the admin panel takes effect with no re-deploy.
- Runs as a **`systemd` service** (auto-start on boot, auto-restart on crash).
- Authenticates to Supabase with a dedicated scoped key stored on the Pi.

---

## 8. Feature: Admin console

Protected React section (same app, gated route + RLS).

**a. Printer config** — printer IP, port, label/media type, and badge template
(which fields print, font sizes). Saved to `printer_config`.

**b. Entries table** — all `form_entries`, with:
- **Date-range filter** (Supabase query on `created_at`).
- **Excel export** of the filtered set via client-side SheetJS (`.xlsx`).
- Per-row **Reprint** (creates a new `print_job`) and Google-sync status.

**c. Printer status panel** (live via Realtime):
- **Connection status** — two indicators: *Bridge online?* (heartbeat freshness)
  and *Printer reachable?* (TCP check result).
- **Supplies/media** — the QL-820NWB reports **media type/width and error states**
  (cover open, end-of-roll, etc.) but **not a % remaining** (thermal printer, no
  ink; roll remaining isn't tracked). This panel shows media info + any error
  condition, not a fuel gauge.
- **Test print** button — inserts a `type=test` job that flows through the same
  pipeline (a full end-to-end health check).

---

## 9. Feature: Google Form integration

On each new entry, a Supabase Edge Function pushes the data to the existing Google
Form. This runs **decoupled from printing** — a Google hiccup must never block a
badge from printing. Status is tracked in `google_sync_status` with retry.

**Method:** The form accepts responses **without login**, so we submit by
**POSTing to the form's `formResponse` endpoint** with the `entry.<id>` field
mappings. This genuinely registers a form submission (the official Google Forms
API cannot submit responses). The field-id mapping is captured once from the
form's prefilled-link parameters and stored in configuration.

---

## 10. Auth & security

- **Auth:** Supabase Auth, **username/password**. New admins are **invited by
  email** (Supabase `inviteUserByEmail`); the invitee clicks the link and sets
  their own password. Admin routes are gated in React **and** enforced by RLS at
  the database (UI gating alone is not security).
- **RLS everywhere.** The `anon` role cannot read `form_entries`; the public path
  goes through the Edge Function only. Admin reads require an authenticated admin.
- **Public writes are mediated** by the Edge Function (validation), so the anon
  key never gets broad table access.
- **Secrets** (Google config, bridge key) live in Supabase Edge Function secrets
  and on the Pi — never in the React bundle.
- **Bridge key** is scoped to only what it needs (read jobs/config, write status
  and job results).

---

## 11. Build sequence

Staged so there's a working end-to-end path early, then features layer on:

1. **Supabase foundation** — schema, RLS, Auth (migrations via CLI).
2. **Bridge on the Pi** — prove PNG → `brother_ql` → a real badge prints, driven
   by a manually-inserted job. De-risks the hardware first.
3. **Public form + live status** — the QR flow end to end.
4. **Admin: config + entries table + export.**
5. **Admin: status panel + test print.**
6. **Google Form integration.**

---

## 12. Resolved decisions

- **Bridge host:** Raspberry Pi (3B+ acceptable), or any always-on LAN machine.
- **Google target:** POST to `formResponse` — the form allows responses without
  login.
- **Abuse control:** none needed — printer is in a protected, staffed area;
  auto-print on submit.
- **Auth:** username/password with email-invite → invitee sets their own password.
