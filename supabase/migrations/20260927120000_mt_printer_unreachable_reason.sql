-- Why a printer is unreachable, in the print server's own words.
--
-- "Unreachable" is true and useless. The bridge knows its own address and
-- whether a route to the printer exists; at Temple Beth El the print server
-- sat on a wired 192.168.3.x drop while the printer was on 192.168.0.x WiFi,
-- with no route between them, and nothing in the product said so. Entering
-- the address by hand failed the same silent way, because the bridge is the
-- only thing that can reach a printer and it still could not.
--
-- Written every heartbeat alongside `reachable`, and cleared to null the
-- moment the printer answers: a stale explanation on a printer that has since
-- come back is worse than none.
alter table public.printers
  add column if not exists unreachable_reason text;

comment on column public.printers.unreachable_reason is
  'Operator-facing explanation of why the bridge could not reach this printer; null when reachable or undiagnosed.';
