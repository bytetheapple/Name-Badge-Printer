# Building a print server

From a blank SD card to a device ready to ship, in the admin under
**Platform → Build a print server**.

## Why the app cannot do it for you

A browser has no TCP sockets, and Supabase's cloud has no route to a Raspberry
Pi on your bench. So the app cannot SSH in and configure anything — the same
wall the printer wizard hit, with the same answer: **the device does the work,
the server coordinates.**

The Pi boots with a one-time claim code, exchanges it for its own credential,
and appears in the console. That works identically whether it is on your bench
or already at a customer's site.

## Apply

1. **Migration** — `supabase/migrations/20260828120000_mt_pi_devices.sql`

   The last statement returns two rows. `claim_pi_device` must **not** list
   `anon` or `authenticated`: it mints a working credential from a string, so
   anything that could reach it could brute-force claim codes.

2. **Edge Function** — `supabase functions deploy pi-claim`

   It is registered in `config.toml` with `verify_jwt = false`. The caller is a
   Pi with no account and no key; the claim code is its whole identity.

3. **The app**, which also publishes `pi.sh`.

## Building one

Everything is in the wizard, but the shape of it:

| Step | Where |
|---|---|
| Allocate a serial and claim code | the app |
| Get a Raspberry Pi Connect auth key | connect.raspberrypi.com |
| Burn the card | Raspberry Pi Imager |
| Boot on Ethernet | your bench |
| Run one command | a Connect shell on the Pi |

The command is:

```
curl -sSL https://guestbadges.com/pi.sh | sudo bash -s -- gbc_<claim code>
```

It claims the device **before** installing anything, so a spent or mistyped
code costs seconds rather than a full install ending in failure. Then it
installs, writes the configuration, starts the service, and waits for the
bridge to report in rather than declaring success and leaving you to discover
otherwise.

The end state is **bridge online, no printers**. That is what to ship.

## What is on the card, and for how long

Nothing that matters for long:

* **The claim code** is spent the moment it is used. A second device presenting
  it is refused rather than issued a duplicate identity.
* **The bridge credential** the script writes is replaced by the device itself
  on its first poll, so the value written at the bench is stale before the
  device reaches a customer.
* **The Connect auth key** is single-use and expires in six hours, so an old
  card cannot be used to join your fleet later.
* **Your SSH public key** — the private half never comes near any of this.

There is deliberately no shared admin credential. One credential across every
Pi would make a single lost device shell access to every customer's network,
which is the pattern this project spent a fortnight removing everywhere else.

## Why Connect rather than Tailscale

Tailscale's free plan is non-commercial, and a tailnet on a custom domain is
treated as business use — so it would be a paid tier. Connect is free, official,
and its auth keys expire in hours rather than living forever in an image.

What Tailscale would buy is scripting: a real address, so `ssh`, `scp` and
fleet loops work. Connect gives a browser terminal, one device at a time. That
is an acceptable trade **only because bridge updates are pull-based** — the Pi
polls and updates itself, so fleet-wide changes never needed SSH. SSH here is
for diagnosing one misbehaving device, which is one at a time anyway.

It is also reversible: Tailscale is a package and an auth key, deliverable to
every existing Pi through the update path, with no re-imaging.

## The registry

Every device built is listed under Platform, with its serial, who it was built
for, and when it claimed. The customer name is stored as text rather than only
as a foreign key, because an organization can be renamed or deleted and "what
did I ship them" outlives both.

A device allocated but never claimed shows as **not yet** — a card that was
written and never finished, or one still on the bench.

## Not in this yet

**Managed updates.** These Pis still update by hand, deliberately: shipping a
device with an auto-update mechanism that has not been designed carefully would
be the wrong order. The intended design is a version pointer the server
controls — the Pi converges to a ref named in `bridge-poll`, so releasing is a
row change rather than a git push, rollback is instant, and a rollout can be
staged one device at a time.
