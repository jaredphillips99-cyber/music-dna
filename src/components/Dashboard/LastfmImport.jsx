import { useState } from 'react'
import { Loader2, Music2, ChevronRight } from 'lucide-react'
import useStore from '@/store/useStore'
import { importUserData } from '@/lib/lastfm'

export default function LastfmImport() {
  const { setLastfmUsername, setLastfmData } = useStore()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null

  async function handleImport(e) {
    e.preventDefault()
    if (!input.trim()) return
    setLoading(true)
    setError(null)
    try {
      const data = await importUserData(input.trim())
      setLastfmUsername(input.trim())
      setLastfmData(data)
    } catch {
      setError('Could not find that Last.fm username. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card border-purple-brand/20 bg-purple-brand/5">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-xl bg-purple-brand/20 flex items-center justify-center flex-shrink-0">
          <Music2 className="w-4 h-4 text-purple-light" />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-sm mb-1">Import Last.fm history</p>
          <p className="text-xs text-text-secondary mb-3">
            Add your Last.fm username to enrich recommendations with your real listening history.
          </p>
          <form onSubmit={handleImport} className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="your-lastfm-username"
              className="input-base text-sm py-2 flex-1"
              disabled={loading}
            />
            <button type="submit" disabled={loading || !input.trim()} className="btn-primary text-sm py-2 px-4 flex items-center gap-1">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
            </button>
          </form>
          {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        </div>
        <button onClick={() => setDismissed(true)} className="text-text-muted hover:text-text-secondary text-xs">
          Skip
        </button>
      </div>
    </div>
  )
}
