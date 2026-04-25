import { useState } from 'react'
import { Send, Loader2, Save, Play, ExternalLink } from 'lucide-react'
import useStore from '@/store/useStore'
import { useSpotify } from '@/hooks/useSpotify'
import { getPlaylistParams } from '@/lib/claude'
import { searchArtists, searchTracks, getArtistTopTracks, getMe, createPlaylist, addTracksToPlaylist } from '@/lib/spotify'
import TrackCard from '@/components/Playlist/TrackCard'
import LastfmImport from '@/components/Dashboard/LastfmImport'

const EXAMPLE_PROMPTS = [
  'Build me a hype playlist for my Saturday morning run',
  'Chill music for cooking dinner on a weeknight',
  'I want something like Frank Ocean but more upbeat',
  'Late night drive through the city vibes',
  'Focus music with no lyrics for deep work',
]

export default function DiscoverPage() {
  const { tasteProfile, spotifyUser, lastfmUsername } = useStore()
  const { getToken } = useSpotify()
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [playlist, setPlaylist] = useState(null)
  const [error, setError] = useState(null)
  const [savedUrl, setSavedUrl] = useState(null)

  async function generate(text) {
    if (!text.trim()) return
    setLoading(true)
    setError(null)
    setPlaylist(null)
    setSavedUrl(null)

    try {
      const profile = { ...tasteProfile, lastfmUsername }
      const params = await getPlaylistParams(text, profile)
      const token = await getToken()
      if (!token) throw new Error('Not authenticated')

      const seenIds = new Set()
      const tracks = []

      function addTracks(items) {
        for (const t of items) {
          if (t?.id && !seenIds.has(t.id)) {
            seenIds.add(t.id)
            tracks.push(t)
          }
        }
      }

      // 1. Resolve artist names → IDs → top tracks
      const artistNames = params.artistNames ?? []
      await Promise.all(
        artistNames.slice(0, 6).map(async (name) => {
          try {
            const res = await searchArtists(token, name, 1)
            const artist = res?.artists?.items?.[0]
            if (!artist) return
            const top = await getArtistTopTracks(token, artist.id)
            addTracks((top?.tracks ?? []).slice(0, 4))
          } catch {}
        })
      )

      // 2. Run search queries for additional variety
      const queries = params.searchQueries ?? []
      await Promise.all(
        queries.slice(0, 4).map(async (q) => {
          try {
            const res = await searchTracks(token, q, 5)
            addTracks(res?.tracks?.items ?? [])
          } catch {}
        })
      )

      if (tracks.length === 0) {
        throw new Error('No tracks found — try rephrasing your prompt.')
      }

      // Shuffle and cap at 20
      const shuffled = tracks.sort(() => Math.random() - 0.5).slice(0, 20)

      setPlaylist({
        name: params.playlistName || text,
        description: params.description || '',
        tracks: shuffled,
      })
    } catch (err) {
      setError(err.message || 'Something went wrong. Try a different prompt.')
    } finally {
      setLoading(false)
    }
  }

  async function saveToSpotify() {
    if (!playlist) return
    setSaving(true)
    try {
      const token = await getToken()
      // Ensure we have the user's Spotify ID before creating the playlist
      let userId = spotifyUser?.id
      if (!userId) {
        const me = await getMe(token)
        userId = me.id
        useStore.getState().setSpotifyUser(me)
      }
      const pl = await createPlaylist(token, userId, playlist.name, playlist.description)
      const uris = playlist.tracks.map((t) => t.uri)
      await addTracksToPlaylist(token, pl.id, uris)
      setSavedUrl(pl.external_urls?.spotify)
    } catch (err) {
      setError('Failed to save playlist: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  function handleSubmit(e) {
    e.preventDefault()
    generate(prompt)
  }

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-black mb-1">Discover</h1>
        <p className="text-text-secondary">Describe what you want to hear in plain English.</p>
      </div>

      {/* Last.fm import prompt */}
      {!lastfmUsername && <LastfmImport />}

      {/* Prompt input */}
      <form onSubmit={handleSubmit} className="relative">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="What do you want to listen to?"
          className="input-base pr-14 text-base py-4"
          disabled={loading}
        />
        <button
          type="submit"
          disabled={loading || !prompt.trim()}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg bg-accent hover:bg-accent-hover disabled:opacity-50 flex items-center justify-center transition-all"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 text-black animate-spin" />
          ) : (
            <Send className="w-4 h-4 text-black" />
          )}
        </button>
      </form>

      {/* Example prompts */}
      {!playlist && !loading && (
        <div className="space-y-2">
          <p className="text-xs text-text-muted uppercase tracking-widest font-semibold">Try asking for</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                onClick={() => { setPrompt(p); generate(p) }}
                className="tag hover:border-accent/50 hover:text-text-primary transition-colors cursor-pointer"
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="card flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
          <div>
            <p className="font-medium">Building your playlist</p>
            <p className="text-sm text-text-secondary">Claude is translating your vibe into music…</p>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="card border-red-500/20 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Playlist result */}
      {playlist && !loading && (
        <div className="space-y-4 animate-slide-up">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold">{playlist.name}</h2>
              {playlist.description && (
                <p className="text-text-secondary text-sm mt-1">{playlist.description}</p>
              )}
              <p className="text-text-muted text-xs mt-1">{playlist.tracks.length} tracks</p>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              {savedUrl ? (
                <a
                  href={savedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary flex items-center gap-2 text-sm"
                >
                  <ExternalLink className="w-4 h-4" />
                  Open in Spotify
                </a>
              ) : (
                <button
                  onClick={saveToSpotify}
                  disabled={saving}
                  className="btn-primary flex items-center gap-2 text-sm"
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Save className="w-4 h-4" />
                  )}
                  Save to Spotify
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            {playlist.tracks.map((track, i) => (
              <TrackCard key={track.id} track={track} index={i} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
