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
// Tries strict artist:"Name" first, falls back to plain search.
async function resolveArtist(token, name) {
  try {
    const strict = await searchArtistStrict(token, name, 3)
    const exact = strict?.artists?.items?.find(
      (a) => a.name.toLowerCase() === name.toLowerCase()
    ) ?? strict?.artists?.items?.[0]
    if (exact) return exact
  } catch {}
  try {
    const broad = await searchArtists(token, name, 3)
    return broad?.artists?.items?.[0] ?? null
  } catch {}
  return null
}

// Fetch an artist's top tracks + top tracks from their top N related artists, all in parallel.
async function expandArtist(token, artistName, relatedCount = 4) {
  const artist = await resolveArtist(token, artistName)
  if (!artist) return { tracks: [], artistId: null }

  // Kick off top-tracks and related-artists fetch simultaneously
  const [topResult, relatedResult] = await Promise.allSettled([
    getArtistTopTracks(token, artist.id),
    getRelatedArtists(token, artist.id),
  ])

  const tracks = topResult.status === 'fulfilled' ? (topResult.value?.tracks ?? []) : []

  if (relatedResult.status === 'fulfilled') {
    const relArtists = (relatedResult.value?.artists ?? []).slice(0, relatedCount)
    const relTrackResults = await Promise.allSettled(
      relArtists.map((ra) => getArtistTopTracks(token, ra.id))
    )
    for (const r of relTrackResults) {
      if (r.status === 'fulfilled') tracks.push(...(r.value?.tracks ?? []).slice(0, 3))
    }
  }

  return { tracks, artistId: artist.id }
}

// Arrange tracks in an energy arc: low → high (middle) → low.
// Uses popularity as a proxy for energy since audio features are unavailable.
function arrangeEnergyArc(tracks) {
  if (tracks.length <= 3) return tracks
  const sorted = [...tracks].sort((a, b) => (b.popularity ?? 50) - (a.popularity ?? 50))
  const n = sorted.length
  const arc = new Array(n)
  // Place tracks from highest popularity outward from the middle
  let lo = Math.floor(n / 2) - 1
  let hi = Math.floor(n / 2)
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      arc[hi] = sorted[i]
      hi = Math.min(hi + 1, n - 1)
    } else {
      arc[lo] = sorted[i]
      lo = Math.max(lo - 1, 0)
    }
  }
  return arc.filter(Boolean)
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

      const topArtistNames = await ensureSpotifyHistory(token)
      const profile = { ...tasteProfile, lastfmUsername, lastfmData, spotifyTopArtistNames: topArtistNames }
      const params = await getPlaylistParams(text, profile)

      const targetSize = Math.min(Math.max(params.playlistSize ?? 20, 1), 50)
      const minMs = params.minDurationMs ?? null
      const maxMs = params.maxDurationMs ?? null
      const isSingleArtist = params.isSingleArtistPlaylist === true
      const detectedGenres = params.detectedGenres ?? []

      // Track per-artist counts for diversity cap (3 tracks max per artist unless single-artist mode)
      const artistTrackCount = new Map()
      const seenIds = new Set()
      const tracks = []

      function addTracks(items, { sourceArtistId = null, skipCap = false } = {}) {
        for (const t of items) {
          if (!t?.id || seenIds.has(t.id)) continue
          if (minMs !== null && t.duration_ms < minMs) continue
          if (maxMs !== null && t.duration_ms > maxMs) continue

          // Diversity cap: max 3 tracks per artist unless single-artist or explicitly skipped
          if (!isSingleArtist && !skipCap) {
            const artistId = sourceArtistId ?? t.artists?.[0]?.id
            if (artistId) {
              const count = artistTrackCount.get(artistId) ?? 0
              if (count >= 3) continue
              artistTrackCount.set(artistId, count + 1)
            }
          }

          seenIds.add(t.id)
          tracks.push(t)
        }
      }

      // ── Phase 1: Named seed artists — all in parallel, each with related-artist expansion ──
      const artistNames = params.artistNames ?? []
      if (artistNames.length) {
        setLoadingStep(`Expanding ${artistNames.length} artists + their related artists…`)
      }

      // Single-artist mode: pull full top-tracks from the one seed (no related cap) to fill size
      if (isSingleArtist && artistNames.length >= 1) {
        const { tracks: seedTracks, artistId } = await expandArtist(token, artistNames[0], 5)
        addTracks(seedTracks, { sourceArtistId: artistId, skipCap: true })
      } else {
        const expansions = await Promise.all(
          artistNames.slice(0, 8).map((name) => expandArtist(token, name, 4))
        )
        for (const { tracks: t, artistId } of expansions) {
          addTracks(t, { sourceArtistId: artistId })
        }
      }

      // ── Phase 2: Last.fm top artists as additional seeds (if connected) ──
      const lfmArtists = (lastfmData?.topArtists ?? [])
        .slice(0, 8)
        .map((a) => a.name)
        .filter((n) => n && !artistNames.includes(n))

      if (lfmArtists.length) {
        setLoadingStep('Adding tracks from your Last.fm history…')
        const lfmExpansions = await Promise.all(
          lfmArtists.slice(0, 5).map((name) => expandArtist(token, name, 2))
        )
        for (const { tracks: t, artistId } of lfmExpansions) {
          addTracks(t, { sourceArtistId: artistId })
        }
      }

      // ── Phase 3: Search queries ──
      const queries = params.searchQueries ?? []
      if (queries.length) {
        setLoadingStep('Searching for matching tracks…')
      }
      const perQuery = Math.min(Math.ceil((targetSize * 2) / Math.max(queries.length, 1)), 50)
      await Promise.all(
        queries.slice(0, 6).map(async (q) => {
          try {
            const res = await searchTracks(token, q, perQuery)
            addTracks(res?.tracks?.items ?? [])
          } catch {}
        })
      )

      // ── Phase 4: Backfill with genre searches until targetSize is reached ──
      if (tracks.length < targetSize) {
        setLoadingStep(`Backfilling to ${targetSize} tracks…`)

        // Build a list of genre terms to try: detected genres first, then onboarding genres
        const genreTerms = [
          ...detectedGenres,
          ...(tasteProfile?.genres ?? []).map((g) => g.toLowerCase().replace(/[^a-z0-9-]/g, '-')),
        ].filter(Boolean)

        for (const genre of genreTerms) {
          if (tracks.length >= targetSize) break
          const needed = Math.min((targetSize - tracks.length) * 3, 50)
          try {
            const res = await searchTracks(token, `genre:${genre}`, needed)
            addTracks(res?.tracks?.items ?? [])
          } catch {}
        }

        // Last resort: broad popularity search on the first detected genre
        if (tracks.length < targetSize && genreTerms.length > 0) {
          const needed = Math.min((targetSize - tracks.length) * 3, 50)
          try {
            const res = await searchTracks(token, genreTerms[0], needed)
            addTracks(res?.tracks?.items ?? [])
          } catch {}
        }
      }

      if (tracks.length === 0) {
        setSuggestion(params.emptyResultSuggestion ?? null)
        throw new Error(
          `No tracks found for "${text}".${params.emptyResultSuggestion ? ' See suggestion below.' : ' Try a different prompt.'}`
        )
      }

      // ── Final: shuffle to mix artists, arc by energy, then hard-cap at targetSize ──
      const shuffled = tracks.sort(() => Math.random() - 0.5)
      const arced = arrangeEnergyArc(shuffled.slice(0, targetSize))
      // If we have fewer tracks than requested, take everything we got
      const final = arced.slice(0, targetSize)

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
