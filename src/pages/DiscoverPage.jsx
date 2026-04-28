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
    if (exact) return exact
  } catch {}
  try {
    const broad = await searchArtists(token, name, 3)
    return broad?.artists?.items?.[0] ?? null
  } catch {}
  return null
}

// Step 1: seed artist → search(artist:"name", 50) + top-tracks union
async function fetchSeedArtistTracks(token, artistName) {
  const artist = await resolveArtist(token, artistName)
  const [searchRes, topRes] = await Promise.allSettled([
    searchTracks(token, `artist:"${artistName}"`, 50),
    artist ? getArtistTopTracks(token, artist.id) : Promise.resolve(null),
  ])
  const seen = new Set()
  const tracks = []
  for (const t of searchRes.status === 'fulfilled' ? (searchRes.value?.tracks?.items ?? []) : []) {
    if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
  }
  for (const t of topRes.status === 'fulfilled' ? (topRes.value?.tracks ?? []) : []) {
    if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
  }
  LOG(`Step1 | ${artistName} | ${tracks.length} tracks (search + top-tracks)`)
  return { tracks, artistId: artist?.id ?? null, artistName }
}

// Step 2: for each seed, get top 5 related artists → their top-tracks
async function fetchRelatedTracks(token, artistId, artistName) {
  if (!artistId) return []
  let relArtists = []
  try {
    const res = await getRelatedArtists(token, artistId)
    relArtists = (res?.artists ?? []).slice(0, 5)
    LOG(`Step2 | ${artistName} | related: ${relArtists.map((a) => a.name).join(', ')}`)
  } catch (e) {
    LOG(`Step2 | ${artistName} | related-artists failed:`, e.message)
    return []
  }
  const results = await Promise.allSettled(
    relArtists.map((ra) =>
      getArtistTopTracks(token, ra.id).then((r) => ({ name: ra.name, tracks: r?.tracks ?? [] }))
    )
  )
  const tracks = []
  for (const r of results) {
    if (r.status === 'fulfilled') {
      LOG(`Step2 | related ${r.value.name} | ${r.value.tracks.length} tracks`)
      tracks.push(...r.value.tracks)
    }
  }
  return tracks
}

