# Managed bridge updates

Updating a print server meant opening a shell and typing `git pull`. That does
not survive a fleet, and it means a device in a locked building runs whatever it
was built with for ever.

Auto-pulling `main` is not the answer: `main` is a working trunk, and a stray
push would become a fleet-wide deploy within minutes. So **the server names a
version and devices converge to it.** Releasing is a row change, not a git
operation.

## Apply

1. **Migration** — `supabase/migrations/20260829120000_mt_bridge_release.sql`.
   The last statement returns one row; `bridge_target_ref` must **not** list
   `anon` or `authenticated`.
2. **Edge Function** — `supabase functions deploy bridge-release`
3. **The app.**

Devices built before this have no updater. Re-running the installer on one adds
it; nothing else changes.

## Where the version list comes from

Both pickers read the repository directly — the last forty commits on `main`,
each with its sha and subject line, with any tags folded in on top:

```
[v1.0: First production release] a1b2c3d — feat: something
c4dc926 — feat: pin a print server from the console
```

Nothing has to be maintained: this project writes commit subjects at length, so
the commit list is already a list of changes. Tag an interesting one and it
gains a name; leave it and the subject still says what it is.

**Tagging happens on your machine, not here.**

```
git tag -a v1.0 -m "First production release" 8df9fb6
git push origin v1.0
```

The console will not create tags, and that is deliberate. Creating one needs
`contents: write`, which is the same permission as pushing code — and every Pi
fetches from this repository and checks out what it is told. A write credential
in the app would join "a leaked Supabase secret" to "arbitrary code running as
root on every customer's device". Reading needs no credential at all, so the
asymmetry costs two commands and buys the fleet's trust anchor staying outside
the app.

GitHub allows sixty unauthenticated requests an hour per address, which is
ample: the list is fetched once per visit rather than on every action. If it
cannot be read — a rate limit, an outage — the pickers become plain text boxes
and say why, because an outage at GitHub must not leave the fleet unmanageable.

## Releasing

Platform → **Bridge release** → choose a version → Set release. Every device not
pinned elsewhere moves within about fifteen minutes.

**Leave it empty to hold everything still.** An unset release means *stay put* —
the failure of doing nothing is a stale device, and of guessing is a deploy
nobody asked for.

**Rollback is the same action.** Put the previous sha back; devices revert on
their next check.

**Hold servers back** by choosing the version above the Print servers table,
ticking the ones it applies to, and pressing **Hold**. The version can be chosen
before anything is selected — deciding which version and choosing which devices
are separate thoughts. **Follow the fleet** releases the selected servers again.

The header tick selects everything; with only some selected it shows as
indeterminate rather than claiming either.

**Stage a rollout** with the same control: hold one server on the *new* sha
while the fleet release stays where it is, watch it for a day, then move the
fleet. A pin always beats the fleet release, which is what makes both of these
one mechanism rather than two.

Each selected server is changed by its own call, so a rejected ref names the
server it was rejected for. A failure part way through leaves the servers
already changed changed — there is no rollback, and the message says how many
went through.

The ref is validated where you type it, so a typo is refused there rather than
fifteen minutes later on a device in somebody's building.

## What the device does

A systemd timer runs `bridge/scripts/update.sh` as root every fifteen minutes,
with a randomised delay so a fleet does not all fetch at once, and once shortly
after boot so a device that was switched off catches up.

It runs as root because **the bridge cannot update itself** — its account
deliberately cannot write the code it runs. The updater is the only thing on the
device that can, which is why it is small enough to read in one sitting and does
exactly one thing.

**The server names a git ref and nothing else.** There is no command channel
here. Adding one would turn a fleet of appliances into a fleet of remote shells,
which is a different product with a different threat model.

The ref is checked twice before it reaches git: refused if it contains anything
but `[A-Za-z0-9._/-]`, and refused separately if it begins with a hyphen —
`--upload-pack` passes a character check and is then read by git as an *option*
rather than a ref.

## If an update breaks a device

It reverts itself. After checking out the new ref it restarts the bridge and
waits for it to report in; if it does not, the previous commit goes back, the
service restarts, and the reason is reported on the next check and shown against
that device in the console.

That matters more than it sounds: a device that updates into a crash loop and
says nothing is worse than one that never updated, because the only symptom is a
lobby that quietly stopped printing.

## What it does not do

**Downgrade dependencies.** `pip install -r requirements.txt` runs on every
update, which adds packages but does not remove them. A rollback restores the
code, not the environment.

**Coordinate with printing.** A restart mid-job loses that job; the queue
retries, but a badge could be seconds late. At fifteen-minute granularity on a
lobby that is busy for an hour a week, that is a fair trade rather than a
solved problem.

**Update itself atomically.** The checkout is not transactional. A power cut
mid-update leaves a checkout that may not run — the next timer run repairs it,
but the window exists.
