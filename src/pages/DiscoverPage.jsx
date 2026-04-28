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

const LOG = (...args) => console.log('[MusicDNA]', ...args)

// ─── Artist resolution ────────────────────────────────────────────────────────

async function resolveArtist(token, name) {
  try {
    const strict = await searchArtistStrict(token, name, 3)
    const exact =
      strict?.artists?.items?.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
      strict?.artists?.items?.[0]
    if (exact) return exact
  } catch {}
  try {
    const broad = await searchArtists(token, name, 3)
    return broad?.artists?.items?.[0] ?? null
  } catch {}
  return null
}

// ─── Step 1: Seed artist tracks ───────────────────────────────────────────────
// Uses search (limit=50) + top-tracks union — gets far more than the 10-track
// top-tracks endpoint alone.

async function fetchSeedArtistTracks(token, artistName) {
  const artist = await resolveArtist(token, artistName)

  const [searchRes, topRes] = await Promise.allSettled([
    searchTracks(token, `artist:"${artistName}"`, 50),
    artist ? getArtistTopTracks(token, artist.id) : Promise.resolve(null),
  ])

  const seen = new Set()
  const tracks = []

  const searchItems = searchRes.status === 'fulfilled' ? (searchRes.value?.tracks?.items ?? []) : []
  LOG(`Step1 | ${artistName} | search returned ${searchItems.length} tracks`)
  for (const t of searchItems) {
    if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
  }

  const topItems = topRes.status === 'fulfilled' ? (topRes.value?.tracks ?? []) : []
  LOG(`Step1 | ${artistName} | top-tracks returned ${topItems.length} tracks`)
  for (const t of topItems) {
    if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
  }

  LOG(`Step1 | ${artistName} | unique total: ${tracks.length}`)
  return { tracks, artistId: artist?.id ?? null, artistName }
}

// ─── Step 2: Related artist expansion ────────────────────────────────────────

async function fetchRelatedTracks(token, artistId, artistName, count = 5) {
  if (!artistId) return []
  let relArtists = []
  try {
    const res = await getRelatedArtists(token, artistId)
    relArtists = (res?.artists ?? []).slice(0, count)
    LOG(`Step2 | ${artistName} | related artists: ${relArtists.map((a) => a.name).join(', ')}`)
  } catch (e) {
    LOG(`Step2 | ${artistName} | related-artists call failed:`, e.message)
    return []
  }

  const results = await Promise.allSettled(
    relArtists.map((ra) =>
      getArtistTopTracks(token, ra.id)
        .then((r) => ({ name: ra.name, tracks: r?.tracks ?? [] }))
    )
  )

  const tracks = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      LOG(`Step2 | related ${r.value.name} | ${r.value.tracks.length} tracks`)
      tracks.push(...r.value.tracks)
    } else {
      LOG(`Step2 | a related artist call was rejected`)
    }
  }
  LOG(`Step2 | ${artistName} | total related tracks: ${tracks.length}`)
  return tracks
}

// ─── Energy arc ordering ──────────────────────────────────────────────────────
// Uses popularity as proxy for energy (audio features endpoint is deprecated).
// Produces: low → peak (middle) → low shape.

