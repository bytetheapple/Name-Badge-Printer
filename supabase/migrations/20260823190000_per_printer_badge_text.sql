-- ============================================================================
-- Badge header and footer text move from the organization to the printer
--
-- They lived in printer_config.badge_template, one setting for every printer in
-- an org. But the text on a badge is a property of where the badge is printed —
-- a lobby desk and a social hall may well want different wording — and the
-- header *graphic* was already per printer, so the two halves of the same
-- decision sat in different places.
--
-- Existing values are copied down from the org so nothing changes visibly.
-- Additive and idempotent.
-- ============================================================================

alter table public.printers
  add column if not exists badge_header   text,
  add column if not exists badge_subtitle text;

-- Carry the org-wide wording down to each printer that has none of its own.
update public.printers p
set badge_header = coalesce(
      p.badge_header,
      nullif(c.badge_template ->> 'header', ''),
      'WELCOME'
    ),
    badge_subtitle = coalesce(
      p.badge_subtitle,
      nullif(c.badge_template ->> 'subtitle', ''),
      ''
    )
from public.printer_config c
where c.org_id = p.org_id
  and (p.badge_header is null or p.badge_subtitle is null);

-- A printer added later should still get sensible wording rather than a blank
-- badge, so the columns carry defaults from here on.
alter table public.printers alter column badge_header   set default 'WELCOME';
alter table public.printers alter column badge_subtitle set default '';
