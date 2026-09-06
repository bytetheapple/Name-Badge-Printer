import { useCallback, useEffect, useState } from 'react'
import { invokeFn } from '../../lib/functions'

/**
 * How an event is going, on its card.
 *
 * The same three numbers the spreadsheet's own Dashboard tab shows, read from
 * that tab's cells rather than recomputed here. Sheets does the counting, so
 * this fetches three values instead of the guest list — which for a large
 * event is the difference between three cells and ten thousand every time
 * somebody looks at this page.
 *
 * There is a Refresh because these move during an event and nothing here
 * would otherwise know. Not polled: a page left open on a desk would spend
 * the afternoon asking Google a question nobody is reading the answer to.
 */
export default function EventStats({ integrationId }: { integrationId: string }) {
  const [counts, setCounts] = useState<{
    registered: number
    signed_in: number
    onsite: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    const res = await invokeFn('event-stats', { integration_id: integrationId })
    setBusy(false)
    if (!res.ok) {
      setError((res.error as string) ?? 'Could not read the attendee list.')
      return
    }
    setError(null)
    setCounts({
      registered: Number(res.registered ?? 0),
      signed_in: Number(res.signed_in ?? 0),
      onsite: Number(res.onsite ?? 0),
    })
  }, [integrationId])

  useEffect(() => {
    void load()
  }, [load])

  // Nothing at all until the first read lands. A row of zeroes that turns into
  // real numbers a moment later is worse than a moment of nothing: somebody
  // reads the zeroes.
  if (!counts && !error) return null

  return (
    <div style={{ marginTop: 10 }}>
      {error ? (
        <p className="muted small">{error}</p>
      ) : (
        <div style={{ display: 'flex', gap: 24, alignItems: 'baseline', flexWrap: 'wrap' }}>
          {[
            ['Registered', counts!.registered],
            ['Signed in', counts!.signed_in],
            ['On-site', counts!.onsite],
          ].map(([label, value]) => (
            <div key={label as string}>
              <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
              <div className="muted small">{label}</div>
            </div>
          ))}
          <button
            type="button"
            className="linkish"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? 'Reading…' : 'Refresh'}
          </button>
        </div>
      )}
    </div>
  )
}
