-- A printer's serial number: the one identity that survives a DHCP move to
-- another subnet.
--
-- Recovery matched a moved printer by its MAC read from ARP, which only holds
-- for a device on the print server's own subnet -- so a server on an Ethernet
-- drop and a printer on WiFi, on different (but routed) subnets, could not be
-- matched even though the server could reach and print to it. The serial is
-- read from the printer's Maintenance Information page over plain HTTP, which
-- routes across subnets and needs no login, so it works wherever printing does.
--
-- Filled in by the bridge the first time a printer answers, the same way the
-- MAC is, so existing printers acquire it without anyone doing anything.
alter table public.printers
  add column if not exists serial text;

comment on column public.printers.serial is
  'Printer serial, read over HTTP from the Maintenance Information page. Stable across DHCP and subnet changes; used to re-find a printer whose address moved.';
