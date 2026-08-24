# Phase B3 — guided printer setup in the admin

Moves `provision.py` into the Add a Printer tab. The physical steps become
screens; the four steps that have to reach the printer's network are handed to
the Pi one at a time, on the poll it already makes.

Nothing here changes how an existing printer works. A printer already set up
keeps printing throughout.

---

## 1. Apply the migrations

Paste into the Supabase SQL editor, in order:

    supabase/migrations/20260824120000_mt_b3_provisioning.sql
    supabase/migrations/20260824160000_mt_b3a_visible_networks.sql

The second one adds a single column and returns nothing; it is safe to run on
its own if the first is already applied.

It is additive and idempotent. It creates `provisioning_sessions`, three Vault
helper functions, and their grants.

**The last statement returns three rows.** Check them before moving on:

| proname | grants |
|---|---|
| `clear_provisioning_secrets` | may list `authenticated` |
| `provisioning_secret` | **must not list `anon` or `authenticated`** |
| `set_provisioning_secret` | may list `authenticated` |

`provisioning_secret()` decrypts a WiFi password for whatever session id it is
handed. If `authenticated` appears on that row, stop — any signed-in user of
any organization could read every tenant's WiFi credentials, and no RLS policy
can prevent it because the function is SECURITY DEFINER by design.

## 2. Deploy the Edge Function

    supabase functions deploy bridge-poll

Only this one changed. Old bridges keep working: a Pi that has not been updated
simply never sends a `provision_result` and is never handed a step.

## 3. Update the Pi

```bash
cd ~/name-badge-printer && git pull && sudo systemctl restart badge-bridge
```

New file: `bridge/provision_task.py`. No new dependencies.

## 4. Deploy the app

Vercel, from `main`.

## 5. Verify

Run both test suites in the SQL editor — each ends with `ALL CHECKS PASSED`:

    supabase/tests/isolation_test.sql     (41 checks)
    supabase/tests/roles_test.sql         (27 checks)

The B3 checks in them are the ones worth watching:

* `provisioning_secret: not callable from the browser`
* `provisioning secrets: deleted with the session`
* `staff: cannot see, start, or advance a printer setup`

Then, in the admin: **Printers → Add a Printer**. "Set up a new printer" should
appear above the scan button. Starting one and cancelling it is safe and costs
nothing — it writes a row and deletes it again.

---

## What the walkthrough does

| Step | Who | What |
|---|---|---|
| 1 | operator | Factory reset, from the printer's own panel |
| 2 | operator | The first-run language / date screens |
| 3 | operator | Plug in Ethernet |
| 4 | **bridge** | Find it on the wired network |
| — | operator | Pick it, if more than one answered |
| 5 | **bridge** | Log in, identify it, apply the kiosk settings, survey the WiFi |
| — | operator | Choose the network and give its password |
| 6 | **bridge** | Write the wireless settings |
| 7 | operator | Power cycle, wait for a solid WiFi icon |
| 8 | **bridge** | Find it again on WiFi, and add it as a printer |

The session row is the only memory between steps, so the operator can close the
tab during the reset — several minutes of standing about — and come back to it.

## Choosing the network

The network is not asked for up front. It is chosen at step 5, from a list the
**printer itself** produced — its wireless page has a scan behind the Browse
button, and it answers over Ethernet before any wireless is configured.

That source is deliberate. This model is 2.4GHz only, so a list it made itself
cannot contain a network it is unable to join. A list from a phone or from the
Pi can, and picking a 5GHz network fails exactly like a wrong password does:
the printer switches to wireless, stops answering, and needs another factory
reset.

Naming a network that is not in the list stays available, because a printer is
often set up at a desk and installed somewhere else.

> **Not yet proven against hardware.** The scan page's markup has never been
> captured — the recon only established that the Browse button exists. The
> parser is written to the shape such a table plausibly takes and is tested
> against constructed fixtures, so the picker may come up empty on the first
> real run. That degrades to typing the network name, which is what the
> previous version did anyway, so it costs nothing but the convenience.
>
> To pin it down, capture a real page while a printer is on Ethernet:
>
> ```
> curl -s 'http://<printer-ip>/net/wireless/wireless.html?wlan=3' > scan.html
> ```
>
> That needs a logged-in session, so easiest is to open the wireless page in a
> browser, press **Browse**, and save the resulting HTML. With that in hand the
> parser can be fixed against reality and the fixture added to
> `bridge/test_printer_config.py`.

## The secrets

Two are needed: the printer code (the `Pwd:` on its label) and the site's WiFi
password. The first goes into Vault when the setup starts and the second when
the network is chosen; both are deleted when the setup finishes or is cancelled — including if the row is deleted directly, which a
trigger covers. Neither is ever stored in a column, and only the Edge Functions
can read one back.

Each step is sent only what it needs. `discover` and `rediscover` are sent no
secrets at all.

## When a step fails

The session is handed back to the last point where a person can do something
about it — `configure` fails to `select`, `wifi` fails to `wifi_confirm`, and
so on — with the error and the print server's transcript on screen. It is never
sent back to the start of a factory reset, and never left sitting in a state
the bridge would retry unattended.

## What this does not replace

`provision.py` and the other scripts in `bridge/` still work and are still the
right tool when the admin cannot be reached — a site with no internet, or a
printer being prepared on a bench. See [PRINTER_RECON_QL820NWB.md](PRINTER_RECON_QL820NWB.md)
for the field-level detail behind all of it.

## Still open

`DK-1234` geometry is unresolved and untouched by this phase: the admin has
always been set to `60x86` and production prints correctly, yet a local
`brother_ql` 0.12.0 raises `KeyError: '60x86'`. Do not register a derived
geometry — a guessed one jammed a printer. When next on the bridge's network:

```bash
cd ~/name-badge-printer && ./venv/bin/python -c "from brother_ql import devicedependent as dd; print(dd.label_type_specs.get('60x86'))"
```
