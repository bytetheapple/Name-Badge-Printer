# Hardware Bring-Up Checklist

Everything in `bridge/` is already written and committed. This is the day-of
checklist to get it running on the real Raspberry Pi + Brother QL-820NWB.

You'll need: the Pi, the printer with a DK label roll loaded, your Wi-Fi
credentials, and your Supabase **service_role** key
(Supabase Dashboard → Project Settings → API → `service_role`, secret).

---

## 1. Printer on the network

- [ ] Load the label roll (e.g. 62 mm continuous DK-2205) and close the cover.
- [ ] Power on the printer.
- [ ] Join it to the **same Wi-Fi network as the Pi** (printer LCD → WLAN setup,
      or the Brother iPrint&Label app). Not a guest network — the Pi must be able
      to reach it directly.
- [ ] Find the printer's **IP address** (printer LCD → WLAN → status, or your
      router's device list).
- [ ] In your router, set a **DHCP reservation / static IP** for the printer so
      the address never changes. Write it down: `__________________`.

> Alternative: the printer can be plugged into the Pi over **USB** instead of
> Wi-Fi, but the bridge currently uses the network backend. Tell me if you want
> USB and it's a one-line change in `printer.py`.

## 2. Raspberry Pi OS

- [ ] Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In the
      Imager settings, pre-set: hostname, **enable SSH**, username/password, and
      **Wi-Fi** (same network as the printer).
- [ ] Boot the Pi, then from your Mac: `ssh <user>@<hostname>.local`
- [ ] Update the OS:
      ```bash
      sudo apt update && sudo apt full-upgrade -y
      ```
- [ ] Install prerequisites (including the DejaVu font the badge uses — Lite
      doesn't ship it):
      ```bash
      sudo apt install -y git python3-venv fonts-dejavu
      ```

## 3. Install the bridge

- [ ] Clone the repo:
      ```bash
      git clone https://github.com/bytetheapple/Name-Badge-Printer.git ~/name-badge-printer
      ```
- [ ] Install dependencies (creates the virtualenv):
      ```bash
      cd ~/name-badge-printer/bridge
      ./scripts/install.sh
      ```
- [ ] Create the env file and add your service_role key:
      ```bash
      cp .env.example .env
      nano .env      # set SUPABASE_SERVICE_ROLE_KEY (SUPABASE_URL is prefilled)
      ```

## 4. Set the printer IP in the app

- [ ] In the admin console → **Printer** tab you'll see the seeded **Main
      Printer** (rename it if you like). Set its **IP address** and **port**
      (9100), then **Save**. Add more printers here if you have them. The bridge
      reads this from Supabase — no need to hard-code anything on the Pi.

## 5. First run (foreground, watch the logs)

- [ ] Start the bridge manually:
      ```bash
      cd ~/name-badge-printer/bridge
      ./venv/bin/python bridge.py
      ```
- [ ] In the admin **Status** page, confirm within ~15s:
      - **Bridge: Online**
      - your printer shows **Reachable** (+ media type/width)
- [ ] Click the printer's **Test print** button. A test badge should come out.

## 6. Dial-in (the physical tweaks)

- [ ] **Orientation** — if the text is upside-down, go to admin → **Printer** →
      **Badge layout** → **Print orientation** and switch to *Flipped (270°)*,
      Save, then re-run a test print.
- [ ] **Size / length** — if the badge is too long/short, set **Badge length
      (mm)** in the same Badge layout section.
- [ ] **Media** — make sure the Printer tab's label media matches the roll you
      loaded.
- [ ] Print a **real badge**: submit from the form (or Reprint an entry) and
      check name sizing looks right on the actual label.

> The bridge picks up config changes within a few seconds — no restart needed.

## 7. Make it run on boot (systemd)

- [ ] Edit `systemd/name-badge-bridge.service` — set `User=` and the two paths to
      match your Pi username and clone location.
- [ ] Install and start it:
      ```bash
      sudo cp systemd/name-badge-bridge.service /etc/systemd/system/
      sudo systemctl daemon-reload
      sudo systemctl enable --now name-badge-bridge
      ```
- [ ] Watch it live:
      ```bash
      journalctl -u name-badge-bridge -f
      ```
- [ ] **Reboot test**: `sudo reboot`, wait, and confirm the Status page shows
      **Bridge: Online** again on its own.

## 8. Go live

- [ ] From the production site, open `/admin/qr`, **choose the printer**,
      **Download PNG**, print it, and post it by that printer.
- [ ] Full end-to-end: scan the QR on a phone → fill the form → badge prints, and
      the entry appears in the admin table (and Google, for visitors).

---

## Quick troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Bridge stays "Never connected" | `.env` missing/wrong service_role key; check `journalctl` |
| Printer "Not reachable" | Wrong IP in Printer tab, or Pi and printer on different networks |
| Job stuck `queued` | Bridge not running; start it / check the service |
| Job `failed` | Read the error in the Status page's recent-jobs table |
| Blank/garbled text | DejaVu font missing — `sudo apt install -y fonts-dejavu` |
| Text rotated wrong | Admin → Printer → Badge layout → Print orientation → Flipped |
| Badge wrong length | Admin → Printer → Badge layout → Badge length (mm) |