function arrangeEnergyArc(tracks) {
  if (tracks.length <= 3) return tracks
  const sorted = [...tracks].sort((a, b) => (b.popularity ?? 50) - (a.popularity ?? 50))
  const n = sorted.length
  const arc = new Array(n)
  let lo = Math.floor(n / 2) - 1
  let hi = Math.floor(n / 2)
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) { arc[hi] = sorted[i]; hi = Math.min(hi + 1, n - 1) }
    else             { arc[lo] = sorted[i]; lo = Math.max(lo - 1, 0) }
  }
  return arc.filter(Boolean)
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DiscoverPage() {
  const {
    tasteProfile, spotifyUser, lastfmData, lastfmUsername,
    spotifyTopArtistNames, setSpotifyTopArtistNames,
  } = useStore()
  const { getToken } = useSpotify()

  const [prompt, setPrompt]       = useState('')
  const [loading, setLoading]     = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const [saving, setSaving]       = useState(false)
  const [playlist, setPlaylist]   = useState(null)
  const [error, setError]         = useState(null)
  const [suggestion, setSuggestion] = useState(null)
  const [savedUrl, setSavedUrl]   = useState(null)

  async function ensureSpotifyHistory(token) {
    if (spotifyTopArtistNames?.length) return spotifyTopArtistNames
    try {
      const data = await getTopArtists(token, 'medium_term', 30)
      const names = (data?.items ?? []).map((a) => a.name).filter(Boolean)
      if (names.length) setSpotifyTopArtistNames(names)
      return names
    } catch { return [] }
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

      LOG('Claude params:', JSON.stringify(params, null, 2))

      const targetSize   = Math.min(Math.max(params.playlistSize ?? 20, 1), 50)
      const minMs        = params.minDurationMs ?? null
      const maxMs        = params.maxDurationMs ?? null
      const isSingleArtist = params.isSingleArtistPlaylist === true
      const detectedGenres = params.detectedGenres ?? []
      const artistNames  = params.artistNames ?? []
      const queries      = params.searchQueries ?? []

      LOG(`Target: ${targetSize} tracks | minMs: ${minMs} | maxMs: ${maxMs} | singleArtist: ${isSingleArtist}`)
      LOG(`Seed artists: ${artistNames.join(', ')}`)
      LOG(`Search queries: ${queries.join(' | ')}`)
      LOG(`Detected genres: ${detectedGenres.join(', ')}`)

      // ── Raw pool: Map<trackId, track> — no filtering yet ──────────────────
      const rawPool = new Map()
      const addToPool = (items) => {
        for (const t of items) {
          if (t?.id && !rawPool.has(t.id)) rawPool.set(t.id, t)
        }
      }

      // ── STEP 1: All seed artists in parallel (search limit=50 + top-tracks) ──
      if (artistNames.length) {
        setLoadingStep(`Fetching tracks for ${artistNames.slice(0, 3).join(', ')}${artistNames.length > 3 ? '…' : ''}`)
      }
      const seedResults = await Promise.all(
        artistNames.slice(0, 8).map((name) =>
          fetchSeedArtistTracks(token, name).catch((e) => {
            LOG(`Step1 | ${name} | top-level error:`, e.message)
            return { tracks: [], artistId: null, artistName: name }
          })
        )
      )
      for (const { tracks } of seedResults) addToPool(tracks)
      LOG(`After Step 1 (seed artists): raw pool = ${rawPool.size} tracks`)

      // ── STEP 2: Related artists for every seed (top 5 related, limit=10 each) ──
      setLoadingStep('Expanding with related artists…')
      const relatedArrays = await Promise.all(
        seedResults
          .filter((r) => r.artistId)
          .map((r) =>
            fetchRelatedTracks(token, r.artistId, r.artistName, 5).catch(() => [])
          )
      )
      for (const tracks of relatedArrays) addToPool(tracks)
      LOG(`After Step 2 (related artists): raw pool = ${rawPool.size} tracks`)

      // ── STEP 3: Last.fm top artists as seeds ──────────────────────────────
      const lfmArtistNames = (lastfmData?.topArtists ?? [])
        .map((a) => a.name)
        .filter((n) => n && !artistNames.includes(n))
        .slice(0, 6)

      if (lfmArtistNames.length) {
        setLoadingStep('Adding tracks from your Last.fm history…')
        LOG(`Step3 | Last.fm artists: ${lfmArtistNames.join(', ')}`)
        const lfmResults = await Promise.all(
          lfmArtistNames.map(async (name) => {
            try {
              const artist = await resolveArtist(token, name)
              if (!artist) { LOG(`Step3 | ${name} | not found on Spotify`); return [] }
              const res = await getArtistTopTracks(token, artist.id)
              const tracks = res?.tracks ?? []
              LOG(`Step3 | ${name} | ${tracks.length} top tracks`)
              return tracks
            } catch (e) {
              LOG(`Step3 | ${name} | error:`, e.message)
              return []
            }
          })
        )
        for (const tracks of lfmResults) addToPool(tracks)
        LOG(`After Step 3 (Last.fm): raw pool = ${rawPool.size} tracks`)
      }

      // ── STEP 4: Search queries (always limit=50) ──────────────────────────
      setLoadingStep('Searching for matching tracks…')
      const queryResults = await Promise.all(
        queries.slice(0, 6).map((q) =>
          searchTracks(token, q, 50)
            .then((r) => {
              const items = r?.tracks?.items ?? []
              LOG(`Step4 | query "${q}" | ${items.length} results`)
              return items
            })
            .catch((e) => {
              LOG(`Step4 | query "${q}" | error:`, e.message)
              return []
            })
        )
      )
      for (const tracks of queryResults) addToPool(tracks)
      LOG(`After Step 4 (search queries): raw pool = ${rawPool.size} tracks`)

      // ── STEP 5: Apply duration filter then artist diversity cap ───────────
      let filtered = Array.from(rawPool.values())

      if (minMs !== null) {
        const before = filtered.length
        filtered = filtered.filter((t) => t.duration_ms >= minMs)
        LOG(`Duration filter (>=${minMs}ms): ${before} → ${filtered.length} tracks`)
      }
      if (maxMs !== null) {
        const before = filtered.length
        filtered = filtered.filter((t) => t.duration_ms <= maxMs)
        LOG(`Duration filter (<=${maxMs}ms): ${before} → ${filtered.length} tracks`)
      }

      // Shuffle before capping so the 3 we keep per artist are random, not always the same
      filtered.sort(() => Math.random() - 0.5)

      let capped
      if (isSingleArtist) {
        capped = filtered
        LOG(`Step5 | single-artist mode — no diversity cap | ${capped.length} tracks`)
      } else {
        const capCount = new Map()
        capped = []
        for (const t of filtered) {
          const artistId = t.artists?.[0]?.id
          if (!artistId) { capped.push(t); continue }
          const n = capCount.get(artistId) ?? 0
          if (n < 3) { capped.push(t); capCount.set(artistId, n + 1) }
        }
        LOG(`Step5 | diversity cap (3/artist): ${filtered.length} → ${capped.length} tracks`)
      }

      LOG(`Pre-backfill pool: ${capped.length} tracks, need: ${targetSize}`)

      // ── STEP 6: Genre backfill if still under target ──────────────────────
      if (capped.length < targetSize) {
        setLoadingStep(`Backfilling to ${targetSize} tracks…`)

        const genreTerms = [
          ...detectedGenres,
          ...(tasteProfile?.genres ?? []).map((g) => g.toLowerCase().replace(/[^a-z0-9-]/g, '-')),
        ].filter(Boolean)

        LOG(`Step6 | backfill genres to try: ${genreTerms.join(', ')}`)

        const cappedIds = new Set(capped.map((t) => t.id))
        const backfillCapCount = new Map()

        const tryBackfill = (items) => {
          for (const t of items) {
            if (capped.length >= targetSize) break
            if (!t?.id || cappedIds.has(t.id)) continue
            if (minMs !== null && t.duration_ms < minMs) continue
            if (maxMs !== null && t.duration_ms > maxMs) continue
            if (!isSingleArtist) {
              const artistId = t.artists?.[0]?.id
              if (artistId) {
                const n = backfillCapCount.get(artistId) ?? 0
                if (n >= 3) continue
                backfillCapCount.set(artistId, n + 1)
              }
            }
            cappedIds.add(t.id)
            capped.push(t)
          }
        }

        for (const genre of genreTerms) {
          if (capped.length >= targetSize) break
          try {
            const res = await searchTracks(token, `genre:${genre}`, 50)
            const items = res?.tracks?.items ?? []
            LOG(`Step6 | genre:${genre} | ${items.length} results`)
            tryBackfill(items)
            LOG(`Step6 | after genre:${genre} | pool now ${capped.length}`)
          } catch (e) {
            LOG(`Step6 | genre:${genre} | error:`, e.message)
          }
        }

        // Last resort: plain genre keyword search
        if (capped.length < targetSize && genreTerms.length > 0) {
          for (const genre of genreTerms.slice(0, 3)) {
            if (capped.length >= targetSize) break
            try {
              const res = await searchTracks(token, genre, 50)
              const items = res?.tracks?.items ?? []
              LOG(`Step6 | keyword "${genre}" | ${items.length} results`)
              tryBackfill(items)
            } catch {}
          }
        }

        LOG(`After Step 6 (backfill): ${capped.length} tracks`)
      }

      if (capped.length === 0) {
        setSuggestion(params.emptyResultSuggestion ?? null)
        throw new Error(
          `No tracks found for "${text}".${params.emptyResultSuggestion ? ' See suggestion below.' : ' Try a different prompt.'}`
        )
      }

      // ── STEP 7: Shuffle remaining, apply energy arc, slice to exact count ──
      const shuffled = capped.sort(() => Math.random() - 0.5)
      const arced    = arrangeEnergyArc(shuffled.slice(0, targetSize))
      const final    = arced.slice(0, targetSize)

      LOG(`Final playlist: ${final.length} tracks (requested ${targetSize})`)

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
      await addTracksToPlaylist(token, pl.id, playlist.tracks.map((t) => t.uri))
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
          {loading
            ? <Loader2 className="w-4 h-4 text-black animate-spin" />
            : <Send className="w-4 h-4 text-black" />}
        </button>
      </form>

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
                <a href={savedUrl} target="_blank" rel="noopener noreferrer"
                   className="btn-primary flex items-center gap-2 text-sm">
                  <ExternalLink className="w-4 h-4" />
                  Open in Spotify
                </a>
              ) : (
                <button onClick={saveToSpotify} disabled={saving}
                        className="btn-primary flex items-center gap-2 text-sm">
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
