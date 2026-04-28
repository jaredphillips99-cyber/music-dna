import { useState } from 'react'
import { Send, Loader2, Save, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import useStore from '@/store/useStore'
import { useSpotify } from '@/hooks/useSpotify'
import { getPlaylistParams } from '@/lib/claude'
import {
  searchArtists,
  searchArtistStrict,
  searchTracks,
  getArtistTopTracks,
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

// Genre broadening map: if a specific genre yields < 20 tracks, try these fallbacks
const GENRE_FALLBACKS = {
  'tech-house':      ['house', 'techno', 'electronic'],
  'melodic-techno':  ['techno', 'melodic-house', 'electronic'],
  'melodic-house':   ['deep-house', 'house', 'progressive-house'],
  'deep-house':      ['house', 'chill', 'electronic'],
  'afro-house':      ['house', 'afrobeat', 'electronic'],
  'drum-and-bass':   ['electronic', 'jungle', 'dance'],
  'lo-fi':           ['chill', 'hip-hop', 'ambient'],
  'hip-hop':         ['rap', 'r-n-b', 'trap'],
  'indie-pop':       ['indie', 'pop', 'alternative'],
  'r-n-b':           ['soul', 'pop', 'hip-hop'],
}

const LOG = (...args) => console.log('[MusicDNA]', ...args)

// ─── Artist resolution ────────────────────────────────────────────────────────

async function resolveArtist(token, name) {
  try {
    const strict = await searchArtistStrict(token, name, 3)
    const exact =
      strict?.artists?.items?.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
      strict?.artists?.items?.[0]
    if (exact) {
      LOG(`resolveArtist | "${name}" → ${exact.name} (${exact.id}) genres=[${(exact.genres ?? []).join(', ')}]`)
      return exact
    }
  } catch (e) {
    LOG(`resolveArtist | strict search failed for "${name}":`, e.message)
  }
  try {
    const broad = await searchArtists(token, name, 3)
    const found = broad?.artists?.items?.[0] ?? null
    if (found) LOG(`resolveArtist | "${name}" → broad: ${found.name} (${found.id})`)
    else LOG(`resolveArtist | "${name}" → no match found`)
    return found
  } catch (e) {
    LOG(`resolveArtist | broad search failed for "${name}":`, e.message)
    return null
  }
}

// ─── Genre search with fallback ───────────────────────────────────────────────
// Tries genre: slug filter first; if it returns nothing, falls back to plain keyword.
// Spotify's genre: filter only works for exact genre slugs it recognises — niche or
// hyphenated genres (melodic-techno, tech-house) often return 0. The keyword fallback
// strips hyphens and searches as free text, which reliably returns results.

async function searchGenreTracks(token, genre, limit = 50) {
  try {
    const r = await searchTracks(token, `genre:${genre}`, limit)
    const items = r?.tracks?.items ?? []
    if (items.length > 0) {
      LOG(`genre:${genre} → ${items.length} tracks (genre filter)`)
      return items
    }
    LOG(`genre:${genre} → 0 results, trying keyword fallback`)
  } catch (e) {
    LOG(`genre:${genre} filter error: ${e.message}`)
  }
  // Fallback: plain keyword (strip hyphens)
  try {
    const plain = genre.replace(/-/g, ' ')
    const r = await searchTracks(token, plain, limit)
    const items = r?.tracks?.items ?? []
    LOG(`"${plain}" keyword fallback → ${items.length} tracks`)
    return items
  } catch (e) {
    LOG(`genre keyword fallback failed for "${genre}": ${e.message}`)
    return []
  }
}

// ─── Step 1: seed artist tracks ───────────────────────────────────────────────

async function fetchSeedArtistTracks(token, artistName, market) {
  const artist = await resolveArtist(token, artistName)
  const [searchRes, topRes] = await Promise.allSettled([
    searchTracks(token, `artist:"${artistName}"`, 50),
    artist ? getArtistTopTracks(token, artist.id, market) : Promise.resolve(null),
  ])

  if (searchRes.status === 'rejected')
    LOG(`Step1 | ${artistName} | search error:`, searchRes.reason?.message)
  if (topRes.status === 'rejected')
    LOG(`Step1 | ${artistName} | top-tracks error:`, topRes.reason?.message)

  const seen = new Set()
  const tracks = []
  for (const t of searchRes.status === 'fulfilled' ? (searchRes.value?.tracks?.items ?? []) : []) {
    if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
  }
  for (const t of topRes.status === 'fulfilled' ? (topRes.value?.tracks ?? []) : []) {
    if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
  }
  LOG(`Step1 | ${artistName} | ${tracks.length} tracks (search=${searchRes.status === 'fulfilled' ? searchRes.value?.tracks?.items?.length ?? 0 : 'ERR'}, top-tracks=${topRes.status === 'fulfilled' ? topRes.value?.tracks?.length ?? 0 : 'ERR'})`)
  return { tracks, artistId: artist?.id ?? null, artistName, artistGenres: artist?.genres ?? [] }
}

// ─── Step 2: genre-based expansion ───────────────────────────────────────────
// Replaces /artists/{id}/related-artists which is 403-restricted for new Spotify apps
// since Nov 2024. Instead uses the seed artist's own Spotify genre tags (guaranteed
// valid genre slugs) to discover tracks by other artists in the same space.

async function fetchGenreExpansionTracks(token, artistName, artistGenres, claudeGenres) {
  // Convert artist's Spotify genre strings ("melodic techno") → slugs ("melodic-techno")
  const spotifyGenres = artistGenres.slice(0, 3).map((g) => g.replace(/\s+/g, '-'))
  const genresToUse = spotifyGenres.length ? spotifyGenres : claudeGenres.slice(0, 3)

  LOG(`Step2 | ${artistName} | expanding via genres: [${genresToUse.join(', ')}] (related-artists restricted)`)

  const results = await Promise.allSettled(
    genresToUse.map((g) => searchGenreTracks(token, g, 50))
  )

  const seen = new Set()
  const tracks = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const t of r.value) {
        if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
      }
    } else {
      LOG(`Step2 | ${artistName} | genre search rejected:`, r.reason?.message)
    }
  }
  LOG(`Step2 | ${artistName} | genre expansion → ${tracks.length} tracks`)
  return tracks
}

