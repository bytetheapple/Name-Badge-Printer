# Bridge credentials that renew themselves

A print server has no operator, and its owner has no terminal. That made the
"issue a token" box useless to a customer: it produced a secret with
instructions — paste this into `bridge/.env` and restart — that they could not
follow. It also meant a credential, once installed, stayed installed for ever.

The device is already authenticated and already polls every couple of seconds,
so it can be handed a replacement over its own channel.

## What happens now

| When | What |
|---|---|
| Imaging the card | You issue a bootstrap credential and write it to `.env` |
| First connection | The server replaces it immediately — the value you typed never stays in service |
| Every ~90 days | It renews again, with nobody clicking anything |
| A device is lost | You revoke it in the admin; it stops on its next poll |

The customer never sees a secret and never installs one. Revoke is the only
button left, and it is the one that already worked without touching the device.

## The rule that makes it safe

**A credential is revoked when its replacement is used, never when the
replacement is minted.**

Every failure in between leaves a working device:

* the response is lost in flight → old credential still valid, retry next poll
* the disk write fails → old credential still valid, failure reported, server
  backs off for 24h rather than minting a new one every two seconds
* power cut between writing and using → the new token is on disk and the old
  one is still live, so either will authenticate

The one case that rule does not cover is a device that stores a replacement and
then dies before using it, which would leave the old credential valid for ever.
`sweep_superseded_bridge_tokens()` revokes anything superseded more than seven
days ago; `bridge-poll` calls it.

## Apply

1. **Migration** — paste into the SQL editor:

       supabase/migrations/20260825120000_mt_bridge_token_rotation.sql

   The last statement returns one row. `sweep_superseded_bridge_tokens` must
   **not** list `anon` or `authenticated`: it revokes credentials and takes a
   grace interval, so a caller passing zero could revoke every superseded token
   at once.

2. **Edge Function**

       supabase functions deploy bridge-poll

3. **The Pi**

       cd ~/name-badge-printer && git pull && sudo systemctl restart badge-bridge

4. **The app**, from `main`.

## What to expect on the existing Pi

Its current credential has never recorded a first use, so it is treated as a
bootstrap value and **rotates on the first poll after the update**. The log line
is:

    credential renewed and stored

After that, `bridge/token` exists and `BRIDGE_TOKEN` in `.env` is dead. Leaving
it there is harmless — the stored credential takes precedence — but it can be
deleted.

Nothing needs doing by hand. If the file cannot be written, the bridge keeps
using the credential it has and the admin shows *could not renew — needs
attention* against that server.

## Ordering

Deploy the function **before** updating the Pi. A bridge that understands
rotation but talks to a server that does not simply never receives a
replacement, which is harmless. The reverse is equally harmless — an old bridge
ignores the `bridge_token` field — so this is a preference, not a requirement.

## One thing to know

Rotation fires on **first use**, not on first use *at the customer's site*. If
you boot a card on your bench to test it, that is the rotation, and the
credential you typed is retired there. The next renewal is then ~90 days later.
The security intent holds either way: the value a human handled does not stay
in service. But the card that leaves your desk is carrying a credential you
have never seen, which is worth knowing if you were planning to record them.

## Never do this

Do not copy `bridge/token` between devices. Two machines sharing a credential
will both try to rotate it; the first to succeed retires it, and the second is
revoked mid-shift. Issue each device its own bootstrap value.
