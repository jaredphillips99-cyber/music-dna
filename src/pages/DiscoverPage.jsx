import { useState } from 'react'
import { Send, Loader2, Save, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import useStore from '@/store/useStore'
import { useSpotify } from '@/hooks/useSpotify'
import { getPlaylistParams } from '@/lib/claude'
import {
  searchArtists,
  searchArtistStrict,
  searchTracksPaginated,
  getTopArtists,
  getTopTracks,
  getArtistAlbums,
  getAlbumTracks,
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

// Genre broadening map for backfill keyword searches (plain text, no genre: prefix)
const GENRE_KEYWORDS = {
  'tech-house':     ['tech house', 'techno house', 'club techno'],
  'melodic-techno': ['melodic techno', 'dark techno', 'melodic electronic'],
  'melodic-house':  ['melodic house', 'progressive house', 'deep melodic'],
  'deep-house':     ['deep house', 'soulful house', 'underground house'],
  'afro-house':     ['afro house', 'afrobeat electronic', 'tribal house'],
  'drum-and-bass':  ['drum and bass', 'dnb', 'liquid dnb'],
  'lo-fi':          ['lo fi hip hop', 'lofi chill', 'lo fi beats'],
  'hip-hop':        ['hip hop', 'rap', 'boom bap'],
  'indie-pop':      ['indie pop', 'indie rock', 'alternative pop'],
  'r-n-b':          ['rnb', 'r&b soul', 'neo soul'],
}

const LOG = (...args) => console.log('[MusicDNA]', ...args)

// ─── Artist resolution ────────────────────────────────────────────────────────
// Always resolves to an artist ID first before any track fetching.

async function resolveArtist(token, name) {
  try {
    const strict = await searchArtistStrict(token, name)
    const exact =
      strict?.artists?.items?.find((a) => a.name.toLowerCase() === name.toLowerCase()) ??
      strict?.artists?.items?.[0]
    if (exact) {
      LOG(`resolveArtist | "${name}" → ${exact.name} (${exact.id}) genres=[${(exact.genres ?? []).join(', ')}]`)
      return exact
    }
  } catch (e) {
    LOG(`resolveArtist | strict failed for "${name}":`, e.message)
  }
  try {
    const broad = await searchArtists(token, name, 5)
    const found = broad?.artists?.items?.[0] ?? null
    if (found) LOG(`resolveArtist | "${name}" → broad: ${found.name} (${found.id})`)
    else LOG(`resolveArtist | "${name}" → no match`)
    return found
  } catch (e) {
    LOG(`resolveArtist | broad failed for "${name}":`, e.message)
    return null
  }
}

// ─── Artist discography ───────────────────────────────────────────────────────
// Replaces the removed GET /artists/{id}/top-tracks endpoint.
// Fetches artist's albums/singles then pulls tracks from each.
// Album track objects are enriched with album metadata so TrackCard can show art.

async function fetchArtistDiscography(token, artistId, artistName, maxAlbums = 5) {
  try {
    const albumsRes = await getArtistAlbums(token, artistId, 10)
    const albums = (albumsRes?.items ?? []).slice(0, maxAlbums)
    LOG(`discography | ${artistName} | ${albums.length} albums/singles`)

    const results = await Promise.allSettled(
      albums.map(async (album) => {
        const tracksRes = await getAlbumTracks(token, album.id)
        return (tracksRes?.items ?? []).map((t) => ({
          ...t,
          // Enrich with album data — album track objects omit this field
          album: { id: album.id, name: album.name, images: album.images ?? [] },
        }))
      })
    )

    const seen = new Set()
    const tracks = []
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const t of r.value) {
          if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
        }
      } else {
        LOG(`discography | ${artistName} | album fetch failed:`, r.reason?.message)
      }
    }
    LOG(`discography | ${artistName} | ${tracks.length} tracks from ${albums.length} albums`)
    return tracks
  } catch (e) {
    LOG(`discography | ${artistName} | error:`, e.message)
    return []
  }
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

  // Fetch + cache user's top artist names for Claude prompt enrichment
  async function ensureSpotifyHistory(token) {
    if (spotifyTopArtistNames?.length) return spotifyTopArtistNames
    try {
      const data = await getTopArtists(token, 'medium_term', 50)
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

      const { spotifyTokenExpiry } = useStore.getState()
      LOG(`Token OK: ${token.slice(0, 8)}… expires in ${Math.round((spotifyTokenExpiry - Date.now()) / 1000)}s`)

      // ── Step 0: Parse prompt with Claude ─────────────────────────────────
      const topArtistNames = await ensureSpotifyHistory(token)
      const profile = { ...tasteProfile, lastfmUsername, lastfmData, spotifyTopArtistNames: topArtistNames }
      const params = await getPlaylistParams(text, profile)

      LOG('Claude parsed params:', JSON.stringify(params, null, 2))
      setDebugParams(params)

      if (params.raw) {
        throw new Error('Claude returned an unexpected response format. Please try again.')
      }

      const artists    = params.artists ?? []
      const genres     = params.genres ?? []
      const trackCount = Math.min(Math.max(params.track_count ?? 20, 1), 50)
      const minMs      = params.duration_min_ms ?? null
      const isSingle   = params.isSingleArtistPlaylist === true

      LOG(`artists=[${artists.join(', ')}] genres=[${genres.join(', ')}] count=${trackCount} minMs=${minMs}`)

      // Raw pool — dedup by track ID, no filtering until Step 5
      const rawPool = new Map()
      const pool = (items) => { for (const t of items) { if (t?.id) rawPool.set(t.id, t) } }

      // ── Step 1: User's own top tracks (most reliable source, unaffected by dev mode) ──
      setLoadingStep('Loading your listening history…')
      const [medTermTracks, shortTermTracks] = await Promise.allSettled([
        getTopTracks(token, 'medium_term', 50),
        getTopTracks(token, 'short_term', 50),
      ])
      if (medTermTracks.status === 'fulfilled')
        pool(medTermTracks.value?.items ?? [])
      else
        LOG('Step1 | medium_term top tracks failed:', medTermTracks.reason?.message)

      if (shortTermTracks.status === 'fulfilled')
        pool(shortTermTracks.value?.items ?? [])
      else
        LOG('Step1 | short_term top tracks failed:', shortTermTracks.reason?.message)

      stage('Step 1 — user top tracks', rawPool.size)

      // ── Step 2: Seed artist discography ───────────────────────────────────
      // Resolves each artist name → ID first, then fetches albums → tracks.
      // GET /artists/{id}/top-tracks was removed in the Feb 2026 API update.
      if (artists.length > 0) {
        setLoadingStep(`Fetching discography for ${artists.slice(0, 2).join(', ')}…`)

        const seedArtists = await Promise.all(
          artists.slice(0, 10).map((name) =>
            resolveArtist(token, name).catch((e) => {
              LOG(`Step2 | resolve "${name}" error:`, e.message)
              return null
            })
          )
        )

        const discographyResults = await Promise.all(
          seedArtists
            .filter(Boolean)
            .map((artist) =>
              fetchArtistDiscography(token, artist.id, artist.name, 5).catch(() => [])
            )
        )
        for (const tracks of discographyResults) pool(tracks)
        stage('Step 2 — seed artist discography', rawPool.size)
      }

      // ── Step 3: User's top artists discography ────────────────────────────
      // Use /me/top/artists (unaffected by dev mode) to discover tracks
      // from artists the user already likes but may not be in Claude's list.
      setLoadingStep('Adding from your top artists…')
      try {
        const topArtistsRes = await getTopArtists(token, 'medium_term', 50)
        const topArtistItems = (topArtistsRes?.items ?? [])
          .filter((a) => !artists.some((n) => n.toLowerCase() === a.name.toLowerCase()))
          .slice(0, 8) // top 8 that aren't already seed artists

        LOG(`Step3 | ${topArtistItems.length} top artists to fetch discography`)

        const topArtistTracks = await Promise.all(
          topArtistItems.map((artist) =>
            fetchArtistDiscography(token, artist.id, artist.name, 3).catch(() => [])
          )
        )
        for (const tracks of topArtistTracks) pool(tracks)
        stage('Step 3 — user top artist discography', rawPool.size)
      } catch (e) {
        LOG('Step3 | top artists fetch failed:', e.message)
      }

      // ── Step 4: Keyword searches (plain text, paginated, no genre: prefix) ─
      // Search limit is 10 per page after Feb 2026; fetch 3 pages per query = 30 tracks.
      setLoadingStep('Searching by genre and mood…')

      // Build keyword queries from genres (strip hyphens → plain text)
      const genreKeywords = genres.slice(0, 4).map((g) => {
        const alternatives = GENRE_KEYWORDS[g]
        return alternatives ? alternatives[0] : g.replace(/-/g, ' ')
      })

      // Also search by mood and each seed artist name
      const moodQuery   = params.mood ? [params.mood] : []
      const artistQuery = artists.slice(0, 3)
      const allQueries  = [...genreKeywords, ...moodQuery, ...artistQuery]

      const searchResults = await Promise.all(
        allQueries.map((q) =>
          searchTracksPaginated(token, q, 30).catch((e) => {
            LOG(`Step4 | search "${q}" error:`, e.message)
            return []
          })
        )
      )
      for (const tracks of searchResults) pool(tracks)
      stage('Step 4 — keyword searches', rawPool.size)

      LOG(`Raw pool after all sources: ${rawPool.size} unique tracks`)

      // ── Step 5: Duration filter + diversity cap (3 tracks per artist) ─────
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

      // ── Step 6: Backfill if pool is still thin ────────────────────────────
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

        // Backfill L1: alternative keyword variants for each genre
        setLoadingStep('Backfilling with broader searches…')
        for (const g of genres) {
          if (capped.length >= trackCount) break
          const alternatives = GENRE_KEYWORDS[g]?.slice(1) ?? [g.split('-')[0]]
          for (const kw of alternatives) {
            if (capped.length >= trackCount) break
            const r = await searchTracksPaginated(token, kw, 30).catch(() => [])
            absorb(r)
            stage(`Backfill L1 — "${kw}"`, capped.length)
          }
        }

        // Backfill L2: last.fm artist discographies
        if (capped.length < trackCount && lastfmData?.topArtists?.length) {
          setLoadingStep('Adding from Last.fm history…')
          const lfmNames = (lastfmData.topArtists)
            .map((a) => a.name)
            .filter((n) => n && !artists.includes(n))
            .slice(0, 5)

          for (const name of lfmNames) {
            if (capped.length >= trackCount) break
            try {
              const artist = await resolveArtist(token, name)
              if (!artist) continue
              const tracks = await fetchArtistDiscography(token, artist.id, name, 3)
              absorb(tracks)
              stage(`Backfill L2 — Last.fm: ${name}`, capped.length)
            } catch (e) {
              LOG(`Backfill L2 | ${name} error:`, e.message)
            }
          }
        }

        // Backfill L3: broader mood/energy search
        if (capped.length < trackCount && params.mood) {
          setLoadingStep('Broadening search…')
          const r = await searchTracksPaginated(token, params.mood, 50).catch(() => [])
          absorb(r)
          stage(`Backfill L3 — mood "${params.mood}"`, capped.length)
        }
      }

      if (capped.length === 0) {
        throw new Error(
          'Couldn\'t find any tracks — even after broadening the search. ' +
          'Try naming a specific genre (e.g. "techno") or artist.'
        )
      }

      // ── Step 7: Shuffle and slice to exact count ──────────────────────────
      // Note: popularity field was removed in the Feb 2026 API update,
      // so energy arc is based on shuffle only.
      const final = capped
        .sort(() => Math.random() - 0.5)
        .slice(0, trackCount)

      stage('Final playlist', final.length)
      setDebugStages([...stages])
      LOG(`Done. ${final.length} tracks (requested ${trackCount})`)

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
