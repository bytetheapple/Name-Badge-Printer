# Always-On Connectivity History — Design

**Status:** **built 2026-11-05** — pending deploy (migration + edge fn + bridge
roll) and a hardware test. Decisions locked 2026-11-05.
**Owner:** (operator) · **Author of draft:** pairing session 2026-11-05.

> **As built — deviations from the draft below:**
> - **One probe loop at 5 s feeds both outputs**, so the on-demand Link Debug
>   dense sampling is now 5 s too (was 3 s) rather than a second probe cycle —
>   the printer sees a single connect per round. Dense `link_samples` behaviour
>   is otherwise unchanged.
> - **Ongoing (not-yet-recovered) band** is drawn only on the **9100** row, from
>   `printers.reachable` (the one link with a trustworthy live signal). `cloud`
>   and `ping` show recovered-outage history only — an in-progress outage on
>   those appears when it recovers. The server row keeps its own live band.
> - **Link rows share the server's `monitoring_since`** as the grey "no data"
>   anchor; there's no separate per-link monitoring epoch, so the window between
>   that anchor and this build rolling out reads as healthy. Self-heals as it
>   ages out of the range.
> - New migration is `supabase/migrations/20261105130000_mt_link_outages.sql`;
>   the UI extends the existing **Connectivity** page rather than adding a route.

---

## 1. Motivation

Shir Hadash, 2026-11-05: a long on-site session traced intermittent printer
reachability to **Wi-Fi deployment and interference problems**. Fixing the Wi-Fi
made both lobby printers reliably reachable (green on every link). The **Link
Debug** screen was what drove it to ground.

Two limits showed up on the way:

1. **Link Debug is on-demand.** It only helps if an operator is watching live at
   the moment the fault occurs — and an intermittent Wi-Fi fault is exactly the
   thing you can't schedule a session for.
2. **Point-in-time reads mislead.** Several earlier conclusions during the
   session (a "wedged" 9100 / TCP stack) were premature and proved wrong once the
   Wi-Fi picture was clear. A continuous record would have shown the link simply
   *flapping* and saved the detour.

**Want:** a continuous, low-cost record of each link's reachability so an
operator can look *back* at "what's been going on," surfaced on the existing
Connectivity page. See memory `printer-9100-wedged-and-panel-lock` (root cause
corrected to Wi-Fi).

---

## 2. What already exists — reuse, don't reinvent

- **`device_outages`** (`supabase/migrations/20261018120000_mt_device_outages.sql`)
  + **`app/src/routes/admin/ops/Connectivity.tsx`**: a rolling history of the
  **Pi→cloud** link. A trigger on `pi_devices.last_seen` writes **one row when an
  outage *ends*** (a transition), rolling-pruned to 7 days on insert; the page
  renders a timeline with drops / downtime / uptime. **A healthy device writes
  zero rows.** *This is the pattern to extend.*
- **Link Debug** (`link_samples`, `bridge/diagnostics.py`,
  `supabase/functions/bridge-poll/index.ts`): on-demand **dense 3 s sampling** of
  the cloud link and each printer's ping + 9100, with a live timeline. *The
  microscope — stays as is.*
- **The gap:** printer links (ping, 9100) and the bridge's own cloud reachability
  have **no persistent history** — only the Pi's `last_seen` does.

---

## 3. Design — transition logging for every link

**Locked decisions:** both ping and 9100 probed at **5 s**; persist
**transitions, not dense samples**; surface on the **Connectivity page**.

### 3.1 Bridge — one probe loop, two outputs

Make the existing diagnostics daemon (`bridge/diagnostics.py`) **always-on**.
Every 5 s it probes, in **one** cycle (so the printer sees a single connect per
5 s whether or not a live session is open):

- each printer: ICMP ping (`discover.answers_ping`) → `ping`; TCP 9100
  (`printer.check_reachable`) → `tcp`;
- the cloud: a lightweight HTTPS GET to `SUPABASE_URL` → `cloud`.

Two consumers of each cycle:

- **Always:** keep an in-memory up/down state per link with **debounce**; on a
  state *change*, enqueue a transition.
- **During an active Link Debug window** (`diagnostics_until` in the future):
  also enqueue the dense sample — unchanged behaviour.

