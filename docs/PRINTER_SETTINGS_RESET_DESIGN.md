# Printer Settings Reset & Credential Storage — Design

**Status:** design only, not started. Decisions locked 2026-11-05; build later.
**Owner:** (operator) · **Author of draft:** pairing session 2026-11-05.

---

## 1. Motivation

Shir Hadash, 2026-11-05: the Main printer went dead on port 9100 for hours
(answered ICMP ping and served its web UI on port 80, but 9100 connects hung).
On a site visit the operator found staff had been changing panel settings
(**Forms/Template mode on**, **Bluetooth on**). Correcting the settings **plus a
power cycle** recovered it to the same intermittent state as the other printer.

Two wants came out of that afternoon:

1. **Re-apply a printer's desired settings remotely**, without a site visit,
   when someone (or a factory reset) has changed them — a "reset to known-good".
2. **Lock the front panel** at provisioning so staff can't change settings by
   accident in the first place.

See the incident note in memory (`printer-9100-wedged-and-panel-lock`) and
`docs/PRINTER_RECON_QL820NWB.md` for the web-UI field reconnaissance this design
leans on.

---

## 2. What is actually achievable (grounded in the recon)

The recon (`docs/PRINTER_RECON_QL820NWB.md`, firmware 1.32, factory-reset unit)
is the source of truth for what the QL-820NWB exposes. It changes the scope:

- **Web-settable** (the bridge already POSTs these via `printer_config.py`):
  Command Mode `B24`, print density, language, brightness, auto-cut, power
  settings (`B1c` auto power-on, eco charging), the communication page
  (`B31` radio, `B62` mode), Wi-Fi, date/clock. These are what a reset can
  enforce.
- **NOT found in the web UI** anywhere in the recon: **panel lock / setting
  lock** and a **Bluetooth on/off** toggle. On this model those appear to be
  panel-only. ⇒ **panel-lock and Bluetooth-off must be manual steps**, not
  automated.
