import { useState } from 'react'
import { Send, Loader2, Save, ExternalLink, RefreshCw } from 'lucide-react'
import useStore from '@/store/useStore'
import { useSpotify } from '@/hooks/useSpotify'
import { getPlaylistParams } from '@/lib/claude'
import {
  searchArtists,
  searchArtistStrict,
  searchTracks,
  getArtistTopTracks,
  getRelatedArtists,
  getTopArtists,
  getMe,
  createPlaylist,
  addTracksToPlaylist,
} from '@/lib/spotify'
import TrackCard from '@/components/Playlist/TrackCard'
import LastfmImport from '@/components/Dashboard/LastfmImport'

const EXAMPLE_PROMPTS = [
  'Build me a hype playlist for my Saturday morning run',
  'Chill music for cooking dinner on a weeknight',
  'I want something like Frank Ocean but more upbeat',
  'Late night drive through the city vibes',
  'Focus music with no lyrics for deep work',
]

// Resolve an artist name → Spotify artist object.
// Tries strict `artist:"Name"` first, falls back to plain name search.
async function resolveArtist(token, name) {
  try {
    const strict = await searchArtistStrict(token, name, 3)
    const match = strict?.artists?.items?.find(
      (a) => a.name.toLowerCase() === name.toLowerCase()
    ) ?? strict?.artists?.items?.[0]
    if (match) return match
  } catch {}
  try {
    const broad = await searchArtists(token, name, 3)
    return broad?.artists?.items?.[0] ?? null
  } catch {}
  return null
}

// Collect tracks from an artist: their own top tracks + optionally related artists' top tracks.
async function collectArtistTracks(token, artistName, includeRelated = false) {
  const artist = await resolveArtist(token, artistName)
  if (!artist) return []

  const tracks = []
  try {
    const top = await getArtistTopTracks(token, artist.id)
    tracks.push(...(top?.tracks ?? []))
  } catch {}

  if (includeRelated && tracks.length < 5) {
    try {
      const related = await getRelatedArtists(token, artist.id)
      const relArtists = (related?.artists ?? []).slice(0, 3)
      await Promise.all(
        relArtists.map(async (ra) => {
          try {
            const rt = await getArtistTopTracks(token, ra.id)
            tracks.push(...(rt?.tracks ?? []).slice(0, 3))
          } catch {}
        })
      )
    } catch {}
  }

  return tracks
}