// Energy arc: low → peak (middle) → low using popularity as proxy
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
          {/* Parsed params */}
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

          {/* Pipeline stages */}
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

  const [prompt, setPrompt]         = useState('')
  const [loading, setLoading]       = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const [saving, setSaving]         = useState(false)
  const [playlist, setPlaylist]     = useState(null)
  const [error, setError]           = useState(null)
  const [savedUrl, setSavedUrl]     = useState(null)
  const [debugParams, setDebugParams] = useState(null)
  const [debugStages, setDebugStages] = useState([])

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
      if (!token) throw new Error('Not authenticated')

      // ── Step 0: Parse prompt with Claude ─────────────────────────────────
      const topArtistNames = await ensureSpotifyHistory(token)
      const profile = { ...tasteProfile, lastfmUsername, lastfmData, spotifyTopArtistNames: topArtistNames }
      const params = await getPlaylistParams(text, profile)

      LOG('Claude parsed params:', JSON.stringify(params, null, 2))
      setDebugParams(params)

      // Normalise field names (Claude returns the exact spec schema now)
      const artists      = params.artists ?? []
      const genres       = params.genres ?? []
      const trackCount   = Math.min(Math.max(params.track_count ?? 20, 1), 50)
      const minMs        = params.duration_min_ms ?? null
      const isSingle     = params.isSingleArtistPlaylist === true

      LOG(`artists=[${artists.join(', ')}] genres=[${genres.join(', ')}] count=${trackCount} minMs=${minMs}`)

      // Raw pool — dedup by track ID only, no filtering yet
      const rawPool = new Map()
      const pool = (items) => { for (const t of items) { if (t?.id) rawPool.set(t.id, t) } }

      // ── Step 1: Seed artist tracks (search limit=50 + top-tracks) ─────────
      setLoadingStep(artists.length
        ? `Fetching tracks for ${artists.slice(0, 3).join(', ')}…`
        : 'Searching by genre…')

      const seedResults = await Promise.all(
        artists.slice(0, 10).map((name) =>
          fetchSeedArtistTracks(token, name).catch((e) => {
            LOG(`Step1 | ${name} | error:`, e.message)
            return { tracks: [], artistId: null, artistName: name }
          })
        )
      )
      for (const { tracks } of seedResults) pool(tracks)
      stage('Step 1 — seed artist tracks', rawPool.size)

      // ── Step 2: Related artist expansion (top 5 related per seed) ─────────
      setLoadingStep('Expanding with related artists…')
      const relatedArrays = await Promise.all(
        seedResults
          .filter((r) => r.artistId)
          .map((r) => fetchRelatedTracks(token, r.artistId, r.artistName).catch(() => []))
      )
      for (const tracks of relatedArrays) pool(tracks)
      stage('Step 2 — related artist expansion', rawPool.size)

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
              const res = await getArtistTopTracks(token, artist.id)
              return res?.tracks ?? []
            } catch { return [] }
          })
        )
        for (const tracks of lfmTracks) pool(tracks)
        stage('Step 3 — Last.fm artist tracks', rawPool.size)
      }

      // ── Step 4: Genre searches (limit=50 each) ────────────────────────────
      setLoadingStep('Searching by genre…')
      const genreResults = await Promise.all(
        genres.slice(0, 4).map((g) =>
          searchTracks(token, `genre:${g}`, 50)
            .then((r) => { const items = r?.tracks?.items ?? []; LOG(`genre:${g} → ${items.length}`); return items })
            .catch(() => [])
        )
      )
      for (const tracks of genreResults) pool(tracks)
      stage('Step 4 — genre searches', rawPool.size)

      // ── Step 5: Duration filter + diversity cap ───────────────────────────
      let filtered = Array.from(rawPool.values())
      if (minMs !== null) {
        filtered = filtered.filter((t) => t.duration_ms >= minMs)
        stage(`Step 5a — duration filter (≥${Math.round(minMs / 60000)}min)`, filtered.length)
      }

      filtered.sort(() => Math.random() - 0.5) // shuffle before cap

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
            if (capped.length >= trackCount * 2) break // collect 2× target so shuffle has room
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

        // Layer 1: specific genre:slug searches
        setLoadingStep('Backfilling with genre searches…')
        for (const g of genres) {
          if (capped.length >= trackCount) break
          try {
            const r = await searchTracks(token, `genre:${g}`, 50)
            absorb(r?.tracks?.items ?? [])
            stage(`Backfill L1 — genre:${g}`, capped.length)
          } catch {}
        }

        // Layer 2: broader genre fallbacks
        if (capped.length < trackCount) {
          setLoadingStep('Broadening genre search…')
          const broader = [...new Set(
            genres.flatMap((g) => GENRE_FALLBACKS[g] ?? [g.split('-')[0]])
          )].filter((g) => !genres.includes(g))

          for (const g of broader) {
            if (capped.length >= trackCount) break
            try {
              const r = await searchTracks(token, `genre:${g}`, 50)
              absorb(r?.tracks?.items ?? [])
              stage(`Backfill L2 — genre:${g} (broader)`, capped.length)
            } catch {}
          }
        }

        // Layer 3: mood/energy keyword search
        if (capped.length < trackCount && params.mood) {
          setLoadingStep('Searching by mood…')
          try {
            const r = await searchTracks(token, params.mood, 50)
            absorb(r?.tracks?.items ?? [])
            stage(`Backfill L3 — mood "${params.mood}"`, capped.length)
          } catch {}
        }
      }

      // Only surface an error if ALL three layers were exhausted and we still have nothing
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
          {/* Still show debug panel on error so the user can see what failed */}
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

          {/* Debug panel — collapsible, shown below the tracklist */}
          <DebugPanel params={debugParams} stages={debugStages} />
        </div>
      )}
    </div>
  )
}