**Debounce** keeps a flaky link from spamming rows: a link goes **down after N
consecutive failed probes** and **up on the first success**. Recommended **N = 3**
(~15 s at the 5 s cadence) — the 5 s-probe analogue of the `device_outages`
2-minute gate. The recorded outage spans `[first-failure, recovery]`.

The bridge reports a transition **only once the link recovers** (same
"write-on-recovery" shape as `device_outages`, so `started_at`/`ended_at` are
both known at insert). A link that is *currently* down is held in the bridge and
reported when it comes back; the page derives the ongoing gap live (3.4).
Transitions ride the existing poll body; the probe runs on the non-blocking
daemon (bridge Feature 1), so none of this touches the heartbeat.

### 3.2 Data — new table `link_outages` (mirror `device_outages`)

```sql
create table public.link_outages (
  id         uuid primary key default gen_random_uuid(),
  org_id     uuid not null references public.organizations on delete cascade,
  printer_id uuid references public.printers on delete set null, -- null = cloud link
  kind       text not null check (kind in ('cloud','ping','tcp')),
  started_at timestamptz not null,
  ended_at   timestamptz not null,
  seconds    int not null
);
create index link_outages_idx on public.link_outages (org_id, printer_id, ended_at desc);
```

- **RLS:** platform-admin read, exactly like `device_outages`
  (`revoke ... from anon, authenticated; grant select to authenticated;` policy
  `using (public.is_platform_admin())`). Bridge writes via **service role** in
  `bridge-poll` (bypasses RLS).
- **Rolling prune on insert:** delete that `(org_id, printer_id, kind)`'s rows
  older than **7 days** (recommended; matches `device_outages`). No cron.

### 3.3 Edge function — `bridge-poll`

Accept `body.link_transitions: [{kind, printer_id?, started_at, ended_at,
seconds}]`, bulk-insert scoped to `bridge.org_id` (service role), then prune.
**Distinct** from the existing on-demand dense `link_samples` ingest, which
stays. Still return `diagnostics_until` so a live session can also ask for dense
samples.

### 3.4 UI — extend `Connectivity.tsx`

- Today the page shows **one** server row (`device_outages`). Add, per selected
  installation: a **cloud** row (bridge→Supabase) and, per printer, a **ping**
  row and a **9100** row — same `ConnectivityGraph` timeline, same Hour/Day/Week
  toggle, same drops / downtime / uptime tiles.
- An **ongoing** outage (no row yet) is derived live from `printer_status`
  (reachable + `unreachable_reason`), the same way the page already derives the
  server's current gap from `last_seen`.
- Keep **Link Debug** as the live "zoom in" tool; cross-link the two pages.
- Reuse existing CSS only (`.stat-tile`, `.seg`, `.graph-wrap`, the timeline).

---

## 4. Non-goals

- **No dense always-on sampling** (storage cost at fleet scale; a wall of green
  is poor instrumentation). Dense stays on-demand in Link Debug.
- **No device changes** — pure observability. No reboot, no config writes.

---

## 5. Deploy (manual SQL, per project convention)

1. **Migration:** `link_outages` + index + RLS/grants — paste in the Supabase web
   editor (never `supabase db push`).
2. **Edge function:** `bridge-poll` accepts + inserts + prunes
   `link_transitions`.
3. **Bridge:** always-on probe loop + debounce + transition reporting
   (`diagnostics.py`, `client.py` poll body); roll via Fleet; **hardware test** —
   unplug a printer, confirm exactly one `link_outages` row appears on recovery,
   a healthy link writes nothing, and the console stays Online throughout.
4. **Front-end:** Connectivity page rows (autodeploys).

---

## 6. Decisions

- **Locked (2026-11-05):** both probes at **5 s**; **transitions, not samples**;
  on the **Connectivity page**.
- **Recommended defaults (adjustable):** **7-day** retention (match
  `device_outages`); debounce **N = 3** consecutive fails → down, first success →
  up.
- **Open:** `link_outages` as its own table vs. generalising `device_outages`
  into one outages table keyed by link; the exact cloud-link probe target (a
  health path on `SUPABASE_URL`).

---

## 7. Related

`supabase/migrations/20261018120000_mt_device_outages.sql` ·
`app/src/routes/admin/ops/Connectivity.tsx` · `bridge/diagnostics.py` ·
`link_samples` / `supabase/functions/bridge-poll/index.ts` · memory:
`printer-9100-wedged-and-panel-lock` (root cause corrected to Wi-Fi),
`server-bounce-and-link-debug`.
