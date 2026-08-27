/**
 * The people who run the service, as opposed to the people who use it.
 *
 * Deliberately empty until the database can answer the question. `platform_admins`
 * grants `authenticated` nothing but SELECT, and its only policy is "read your
 * own row" — which exists so the table cannot become a list of who to attack.
 * A page built on that today could show you yourself and nobody else, which
 * would look like an answer while being a guess.
 *
 * Step 2 adds a SECURITY DEFINER `list_operators()` alongside add and remove,
 * mirroring how `org_members()` already reaches auth.users for the Members tab.
 */
export default function Operators() {
  return (
    <>
      <h1>Operators</h1>
      <p className="muted small">
        Guest Badges staff, who can reach every customer's organization. Separate from a
        customer's own Members tab, and never listed there.
      </p>

      <section className="card" style={{ marginTop: 20 }}>
        <h2>Not built yet</h2>
        <p className="muted small">
          Operators are added and removed in the Supabase SQL editor for now, by inserting into{' '}
          <code>platform_admins</code>. The table is readable only one row at a time — your own —
          so there is no honest list to show here until the supporting functions exist.
        </p>
        <p className="muted small">
          Coming with it: a role for each operator, so that someone who does support is not
          automatically someone who can delete a congregation.
        </p>
      </section>
    </>
  )
}
