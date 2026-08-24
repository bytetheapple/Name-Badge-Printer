"""Register the label sizes brother_ql does not ship.

**DK-1234 — the 60mm x 86mm die-cut name badge this product recommends and
prints on — is not among the media `brother_ql` knows.** The admin has offered
it as a choice all along, but selecting it broke printing in two different
ways:

* `badge.py` looked the size up, found nothing, and silently fell back to
  62mm-continuous geometry — so badges were laid out for the wrong media, which
  is why print alignment on DK-1234 has never been quite right.
* `printer.py` passed the identifier to `brother_ql`, which raised
  `KeyError: '60x86'` and failed the job outright.

Importing this module fixes both. `badge.py` and `printer.py` import it before
they touch any label table, so ordering is not left to chance.

The geometry follows the arithmetic of every spec the library ships: about
11.79–11.81 dots/mm at 300 dpi, with the printable area inset 36 dots across
the head and 70 along the feed.
"""
from brother_ql import labels as _labels
from brother_ql import devicedependent as _dd

#: Brother's name-badge die-cut, and the media this product standardises on.
DK_1234 = "60x86"

_TAPE = (60, 86)
_TOTAL = (708, 1014)        # 60 x 11.806, 86 x 11.790
_PRINTABLE = (672, 944)     # inset 36 across the head, 70 along the feed
_SOURCE = "62x100"          # same 62mm-class die-cut geometry


def _register_spec() -> None:
    """Add the entry `brother_ql.conversion.convert()` looks up."""
    specs = _dd.label_type_specs
    if DK_1234 in specs:
        return
    spec = dict(specs[_SOURCE])          # copy so enums and any new keys carry over
    spec.update(
        name="60mm x 86mm die-cut (DK-1234 name badge)",
        tape_size=_TAPE,
        dots_total=_TOTAL,
        dots_printable=_PRINTABLE,
    )
    specs[DK_1234] = spec


def _register_label() -> None:
    """Add the entry anything reading `ALL_LABELS` will see — `badge.py` does."""
    if any(l.identifier == DK_1234 for l in _labels.ALL_LABELS):
        return
    base = next(l for l in _labels.ALL_LABELS if l.identifier == _SOURCE)
    entry = _labels.Label(
        identifier=DK_1234,
        tape_size=_TAPE,
        form_factor=base.form_factor,
        dots_total=_TOTAL,
        dots_printable=_PRINTABLE,
        offset_r=base.offset_r,
        feed_margin=base.feed_margin,
        restricted_to_models=list(base.restricted_to_models),
        color=base.color,
    )
    # ALL_LABELS is a tuple, so it is replaced rather than appended to.
    _labels.ALL_LABELS = _labels.ALL_LABELS + (entry,)


def register() -> None:
    """Add the missing labels. Safe to call more than once."""
    _register_spec()
    _register_label()


register()
