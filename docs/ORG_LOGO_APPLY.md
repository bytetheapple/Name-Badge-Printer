# The organization's own name mark

The badge header offers text, "the logo", or a per-printer graphic. "The logo"
was a PNG shipped inside the bridge — one congregation's mark, on every
deployment — so a second organization choosing it would have printed somebody
else's name on their badges. The same file was also drawn into the centre of
every lobby QR code.

It is now an upload, per organization, in **Settings → Name mark**.

## Deploy in this order

The order matters: the bundled logo is gone, so between the Pi updating and a
mark being uploaded, a printer set to "logo" prints its header text instead.

1. **Migration** — `supabase/migrations/20260826180000_mt_org_logo.sql`.
   One nullable column on `app_settings`.
2. **The app.** Settings gains the Name mark pane.
3. **Upload the mark**, in Settings. For Shir Hadash this is the same PNG the
   bridge has been printing, so nothing changes visually.
4. **`supabase functions deploy bridge-poll`** — it starts sending `logo_url`.
5. **The Pi**, last: `git pull && sudo systemctl restart badge-bridge`.

Steps 1–3 change nothing about what prints. Step 5 is where the bridge starts
using the uploaded mark instead of the bundled one, which is why the upload
comes first.

## What changed where

* **Settings → Name mark** uploads to the existing `badge-headers` bucket,
  content-addressed exactly like the per-printer graphics, and stores the URL
  on `app_settings.logo_url`.
* **Printers → a printer → badge design** offers the logo option *only* when a
  mark has been uploaded. Otherwise it says where to upload one. The option is
  now called "Organization name mark", because "Built-in" stopped being true.
* **The QR code** draws the organization's mark, or none. It requests the image
  with `crossOrigin` set — without that the canvas is tainted and both Download
  PNG and Print label throw.
* **The bridge** resolves `logo_url` from the config the same way it resolves a
  per-printer graphic, through the same on-disk cache.

## The fallback that is deliberately absent

A printer set to "logo" whose mark cannot be fetched prints its **header text**,
not a bundled image. Printing the wrong congregation's mark is worse than
printing none — and only one of those gets noticed. `bridge/test_badge_template.py`
covers every combination and asserts no logo ships with the bridge.

## Removed

`bridge/assets/shir-hadash-logo.png` and `app/src/assets/shir-hadash-logo.png`.
The source artwork stays in `Artwork/`.
