-- ============================================================================
-- A printer's header is one of three things, and the UI has to be able to say
-- which
--
-- There were only ever two per-printer states available: an uploaded image
-- (`header_image_url`) or nothing. But a third has been in use all along — the
-- logo bundled with the bridge, selected by the org-wide
-- `badge_template.header_image` holding a bare filename, which badge.py
-- resolves inside bridge/assets/.
--
-- With no way to represent that per printer, the admin showed "Text" for a
-- printer that was in fact printing the bundled logo. This makes the choice
-- explicit.
--
-- Backfilled from the state each printer is actually in, so nothing changes.
-- ============================================================================

alter table public.printers
  add column if not exists badge_header_mode text
    check (badge_header_mode in ('text', 'logo', 'image'));

update public.printers p
set badge_header_mode = case
      -- An uploaded image is unambiguous.
      when p.header_image_url is not null and p.header_image_url <> '' then 'image'
      -- Otherwise the org template decides, which is where this lived before.
      when nullif(c.badge_template ->> 'header_image', '') is not null then 'logo'
      else 'text'
    end
from public.printer_config c
where c.org_id = p.org_id
  and p.badge_header_mode is null;

-- Any printer with no config row to consult.
update public.printers
set badge_header_mode = case
      when header_image_url is not null and header_image_url <> '' then 'image'
      else 'text'
    end
where badge_header_mode is null;

alter table public.printers alter column badge_header_mode set default 'text';
alter table public.printers alter column badge_header_mode set not null;
