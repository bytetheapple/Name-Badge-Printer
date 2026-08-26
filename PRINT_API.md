# Name Badge Print API

This document describes how an external application can print name badges on a
shared Brother QL-820NWB label printer, via a hosted print service. It is written
to be self-contained for another developer or AI agent integrating against it.

## How it works

The print service is an HTTP endpoint backed by a small on-site "print bridge"
(a Raspberry Pi on the same network as the printer). You **POST a print request**;
it is queued, and the bridge picks it up within a couple of seconds and prints the
badge. **The API is asynchronous**: it returns immediately with a `job_id`, and you
can optionally poll for the job's status.

You do **not** need any database credentials or printer/network access — just the
endpoint URL and an API key, both provided by the service operator.

- **Base URL:** `https://xesgdkwwhszdtcgcdjjw.supabase.co/functions/v1/print-badge`
- **Method:** `POST` (JSON body)
- **Auth:** header `x-api-key: <API_KEY>` on every request
- **CORS:** enabled (callable from a browser or a server)

Your key is scoped to **one organization**. It can list and print to that
organization's printers and read the status of jobs it created — nothing else,
and nothing belonging to anyone else. Keys are issued in the admin under
**Integrations → Print API**, shown once, and can be revoked at any time
without affecting any other key.

The badge's visual design — label size, fonts, header logo — is managed centrally
by the service operator. Your app only supplies the **name** (and, optionally,
**pronouns**); the badge renders as a large first name over a smaller last name,
with pronouns smaller still beneath.

## Quick start

Queue a badge:

```bash
curl -X POST "https://xesgdkwwhszdtcgcdjjw.supabase.co/functions/v1/print-badge" \
  -H "x-api-key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"first_name":"Sarah","last_name":"Goldberg"}'
```

Response:

```json
{ "ok": true, "job_id": "f43c00b9-...-41213f3c120a", "status": "queued" }
```

The badge prints within a few seconds. That's the whole happy path.

## Endpoints (actions)

All requests are `POST` with `x-api-key` and a JSON body. The action is selected by
the `action` field (default = print a badge).

### 1. Print a badge (default)

