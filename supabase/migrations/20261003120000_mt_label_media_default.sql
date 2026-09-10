-- The default label stock is the one the product tells customers to buy.
--
-- The Printers tab says "Badges print on Brother DK-1234 die-cut name-badge
-- labels (60 x 86 mm)". The column that decides how a badge is rasterised
-- defaulted to '62' -- a 62 mm continuous roll -- and nothing in the console
-- can change it. So a new organization that bought exactly what it was told
-- to got a job sized for a different roll: 90 mm of print on an 86 mm label,
-- cut past the edge, and a blank label fed out behind every badge.
--
-- Existing rows are left alone. Only Temple Beth El was on '62' with die-cut
-- stock, and that was corrected by hand; the demo server may genuinely be on
-- a continuous roll. A default is for what comes next.
alter table public.printer_config
  alter column label_media set default '60x86';

comment on column public.printer_config.label_media is
  'brother_ql label identifier. 60x86 is DK-1234, the stock the product recommends; 62 is a 62 mm continuous roll.';
