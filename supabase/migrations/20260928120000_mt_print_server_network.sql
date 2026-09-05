-- Which networks the print server is on, in its own words.
--
-- A print server reaches only the printers on a network it shares. At one
-- site the server sat on a wired 192.168.3.x drop and the printer on
-- 192.168.0.x WiFi with nothing routing between them; the app said "could
-- not find the printer" and there was no screen anywhere showing the two
-- addresses side by side. This is that screen's data.
--
-- Shape (written whole each heartbeat, never merged):
--   { "interfaces": [ { "name": "eth0", "kind": "wired" | "wifi" | "unknown",
--                       "state": "connected", "ip": "192.168.3.113",
--                       "ssid": "…", "signal": 72 } ],
--     "wifi_radio": "enabled" | "disabled" | null }
--
-- No passphrase, ever: an SSID is the name of a network and is broadcast to
-- anyone in the building, but what gets you onto it is not stored here or
-- anywhere else on this row.
alter table public.printer_status
  add column if not exists network jsonb;

comment on column public.printer_status.network is
  'Interfaces the print server reports itself on: names, kinds, addresses, and the SSID where wireless. Never a passphrase.';
