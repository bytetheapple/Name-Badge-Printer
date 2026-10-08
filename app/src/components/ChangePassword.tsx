import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'

/** Set a new password for the signed-in user, in place (no email round-trip). */
export function ChangePassword({ onClose }: { onClose: () => void }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (error) {
      setError(error.message)
      return
    }
    setDone(true)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Change password</h2>
        {done ? (
          <>
            <p className="notice">Your password has been changed.</p>
            <div className="modal-actions">
              <button onClick={onClose}>Done</button>
            </div>
          </>
        ) : (
          <form onSubmit={onSubmit}>
            {error && <div className="error">{error}</div>}
            <label className="field">
              New password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Set password'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