export default function DiscoverPage() {
  const {
    tasteProfile,
    spotifyUser,
    lastfmData,
    lastfmUsername,
    spotifyTopArtistNames,
    setSpotifyTopArtistNames,
  } = useStore()
  const { getToken } = useSpotify()

  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const [saving, setSaving] = useState(false)
  const [playlist, setPlaylist] = useState(null)
  const [error, setError] = useState(null)
  const [suggestion, setSuggestion] = useState(null)
  const [savedUrl, setSavedUrl] = useState(null)

  // Lazily fetch and cache the user's Spotify top artist names once per session.
  async function ensureSpotifyHistory(token) {
    if (spotifyTopArtistNames?.length) return spotifyTopArtistNames
    try {
      const data = await getTopArtists(token, 'medium_term', 30)
      const names = (data?.items ?? []).map((a) => a.name).filter(Boolean)
      if (names.length) setSpotifyTopArtistNames(names)
      return names
    } catch {
      return []
    }
  }

  async function generate(text) {
    if (!text.trim()) return
    setLoading(true)
    setLoadingStep('Asking Claude to interpret your vibe…')
    setError(null)
    setSuggestion(null)
    setPlaylist(null)
    setSavedUrl(null)

    try {
      const token = await getToken()
      if (!token) throw new Error('Not authenticated')

      // Warm the history cache before calling Claude
      const topArtistNames = await ensureSpotifyHistory(token)

      const profile = {
        ...tasteProfile,
        lastfmUsername,
        lastfmData,
        spotifyTopArtistNames: topArtistNames,
      }

      const params = await getPlaylistParams(text, profile)

      const targetSize = Math.min(Math.max(params.playlistSize ?? 20, 1), 50)
      const minMs = params.minDurationMs ?? null
      const maxMs = params.maxDurationMs ?? null

      const seenIds = new Set()
      const tracks = []

      function addTracks(items) {
        for (const t of items) {
          if (!t?.id || seenIds.has(t.id)) continue
          if (minMs !== null && t.duration_ms < minMs) continue
          if (maxMs !== null && t.duration_ms > maxMs) continue
          seenIds.add(t.id)
          tracks.push(t)
        }
      }

      // --- Phase 1: Named artists ---
      const artistNames = params.artistNames ?? []
      if (artistNames.length) {
        setLoadingStep(`Finding tracks from ${artistNames.slice(0, 3).join(', ')}…`)
      }
      await Promise.all(
        artistNames.slice(0, 8).map(async (name) => {
          // Use related-artist fallback when we need more tracks (bigger playlist or duration filter active)
          const needsRelated = targetSize > 20 || minMs !== null || maxMs !== null
          const collected = await collectArtistTracks(token, name, needsRelated)
          addTracks(collected)
        })
      )

      // --- Phase 2: Search queries ---
      const queries = params.searchQueries ?? []
      if (queries.length) {
        setLoadingStep('Searching for matching tracks…')
      }
      // Request more tracks per query when we need a big playlist or are filtering by duration
      const perQuery = Math.ceil((targetSize * 1.5) / Math.max(queries.length, 1))
      await Promise.all(
        queries.slice(0, 5).map(async (q) => {
          try {
            const res = await searchTracks(token, q, Math.min(perQuery, 20))
            addTracks(res?.tracks?.items ?? [])
          } catch {}
        })
      )

      // --- Phase 3: Genre fallback if still thin ---
      if (tracks.length < Math.min(targetSize, 5) && (tasteProfile?.genres?.length ?? 0) > 0) {
        setLoadingStep('Broadening search…')
        const fallbackGenre = tasteProfile.genres[0].toLowerCase().replace(/\s+/g, '-')
        try {
          const res = await searchTracks(token, `genre:${fallbackGenre}`, 20)
          addTracks(res?.tracks?.items ?? [])
        } catch {}
      }

      if (tracks.length === 0) {
        setSuggestion(params.emptyResultSuggestion ?? null)
        throw new Error(
          `No tracks found for "${text}". ${params.emptyResultSuggestion ? 'See suggestion below.' : 'Try a different prompt.'}`
        )
      }

      // Shuffle and cap at targetSize
      const final = tracks.sort(() => Math.random() - 0.5).slice(0, targetSize)

      setPlaylist({
        name: params.playlistName || text,
        description: params.description || '',
        tracks: final,
        targetSize,
      })
    } catch (err) {
      setError(err.message || 'Something went wrong. Try a different prompt.')
    } finally {
      setLoading(false)
      setLoadingStep('')
    }
  }

  async function saveToSpotify() {
    if (!playlist) return
    setSaving(true)
    try {
      const token = await getToken()
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
          <div className="w-10 h-10 rounded-xl bg-accent/10 flex items-center justify-center flex-shrink-0">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
          <div>
            <p className="font-medium">Building your playlist</p>
            <p className="text-sm text-text-secondary">{loadingStep || 'Working on it…'}</p>
          </div>
        </div>
      )}

      {/* Error + smart suggestion */}
      {error && (
        <div className="card border-red-500/20 bg-red-500/5 space-y-3">
          <p className="text-sm text-red-400">{error}</p>
          {suggestion && (
            <div className="border-t border-red-500/10 pt-3">
              <p className="text-xs text-text-muted mb-2">Try this instead:</p>
              <button
                onClick={() => { setPrompt(suggestion); generate(suggestion) }}
                className="text-sm text-accent hover:text-accent-hover flex items-center gap-2 group"
              >
                <RefreshCw className="w-3.5 h-3.5 group-hover:rotate-180 transition-transform duration-300" />
                {suggestion}
              </button>
            </div>
          )}
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
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
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
