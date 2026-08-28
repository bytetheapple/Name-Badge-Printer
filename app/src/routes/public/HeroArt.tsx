/**
 * The hero illustration: a phone with the sign-in form, and the badge it
 * produces.
 *
 * Drawn rather than photographed, and inline rather than a file. A photograph
 * would be of someone else's lobby; this is the actual output — a DK-1234
 * badge is 86 × 60 mm, and the card below is drawn at that ratio, so what a
 * visitor sees on the page is the shape of the thing they will be handed.
 *
 * Inline SVG so it themes with the page (no second asset to keep in step with
 * the palette), scales to any width without a bitmap, and costs no request on
 * a page whose whole job is loading fast for someone deciding whether to care.
 *
 * The badge stays white in dark mode on purpose: it is printed on white stock,
 * and a dark badge would be a picture of something that cannot exist.
 */
export default function HeroArt() {
  return (
    <svg
      className="mk-art"
      viewBox="0 0 520 380"
      role="img"
      aria-label="A phone showing the sign-in form, and the printed name badge it produces"
    >
      {/* soft ground so the composition has somewhere to sit */}
      <ellipse cx="270" cy="342" rx="210" ry="20" className="mk-art-shadow" />

      {/* ---------------- the phone ---------------- */}
      <g transform="rotate(-7 92 190)">
        <rect x="28" y="62" width="128" height="252" rx="18" className="mk-art-phone" />
        <rect x="36" y="70" width="112" height="236" rx="12" className="mk-art-screen" />
        {/* the form */}
        <rect x="48" y="86" width="42" height="6" rx="3" className="mk-art-muted" />
        <text x="48" y="122" className="mk-art-h">
          Welcome
        </text>
        <rect x="48" y="136" width="88" height="5" rx="2.5" className="mk-art-muted" />
        <rect x="48" y="158" width="88" height="26" rx="6" className="mk-art-field" />
        <text x="56" y="176" className="mk-art-typed">
          Miriam
        </text>
        <rect x="48" y="196" width="88" height="26" rx="6" className="mk-art-field" />
        <rect x="56" y="206" width="46" height="6" rx="3" className="mk-art-muted" />
        <rect x="48" y="238" width="88" height="28" rx="8" className="mk-art-btn" />
        <text x="92" y="256" className="mk-art-btn-label" textAnchor="middle">
          Print my badge
        </text>
      </g>

      {/* ---------------- the badge ---------------- */}
      <g transform="rotate(3 330 216)">
        {/* 86 × 60 mm, drawn to scale */}
        <rect x="186" y="118" width="288" height="201" rx="12" className="mk-art-badge" />
        {/* the congregation's name mark */}
        <circle cx="222" cy="152" r="10" className="mk-art-mark" />
        <rect x="240" y="147" width="74" height="9" rx="4.5" className="mk-art-mark-bar" />
        <line x1="212" y1="176" x2="448" y2="176" className="mk-art-rule" />
        <text x="330" y="236" className="mk-art-name" textAnchor="middle">
          Miriam
        </text>
        <text x="330" y="268" className="mk-art-sub" textAnchor="middle">
          Congregation Beth Shalom
        </text>
        <text x="330" y="296" className="mk-art-pronoun" textAnchor="middle">
          she / her
        </text>
      </g>
    </svg>
  )
}
