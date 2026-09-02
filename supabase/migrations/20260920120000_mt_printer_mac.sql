-- ============================================================================
-- A printer's MAC, which is the only part of it that does not move
--
-- The printer record has always been keyed on its IP address, and the IP is
-- the least durable thing about it. A DHCP lease expires, a printer is carried
-- to a different site, someone joins it to a new network from the front panel
-- — and the record now points at nothing, with no way to tell the device that
-- reappeared from a new one.
--
-- The MAC survives all of that, and the bridge can already find a printer by
-- it: Brother derives its mDNS name from the MAC, so a known MAC is usually
-- one lookup rather than a scan. The wizard has relied on this for the WiFi
-- cutover since the beginning; it just threw the value away afterwards.
--
-- Two columns because there are two interfaces and the name differs by which
-- one answers — BRW+MAC on wireless, BRN+MAC on wired. A printer moved to a
-- site and plugged into Ethernet is found by the wired one; a printer whose
-- lease expired on WiFi is found by the wireless one. Storing one and not the
-- other silently fails in whichever case is not covered.
--
-- Additive. Existing printers keep a null MAC until the bridge learns it:
-- the heartbeat now reads the MAC of any reachable printer that has none, so
-- they fill in on their own without anyone visiting a site.
-- ============================================================================

alter table public.printers
  --: The wireless interface's MAC. Answers to BRW + this value over mDNS.
  add column if not exists mac text,
  --: The wired interface's MAC. Answers to BRN + this value over mDNS.
  add column if not exists wired_mac text;

comment on column public.printers.mac is
  'Wireless MAC. The printer answers to BRW<mac>.local, so this is how it is '
  'found again after a DHCP lease changes its address. Filled in by the '
  'bridge on the first heartbeat where the printer is reachable.';

comment on column public.printers.wired_mac is
  'Wired MAC, answering to BRN<mac>.local. Kept separately from mac because '
  'the mDNS name depends on which interface answers, so a printer on Ethernet '
  'cannot be found by its wireless MAC.';

-- Deliberately no unique constraint on (org_id, mac). The same printer added
-- twice is exactly what this data will expose, and finding out by having a
-- migration fail on existing rows would be the wrong way round. Look first:
select org_id, mac, count(*)
  from public.printers
 where mac is not null
 group by org_id, mac
having count(*) > 1;

select id, name, printer_ip, mac, wired_mac
  from public.printers
 order by created_at;
