# Fleet firmware record

`printer_config.py` carries `FIRMWARE_VERIFIED = "1.32"` — the version its field
names were read off. Every other version gets the same warning whether it
configures perfectly or not at all, because nothing recorded which.

`firmware_observations` is that record: one row per model and firmware, counting
attempts, successes, failures, and which steps did the failing.

## Apply

Paste into the SQL editor:

    supabase/migrations/20260826120000_mt_firmware_observations.sql

Then `supabase functions deploy bridge-poll`, update the Pi, and deploy the app
(the app is unchanged, but keeping the four in step avoids confusion later).

The last statement returns one row: `record_firmware_observation` must **not**
list `anon` or `authenticated`. It writes fleet-wide counters from whatever
arguments it is handed.

## What is and is not recorded

Only outcomes the configuration is responsible for:

| Outcome | Recorded |
|---|---|
| Every setting applied | success |
| A setting rejected by the printer | failure, with the step name |
| **Password refused** | **nothing** |
| **Printer unreachable** | **nothing** |
| No wireless MAC reported | nothing |

That distinction is the whole value of the table. A mistyped password produces a
failed configure step, and counting it against the firmware would attribute an
operator's typo to a version — which makes the record worse than not having one.
The bridge drops the outcome in those cases rather than the server guessing.

## Reading it

Platform admins only; there is no UI yet. From the SQL editor:

```sql
select model, firmware, attempts, successes, failures, failed_steps, last_seen
from public.firmware_observations
order by last_seen desc;
```

`failed_steps` is where the useful signal lives. One step failing consistently
on one version, while the rest pass, is a field name that moved between firmware
releases — which is exactly the thing `FIRMWARE_VERIFIED` warns about without
being able to say.

## Deliberately not per-organization

The table carries no `org_id`. A firmware version is a property of the hardware,
not of the congregation that bought it, and keeping the two apart means the
fleet record can be read without reading anyone's tenant data. Tenants cannot
see it at all.

## What this does not do yet

Nothing consumes it. The warning still fires on any version other than 1.32,
regardless of what the record says. Making the warning read from the table — "we
have configured 1.25 successfully eleven times" — is the obvious next step and
deliberately not part of this, since one datum is not yet evidence.
