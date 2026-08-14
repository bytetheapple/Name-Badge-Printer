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

The badge's visual design — label size, fonts, header logo — is managed centrally
by the service operator. Your app only supplies the **name**; the badge renders as
a large first name over a smaller last name.

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

| Field        | Type   | Required | Notes                                                    |
|--------------|--------|----------|----------------------------------------------------------|
| `first_name` | string | yes      | Printed large.                                           |
| `last_name`  | string | no       | Printed smaller beneath the first name.                  |
| `printer`    | string | no       | Printer **name** or **id** (see below). Omit for default.|

Body:
```json
{ "first_name": "Sarah", "last_name": "Goldberg", "printer": "Lobby" }
```
Success:
```json
{ "ok": true, "job_id": "<uuid>", "status": "queued" }
```

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
| 401    | Missing or wrong `x-api-key`.                        |
| 400    | Bad input (e.g. missing `first_name`, bad printer).  |
| 404    | `status` action: job not found.                      |
| 500    | Server-side failure queuing the job.                 |

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
