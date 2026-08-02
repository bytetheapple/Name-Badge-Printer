# Name Badge Printer

New-member name badge printer for Shir Hadash.

A visitor scans a QR code posted by the printer, fills out a short form (name,
phone, email), and taps **Print**. A Brother QL-820NWB label printer on the local
network prints their badge. An admin console lets staff configure the printer,
review/export submissions, monitor printer status, and send test prints. Each
submission is also pushed into an existing Google Form.

See **[DESIGN.md](DESIGN.md)** for the full architecture and feature design.

## Repository layout

```
app/         React + Vite frontend (public form + admin console) — deploys to Vercel
supabase/    Postgres migrations + Edge Functions (added in Phase 1)
bridge/      Python print bridge that runs on a Raspberry Pi (added in Phase 2)
scripts/     Helper shell scripts wrapping CLI commands
DESIGN.md    Architecture and feature design
```

## Tech stack

- **Frontend:** React + Vite (TypeScript), hosted on Vercel
- **Backend:** Supabase (Postgres, Auth, Realtime, Edge Functions)
- **Print bridge:** Python (`brother_ql` + `Pillow`) on a Raspberry Pi, on the
  printer's LAN

## Local development

```bash
cd app
cp .env.example .env.local   # fill in your Supabase URL + anon key
npm install
npm run dev
```

The home page shows a live Supabase connection banner so you can confirm the
frontend is wired to your project.

## Build sequence

Work is staged in phases — see [DESIGN.md](DESIGN.md) section 11. Currently at
**Phase 0 (scaffolding)**.