- **No clean remote reboot** (recon, "Rebooting — there is no clean way to do it
  remotely"). ⇒ a reset can re-POST settings but **cannot power-cycle**, so it
  does **not** replace a power cycle for a wedged printer.
- **Command Mode (`B24`) is irrelevant to printing** — every job sends
  `ESC i a 01` and switches to raster per connection, verified on hardware
  (recon §1 and memory `badge-font-and-command-mode`). Re-asserting `B24=21` is
  defensive hygiene (keeps stored state and status queries sane), **not** a fix
  for a printer that won't print.

**Net:** the automated feature is "re-apply the web-exposed settings"; panel
lock and Bluetooth are a documented **manual** provisioning step; neither
replaces a power cycle.

---

## 3. Goals / Non-goals

**Goals**
- Operator-triggered **"Re-apply settings"** on an already-deployed printer that
  re-runs the configure-time settings writes against the live device.
- **Store each printer's web password at rest** (encrypted, Vault) so a reset
  runs without re-entering the code — *decision locked; a deliberate change from
  today's take-and-destroy posture.*
- A **manual guided panel-lock step** in provisioning (lock panel + confirm
  Bluetooth off), after the Wi-Fi cutover.

**Non-goals (for v1)**
- Remote reboot / power-cycle (not possible on this model).
- Automating panel lock / Bluetooth (no web-UI field on this model).
- Re-applying Wi-Fi as part of reset (risky — a bad write strands the printer;
  keep reset to device/comms settings only).
- "Re-apply to all printers in an org" (later; v1 is one printer at a time).

---

## 4. Design

### 4.1 Credential storage at rest

Mirror the existing provisioning-secret pattern (`set_provisioning_secret` /
`provisioning_secret` / `clear_provisioning_secrets`,
`supabase/migrations/20260824120000_mt_b3_provisioning.sql`), but durable and
keyed to the printer rather than the session.

- **Schema:** `printers.web_secret_id uuid` (nullable) — a Vault secret id, never
  the plaintext in the table.
- **Functions** (`SECURITY DEFINER`, granted to `service_role` only; revoked
  from `anon`/`authenticated`, per the function-grant gotcha):
  - `set_printer_web_secret(p_printer uuid, p_secret text)` — create or update
    the Vault secret, store its id on the printer row.
  - `printer_web_secret(p_printer uuid) returns text` — decrypt; **Edge
    Functions only**. Never exposed to the browser.
  - `clear_printer_web_secret(p_printer uuid)` — delete the Vault secret and null
    the column.
- **Population**
  - *Going forward:* when provisioning finishes, copy the session's
    `web_password` into the printer secret **instead of only destroying it**
    (hook into `applyResult` / the session-clear path in
    `supabase/functions/_shared/provisioning.ts`).
  - *Existing fleet (Shir Hadash etc.):* no code was ever stored. The **first
    reset prompts for the code once** (operator enters → `set_printer_web_secret`
    → remembered thereafter). Call this out in the UI.
- **Lifecycle:** delete the Vault secret on printer delete (cascade/ trigger);
  a **"Forget code"** admin action maps to `clear_printer_web_secret`.

### 4.2 Reset / re-apply flow

Reuse the provisioning task plumbing — the bridge already has one out-of-band
channel and a step state machine.

- **Bridge:** add a task `reapply_settings` to `provision_task.run` that invokes
  the existing `configure_printer()` apply path (login → GET each page, echo all
  fields, POST the desired values), **minus** discovery/Wi-Fi. Verify by a **test
  print** (recon: only a print proves command mode), report on the next poll.
- **Trigger:** operator clicks "Re-apply settings" → an RPC enqueues a step /
  one-shot request for that printer's bridge.
- **Password delivery:** the edge function reads `printer_web_secret(...)` from
  Vault and delivers it **single-use** in the task payload, the same way the
  Wi-Fi passphrase is read-and-handed-over in `bridge-poll` (exists in the
  response and nowhere else). If no secret is stored, the UI requires the
  operator to enter the code; it is stored (4.1) then used.
- **Reachability:** reset needs the printer reachable on port 80. Define
  behavior when it isn't — recommend: refuse to start with a clear message
  ("printer not reachable"), rather than queue indefinitely.

**Open sub-decision:** reuse `provisioning_sessions` for this, or add a lighter
`printer_reset_requests` table. Leaning reuse to avoid new plumbing.

### 4.3 Manual panel-lock provisioning step

- A guided instruction step added **after the Wi-Fi cutover** (last time hands
  are on the printer): *"On the printer's panel, turn on the setting/panel lock,
  and confirm Bluetooth is off."* Operator marks done.
- Needed because the web UI can't set these on this model. Add the step to the
  provisioning step enum
  (`supabase/migrations/20260825200000_mt_provisioning_password_step.sql` lists
  the current set).

### 4.4 UI

- **Ops → Fleet / printer view** (operator-only): a **"Re-apply settings"**
  button per printer, one at a time. Show the last run's result/transcript
  (reuse the provisioning transcript rendering). A **"Forget code"** action.
- "Re-apply to all in org" is a later addition.

---

## 5. Security

- The stored printer code is a **standing credential that can reconfigure the
  printer** — the accepted tradeoff for unattended reset. Mitigations:
  Vault-encrypted at rest; **service-role-only** decrypt; **operator-only**
  trigger; never returned to any browser; "Forget code" + cascade delete;
  surface resets in the activity log.
- Reset is **operator-only** (platform admins) in v1.

---

## 6. Data model & deploy (manual SQL, per project convention)

Migrations are applied by pasting SQL in the Supabase web editor (never
`supabase db push`).

1. **Migration:** `ALTER TABLE printers ADD COLUMN web_secret_id uuid;` the three
   Vault functions; the new provisioning step enum value; (optional)
   `printer_reset_requests`.
2. **Edge functions:** reset trigger + password delivery (new or folded into an
   existing function); provisioning-complete change to persist the code.
3. **Bridge:** `reapply_settings` task; roll via Fleet (needs a hardware test).
4. **Front-end:** ops Fleet button + manual provisioning step (autodeploys).

---

## 7. Open questions / to confirm before building

- **Re-confirm the web UI really has no panel-lock / Bluetooth field** on current
  field firmware (the recon was one factory-reset unit). If a field exists,
  promote panel-lock/Bluetooth from manual to automated in both configure and
  reset. *Easiest while someone is standing at a printer: save
  `/printer/device_settings.html` and `/printer/communication_settings.html`.*
- Reuse `provisioning_sessions` vs. a dedicated `printer_reset_requests` table.
- Behavior when the printer is unreachable at reset time (recommend: refuse).
- Does reset ever need to touch Wi-Fi? (Recommend no.)

---

## 8. Testing

- **Unit:** the Vault functions; the `reapply_settings` task against a captured
  transcript (pattern of `bridge/test_provision_task.py`).
- **Hardware:** seed the code on a Shir Hadash printer, run reset, confirm the
  settings re-applied and a test badge prints.

---

## 9. Decisions locked (2026-11-05)

- Store each printer's web password **at rest** in Vault.
- Reset lives in the **ops Fleet view**, **operator-only**, **one printer at a
  time**.
- Panel-lock is a **manual guided step after the Wi-Fi cutover**.
- Reset enforces only **web-exposed settings**; panel-lock/Bluetooth stay manual;
  reset does **not** reboot.

## 10. Related

`docs/PRINTER_RECON_QL820NWB.md` · `bridge/printer_config.py` ·
`bridge/provision_task.py` · `supabase/functions/_shared/provisioning.ts` ·
`supabase/functions/bridge-poll/index.ts` (Wi-Fi secret hand-off pattern) ·
memory: `printer-9100-wedged-and-panel-lock`, `badge-font-and-command-mode`.