// ─── Energy arc ───────────────────────────────────────────────────────────────

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

// ─── Debug panel ──────────────────────────────────────────────────────────────

function DebugPanel({ params, stages }) {
  const [open, setOpen] = useState(false)
  if (!params) return null
  return (
    <div className="border border-surface-4 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-2 text-xs font-mono text-text-muted hover:text-text-secondary transition-colors"
      >
        <span>Pipeline debug</span>
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </button>

      {open && (
        <div className="p-4 bg-surface-1 space-y-5 text-xs font-mono">
          <div>
            <p className="text-text-muted uppercase tracking-widest mb-2">Parsed by Claude</p>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              <Row label="artists" value={params.artists?.join(', ') || '—'} />
              <Row label="genres" value={params.genres?.join(', ') || '—'} />
              <Row label="energy" value={params.energy || '—'} />
              <Row label="bpm_target" value={params.bpm_target ?? '—'} />
              <Row label="duration_min_ms" value={params.duration_min_ms ?? '—'} />
              <Row label="track_count" value={params.track_count ?? '—'} />
              <Row label="mood" value={params.mood || '—'} />
              <Row label="single_artist" value={String(params.isSingleArtistPlaylist ?? false)} />
            </div>
          </div>

          {stages.length > 0 && (
            <div>
              <p className="text-text-muted uppercase tracking-widest mb-2">Pipeline stages</p>
              <table className="w-full border-collapse">
                <tbody>
                  {stages.map(({ label, count }) => (
                    <tr key={label} className="border-b border-surface-3 last:border-0">
                      <td className="py-1 pr-4 text-text-secondary">{label}</td>
                      <td className="py-1 text-right text-accent font-semibold">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Row({ label, value }) {
  return (
    <>
      <span className="text-text-muted">{label}</span>
      <span className="text-text-primary truncate">{String(value)}</span>
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function DiscoverPage() {
  const {
    tasteProfile, spotifyUser, lastfmData, lastfmUsername,
    spotifyTopArtistNames, setSpotifyTopArtistNames,
  } = useStore()
  const { getToken } = useSpotify()

  const [prompt, setPrompt]           = useState('')
  const [loading, setLoading]         = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const [saving, setSaving]           = useState(false)
  const [playlist, setPlaylist]       = useState(null)
  const [error, setError]             = useState(null)
  const [savedUrl, setSavedUrl]       = useState(null)
  const [debugParams, setDebugParams] = useState(null)
  const [debugStages, setDebugStages] = useState([])

  async function ensureSpotifyHistory(token) {
    if (spotifyTopArtistNames?.length) return spotifyTopArtistNames
    try {
      const data = await getTopArtists(token, 'medium_term', 30)
      const names = (data?.items ?? []).map((a) => a.name).filter(Boolean)
      if (names.length) setSpotifyTopArtistNames(names)
      return names
    } catch (e) {
      LOG('ensureSpotifyHistory failed:', e.message)
      return []
    }
  }

  async function generate(text) {
    if (!text.trim()) return
    setLoading(true)
    setLoadingStep('Parsing your prompt with Claude…')
    setError(null)
    setPlaylist(null)
    setSavedUrl(null)
    setDebugParams(null)
    setDebugStages([])

    const stages = []
    const stage = (label, count) => {
      stages.push({ label, count })
      LOG(`[${label}]: ${count} tracks`)
    }

    try {
      const token = await getToken()
      if (!token) throw new Error('Not authenticated — please reconnect Spotify')

      // Token diagnostics — logs token prefix and expiry to the console
      const { spotifyTokenExpiry } = useStore.getState()
      LOG(`Token OK: ${token.slice(0, 8)}… expires in ${Math.round((spotifyTokenExpiry - Date.now()) / 1000)}s`)

      // User market for top-tracks API (requires explicit ISO country code since from_token is deprecated)
      const market = spotifyUser?.country || 'US'
      LOG(`Using market: ${market}`)

      // ── Step 0: Parse prompt with Claude ─────────────────────────────────
      const topArtistNames = await ensureSpotifyHistory(token)
      const profile = { ...tasteProfile, lastfmUsername, lastfmData, spotifyTopArtistNames: topArtistNames }
      const params = await getPlaylistParams(text, profile)

      LOG('Claude parsed params:', JSON.stringify(params, null, 2))
      setDebugParams(params)

      if (params.raw) {
        LOG('WARNING: Claude returned non-JSON (raw field set). Response:', params.raw)
        throw new Error('Claude returned an unexpected response format. Please try again.')
      }

      const artists    = params.artists ?? []
      const genres     = params.genres ?? []
      const trackCount = Math.min(Math.max(params.track_count ?? 20, 1), 50)
      const minMs      = params.duration_min_ms ?? null
      const isSingle   = params.isSingleArtistPlaylist === true

      LOG(`artists=[${artists.join(', ')}] genres=[${genres.join(', ')}] count=${trackCount} minMs=${minMs} isSingle=${isSingle}`)

      if (artists.length === 0 && genres.length === 0) {
        throw new Error('Claude could not identify any artists or genres from your prompt. Try being more specific.')
      }

      // Raw pool — dedup by track ID only, no filtering yet
      const rawPool = new Map()
      const pool = (items) => { for (const t of items) { if (t?.id) rawPool.set(t.id, t) } }

      // ── Step 1: Seed artist tracks (search limit=50 + top-tracks) ─────────
      setLoadingStep(artists.length
        ? `Fetching tracks for ${artists.slice(0, 3).join(', ')}…`
        : 'Searching by genre…')

      const seedResults = await Promise.all(
        artists.slice(0, 10).map((name) =>
          fetchSeedArtistTracks(token, name, market).catch((e) => {
            LOG(`Step1 | ${name} | unhandled error:`, e.message)
            return { tracks: [], artistId: null, artistName: name, artistGenres: [] }
          })
        )
      )
      for (const { tracks } of seedResults) pool(tracks)
      stage('Step 1 — seed artist tracks', rawPool.size)

      // ── Step 2: Genre-based expansion (replaces restricted related-artists) ─
      setLoadingStep('Expanding with similar genre tracks…')
      const expansionArrays = await Promise.all(
        seedResults
          .filter((r) => r.artistId) // only artists we successfully resolved
          .map((r) =>
            fetchGenreExpansionTracks(token, r.artistName, r.artistGenres, genres).catch(() => [])
          )
      )
      for (const tracks of expansionArrays) pool(tracks)
      stage('Step 2 — genre expansion (related-artists replaced)', rawPool.size)

      // ── Step 3: Last.fm top artists ───────────────────────────────────────
      const lfmNames = (lastfmData?.topArtists ?? [])
        .map((a) => a.name).filter((n) => n && !artists.includes(n)).slice(0, 6)

      if (lfmNames.length) {
        setLoadingStep('Adding tracks from your Last.fm history…')
        const lfmTracks = await Promise.all(
          lfmNames.map(async (name) => {
            try {
              const artist = await resolveArtist(token, name)
              if (!artist) return []
              const res = await getArtistTopTracks(token, artist.id, market)
              return res?.tracks ?? []
            } catch (e) {
              LOG(`Step3 | Last.fm artist "${name}" error:`, e.message)
              return []
            }
          })
        )
        for (const tracks of lfmTracks) pool(tracks)
        stage('Step 3 — Last.fm artist tracks', rawPool.size)
      }

      // ── Step 4: Genre searches (genre: filter + keyword fallback) ─────────
      setLoadingStep('Searching by genre…')
      const genreResults = await Promise.all(
        genres.slice(0, 4).map((g) =>
          searchGenreTracks(token, g, 50).catch((e) => {
            LOG(`Step4 | genre "${g}" error:`, e.message)
            return []
          })
        )
      )
      for (const tracks of genreResults) pool(tracks)
      stage('Step 4 — genre searches', rawPool.size)

      LOG(`Raw pool after all sources: ${rawPool.size} unique tracks`)

      // ── Step 5: Duration filter + diversity cap ───────────────────────────
      let filtered = Array.from(rawPool.values())
      if (minMs !== null) {
        filtered = filtered.filter((t) => t.duration_ms >= minMs)
        stage(`Step 5a — duration filter (≥${Math.round(minMs / 60000)}min)`, filtered.length)
      }

      filtered.sort(() => Math.random() - 0.5)

      let capped
      if (isSingle) {
        capped = filtered
      } else {
        const capCount = new Map()
        capped = []
        for (const t of filtered) {
          const aid = t.artists?.[0]?.id
          if (!aid) { capped.push(t); continue }
          const n = capCount.get(aid) ?? 0
          if (n < 3) { capped.push(t); capCount.set(aid, n + 1) }
        }
      }
      stage('Step 5b — diversity cap (3/artist)', capped.length)

      // ── Step 6: Three-layer internal backfill ─────────────────────────────
      if (capped.length < trackCount) {
        const cappedIds = new Set(capped.map((t) => t.id))
        const backfillCap = new Map()

        const absorb = (items) => {
          for (const t of items) {
            if (capped.length >= trackCount * 2) break
            if (!t?.id || cappedIds.has(t.id)) continue
            if (minMs !== null && t.duration_ms < minMs) continue
            if (!isSingle) {
              const aid = t.artists?.[0]?.id
              if (aid) {
                const n = backfillCap.get(aid) ?? 0
                if (n >= 3) continue
                backfillCap.set(aid, n + 1)
              }
            }
            cappedIds.add(t.id)
            capped.push(t)
          }
        }

        // Layer 1: specific genre searches
        setLoadingStep('Backfilling with genre searches…')
        for (const g of genres) {
          if (capped.length >= trackCount) break
          const r = await searchGenreTracks(token, g, 50).catch(() => [])
          absorb(r)
          stage(`Backfill L1 — genre:${g}`, capped.length)
        }

        // Layer 2: broader genre fallbacks
        if (capped.length < trackCount) {
          setLoadingStep('Broadening genre search…')
          const broader = [...new Set(
            genres.flatMap((g) => GENRE_FALLBACKS[g] ?? [g.split('-')[0]])
          )].filter((g) => !genres.includes(g))

          for (const g of broader) {
            if (capped.length >= trackCount) break
            const r = await searchGenreTracks(token, g, 50).catch(() => [])
            absorb(r)
            stage(`Backfill L2 — ${g} (broader)`, capped.length)
          }
        }

        // Layer 3: mood/energy keyword search
        if (capped.length < trackCount && params.mood) {
          setLoadingStep('Searching by mood…')
          try {
            const r = await searchTracks(token, params.mood, 50)
            absorb(r?.tracks?.items ?? [])
            stage(`Backfill L3 — mood "${params.mood}"`, capped.length)
          } catch (e) {
            LOG(`Backfill L3 mood error: ${e.message}`)
          }
        }
      }

      if (capped.length === 0) {
        throw new Error(
          `Couldn't find any tracks for that prompt — even after broadening the search. ` +
          `Try naming a specific genre (e.g. "tech-house") or artist.`
        )
      }

      // ── Step 7: Shuffle, energy arc, slice to exact count ─────────────────
      const shuffled = capped.sort(() => Math.random() - 0.5)
      const arced    = arrangeEnergyArc(shuffled.slice(0, trackCount))
      const final    = arced.slice(0, trackCount)

      stage('Final playlist', final.length)
      setDebugStages([...stages])
      LOG(`Done. ${final.length} tracks returned (requested ${trackCount})`)

      setPlaylist({
        name: params.playlistName || text,
        description: params.description || '',
        tracks: final,
      })
    } catch (err) {
      LOG('generate() error:', err.message)
      setDebugStages([...stages])
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

  return (
    <div className="space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-black mb-1">Discover</h1>
        <p className="text-text-secondary">Describe what you want to hear in plain English.</p>
      </div>

      {!lastfmUsername && <LastfmImport />}

      {/* Prompt input */}
      <form onSubmit={(e) => { e.preventDefault(); generate(prompt) }} className="relative">
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

      {/* Loading */}
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

      {/* Error */}
      {error && (
        <div className="space-y-3">
          <div className="card border-red-500/20 bg-red-500/5">
            <p className="text-sm text-red-400">{error}</p>
          </div>
          <DebugPanel params={debugParams} stages={debugStages} />
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

          <DebugPanel params={debugParams} stages={debugStages} />
        </div>
      )}
    </div>
  )
}