| Field                 | Type   | Required | Notes                                                    |
|-----------------------|--------|----------|----------------------------------------------------------|
| `first_name`          | string | yes      | Printed large.                                           |
| `last_name`           | string | no       | Printed smaller beneath the first name.                  |
| `pronouns`            | string | no       | Printed smaller still, beneath the name. Omit and no pronouns line is shown. Max 40 chars. |
| `printer`             | string | no       | Printer **name** or **id** (see below). Omit for default.|
| `header_image_base64` | string | no       | Custom header graphic for this badge (see [Custom header](#custom-header-graphic)). Omit to use the printer's configured header. |

Body:
```json
{ "first_name": "Sarah", "last_name": "Goldberg", "printer": "Lobby" }
```

`pronouns` is entirely optional and backward-compatible: requests that don't send
it print exactly as before, with no pronouns line. To include them, add the field:
```json
{ "first_name": "Sarah", "last_name": "Goldberg", "pronouns": "she/her" }
```
Success:
```json
{ "ok": true, "job_id": "<uuid>", "status": "queued" }
```

#### Custom header graphic

Every badge shows a header graphic at the top. By default it's whatever the target
printer is configured with (managed by the operator) — you don't need to send
anything. To override the header **for a single badge**, send `header_image_base64`:

```json
{ "first_name": "Sarah", "header_image_base64": "iVBORw0KGgoAAAANSUhEUg..." }
```

- **Value:** base64 of a **PNG or JPEG** (transparent **PNG strongly preferred** —
  see "Black & white" below). A `data:` URI prefix (`data:image/png;base64,...`)
  is accepted and stripped automatically.
- **Shape — use a WIDE, landscape graphic, not a square.** The header sits in a
  short horizontal band across the top of the badge — roughly **28% of the badge
  height by the full badge width**, about **4:1 (width:height)**. The image is
  scaled to fit that band with its aspect ratio preserved (never cropped or
  stretched); whichever dimension fills first limits the size.
  - **Recommended:** a **transparent PNG, ~1200 × 300 px** (a 4:1 banner).
    Anything from about 3:1 to 5:1 looks good.
  - A near-square image (e.g. 1000 × 1000) is *not rejected*, but it will be
    shrunk until its height fits the thin band and end up **small and centered
    with large empty margins** — usually not what you want.
- **File size:** up to **2 MB** of encoded image.
- **Precedence:** per-job header (this field) → the printer's configured header →
  the bundled default logo.
- **Backward-compatible:** omit it and the badge prints with the printer's header
  exactly as before. Re-sending the same image on every request is fine — it's
  de-duplicated server-side, so nothing piles up.

##### Black & white — design in monochrome

The label printer is a **monochrome thermal printer**. It prints only pure black
on the white label — there are **no grays, no halftones, and no color.** Whatever
you send is flattened to 1-bit black/white before printing, so **design the
artwork in black and white from the start** rather than sending color and hoping
it converts well.

How the flattening works (so you can predict the result exactly):

1. The image is converted to grayscale (by brightness).
2. Each pixel is then forced to **either solid black or nothing** using a fixed
   brightness cutoff: **pixels darker than roughly 30% brightness print black;
   everything lighter (including most mid-tone colors) drops out to blank.**
   There is no dithering — a pixel is never "partly" printed.

What this means for your artwork:

- **Use solid black (or near-black) shapes.** `#000000` on transparent is ideal.
- **Avoid** light or mid-tone colors (yellow, orange, light blue, medium red,
  etc.), gradients, thin light strokes, drop shadows, and glows — they fall on the
  light side of the cutoff and **print faint or disappear entirely.**
- **A full-color logo is accepted but not recommended:** only its darkest parts
  will survive, so a vibrant color header can come out mostly blank. If you have a
  color brand logo, supply a **black silhouette / monochrome version** of it for
  the badge.

##### Use a transparent PNG, not a JPEG

Only PNG supports transparency, and transparency matters here: the header is
**composited onto the badge using its alpha channel**, so a transparent PNG places
just your artwork and lets the white label show through around it.

A **JPEG has no transparency**, so its *entire rectangle — including the
background — is placed on the badge.* A JPEG only looks right if its background is
**pure white**; any colored or dark background will print as a solid block behind
the header. When in doubt, send a **transparent-background PNG** with black
artwork and you never have to think about this.

### 2. Check a job's status

```json
{ "action": "status", "job_id": "<uuid>" }
```
Response:
```json
{ "ok": true, "status": "printed", "error": null }
```
`status` is one of: `queued`, `printing`, `printed`, `failed`. On `failed`, `error`
holds a message. (If the bridge or printer is offline, the job stays `queued`.)

### 3. List available printers

```json
{ "action": "printers" }
```
Response:
```json
{ "ok": true, "printers": [ { "id": "<uuid>", "name": "Main Printer", "location": "Lobby" } ] }
```

## Choosing a printer

Simplest: **omit `printer`** to use the default (first) printer, or pass the
printer's **name** exactly as configured in the badge app's admin (case-insensitive,
e.g. `"Main Printer"`). That's all most callers need.

The `printer` field accepts either:
- a printer **name** — human-friendly, recommended; or
- a printer **id** — a stable UUID (only useful if a printer might be renamed).

You don't need to know ids in advance — the **`printers` action** lists them:
`{ "action": "printers" }` returns `{ printers: [{ id, name, location }] }`. Use
whichever field you prefer. A non-matching name/id returns
`400 { "ok": false, "error": "No matching printer ..." }`.

## Errors

Errors return `{ "ok": false, "error": "<message>" }` with an HTTP status:

| Status | Meaning                                             |
|--------|-----------------------------------------------------|
| 401    | Missing, wrong, or revoked `x-api-key`.              |
| 400    | Bad input (e.g. missing `first_name`, bad printer).  |
| 404    | `status` action: job not found.                      |
| 500    | Server-side failure queuing the job.                 |

A printer id belonging to a different organization behaves exactly like one that
does not exist — a `400`, never a print on someone else's label roll.

A `200` with `ok: true` means the job was **queued** — not yet printed. Poll the
`status` action if you need printing confirmation.

## Examples

**JavaScript (fetch):**
```js
const res = await fetch(
  'https://xesgdkwwhszdtcgcdjjw.supabase.co/functions/v1/print-badge',
  {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Sarah', last_name: 'Goldberg' }),
  },
)
const { job_id } = await res.json()
```

**Python (requests):**
```python
import requests
r = requests.post(
    "https://xesgdkwwhszdtcgcdjjw.supabase.co/functions/v1/print-badge",
    headers={"x-api-key": API_KEY},
    json={"first_name": "Sarah", "last_name": "Goldberg"},
)
print(r.json())
```

## Notes and limits

- **Asynchronous / fire-and-forget:** queuing is instant; the badge prints shortly
  after. Polling status is optional.
- **Availability:** printing requires the on-site bridge and printer to be powered
  and online. If they're down, jobs queue and print when they come back.
- **No rate limit is enforced** — be reasonable; one job per badge.
- **Design is fixed by the operator.** You supply the name only.

## What the operator must give you

1. This endpoint URL (above).
2. The **API key** value (kept out of this document; request it from the operator).
