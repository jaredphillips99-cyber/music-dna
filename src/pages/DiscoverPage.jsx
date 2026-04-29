import { useState } from 'react'
import { Send, Loader2, Save, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import useStore from '@/store/useStore'
import { useSpotify } from '@/hooks/useSpotify'
import { getPlaylistParams } from '@/lib/claude'
import {
  searchArtists,
  searchArtistStrict,
  searchTracksPage,
  searchTracksPaginated,
  getTopArtists,
  getTopTracks,
  getArtistAlbums,
  getAlbumTracks,
  getArtist,
  getMe,
  createPlaylist,
  addTracksToPlaylist,
  spotifyHealthCheck,
  refreshAccessToken,
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

// Keyword search terms per genre slug (plain text, tries genre: prefix first in searchGenreWithFallback)
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

// Spotify genre tag synonyms used for genre verification.
// Spotify's artist genre tags use spaces not hyphens ("deep house" not "deep-house").
// Each entry maps a Claude genre slug to the terms that must appear in an artist's tag list.
const GENRE_SYNONYMS = {
  'deep-house':     [['deep house'], ['organic house'], ['melodic deep house']],
  'melodic-house':  [['melodic house'], ['organic house'], ['progressive house']],
  'tech-house':     [['tech house'], ['minimal tech'], ['techno']],
  'melodic-techno': [['melodic techno'], ['melodic techno'], ['dark techno']],
  'afro-house':     [['afro house'], ['afrobeats'], ['tribal house']],
  'drum-and-bass':  [['drum and bass'], ['dnb'], ['liquid funk']],
  'lo-fi':          [['lo-fi'], ['lofi'], ['chillhop']],
  'hip-hop':        [['hip hop'], ['rap'], ['trap']],
  'indie-pop':      [['indie pop'], ['indie rock'], ['alternative']],
  'r-n-b':          [['r&b'], ['soul'], ['neo soul']],
}

// Returns true if any of the artist's Spotify genre tags match the requested genre slug
function genreMatchesRequested(artistGenres, requestedGenres) {
  if (!artistGenres.length) return null // null = unknown, not rejected
  const artistStr = artistGenres.join(' ').toLowerCase()
  for (const slug of requestedGenres) {
    // Check GENRE_SYNONYMS: each synonym is an array of keywords that must ALL appear
    const synonymGroups = GENRE_SYNONYMS[slug] ?? [[slug.replace(/-/g, ' ')]]
    for (const keywords of synonymGroups) {
      if (keywords.every((kw) => artistStr.includes(kw.toLowerCase()))) return true
    }
  }
  return false
}

// Fetches + caches artist genre tags. Cache is scoped to one generate() call.
async function getArtistGenres(token, artistId, cache) {
  if (cache.has(artistId)) return cache.get(artistId)
  try {
    const a = await getArtist(token, artistId)
    const genres = a?.genres ?? []
    cache.set(artistId, genres)
    return genres
  } catch {
    cache.set(artistId, [])
    return []
  }
}

// Classifies tracks as genre-verified, unverified (no tag data), or rejected.
// Only looks up each unique artist ID once. Runs in parallel chunks of 15.
async function verifyPoolGenres(token, tracks, requestedGenres, cache) {
  const uniqueIds = [...new Set(
    tracks.map((t) => t.artists?.[0]?.id).filter(Boolean),
  )].filter((id) => !cache.has(id))

  const CHUNK = 15
  for (let i = 0; i < uniqueIds.length; i += CHUNK) {
    await Promise.allSettled(
      uniqueIds.slice(i, i + CHUNK).map((id) => getArtistGenres(token, id, cache)),
    )
  }

  const verified = [], unverified = [], rejected = []
  for (const t of tracks) {
    const genres = cache.get(t.artists?.[0]?.id) ?? []
    const match = genreMatchesRequested(genres, requestedGenres)
    if (match === null) unverified.push(t)
    else if (match)     verified.push(t)
    else                rejected.push(t)
  }
  return { verified, unverified, rejected }
}

// Known essential artists by era/genre — used as fallback when year-filtered pool is thin
const ERA_SEED_ARTISTS = {
  'hip-hop-90s': [
    'Notorious B.I.G', 'Tupac Shakur', 'Nas', 'Jay-Z', 'Wu-Tang Clan',
    'Snoop Dogg', 'DMX', 'Lauryn Hill', 'OutKast', 'Rakim',
  ],
}

// Extracts the 4-digit release year from a Spotify track's album.release_date field.
// release_date can be "YYYY", "YYYY-MM", or "YYYY-MM-DD".
function getTrackYear(track) {
  const d = track.album?.release_date
  if (!d) return null
  const y = parseInt(d.slice(0, 4), 10)
  return isNaN(y) ? null : y
}

// Builds Spotify's year: filter syntax for use in search queries.
// e.g. buildYearFilter(1990, 1999) → " year:1990-1999"
function buildYearFilter(minYear, maxYear) {
  if (!minYear && !maxYear) return ''
  const lo = minYear ?? 1900
  const hi = maxYear ?? new Date().getFullYear()
  return ` year:${lo}-${hi}`
}

// Genre search: tries q=genre:{slug} first (Spotify field filter), then falls back
// to plain-text keyword variants from GENRE_KEYWORDS. The yearFilter string (e.g.
// " year:1990-1999") is appended to every query for API-level era filtering.
async function searchGenreWithFallback(token, genreSlug, want = 30, yearFilter = '') {
  // Attempt 1: genre: field filter + year
  try {
    const r = await searchTracksPaginated(token, `genre:${genreSlug}${yearFilter}`, want)
    if (r.length > 0) {
      LOG(`searchGenre | genre:${genreSlug}${yearFilter} → ${r.length} tracks`)
      return r
    }
    LOG(`searchGenre | genre:${genreSlug} returned 0, trying keywords`)
  } catch (e) {
    LOG(`searchGenre | genre:${genreSlug} error: ${e.message}`)
  }

  // Attempt 2: keyword variants (plain text) + year
  const keywords = GENRE_KEYWORDS[genreSlug] ?? [genreSlug.replace(/-/g, ' ')]
  const seen = new Set()
  const tracks = []
  for (const kw of keywords.slice(0, 3)) {
    if (tracks.length >= want) break
    try {
      const r = await searchTracksPaginated(token, `${kw}${yearFilter}`, want)
      for (const t of r) {
        if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
      }
      LOG(`searchGenre | "${kw}${yearFilter}" → ${r.length} tracks`)
    } catch (e) {
      LOG(`searchGenre | "${kw}" error: ${e.message}`)
    }
  }
  return tracks
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
          album: { id: album.id, name: album.name, images: album.images ?? [], release_date: album.release_date },
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

function DebugPanel({ params, stages, diag }) {
  const [open, setOpen] = useState(false)
  if (!params && !diag) return null
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

          {/* Auth diagnostics — shown first so auth failures are immediately visible */}
          {diag && (
            <div>
              <p className="text-text-muted uppercase tracking-widest mb-2">Auth diagnostics</p>
              <div className="space-y-1">
                <div className="flex gap-2">
                  <span className={`font-bold ${diag.health?.ok ? 'text-green-400' : 'text-red-400'}`}>
                    GET /me → {diag.health?.status ?? '?'}
                  </span>
                  <span className="text-text-muted truncate">{diag.health?.summary}</span>
                </div>
                {diag.health?.rawBody && (
                  <p className="text-text-muted break-all leading-relaxed">{diag.health.rawBody}</p>
                )}
                {diag.testSearch && (
                  <div className="flex gap-2 mt-1">
                    <span className={`font-bold ${diag.testSearch.error ? 'text-red-400' : 'text-green-400'}`}>
                      GET /search?q=Drake → {diag.testSearch.error ? 'ERROR' : `${diag.testSearch.count} tracks`}
                    </span>
                    {diag.testSearch.error && (
                      <span className="text-red-400 truncate">{diag.testSearch.error}</span>
                    )}
                  </div>
                )}
                {diag.refreshAttempted && (
                  <p className={`mt-1 ${diag.refreshOk ? 'text-green-400' : 'text-red-400'}`}>
                    Token refresh: {diag.refreshOk ? 'succeeded' : `failed — ${diag.refreshError}`}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Claude params */}
          {params && (
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
                <Row label="use_library" value={String(params.use_library ?? false)} />
                <Row label="single_artist" value={String(params.isSingleArtistPlaylist ?? false)} />
                <Row label="release_year_min" value={params.release_year_min ?? '—'} />
                <Row label="release_year_max" value={params.release_year_max ?? '—'} />
                <Row label="sort_by_hits" value={String(params.sort_by_hits ?? false)} />
              </div>
            </div>
          )}

          {/* Pipeline stages with optional genre confidence column */}
          {stages?.length > 0 && (
            <div>
              <p className="text-text-muted uppercase tracking-widest mb-2">Pipeline stages</p>
              <table className="w-full border-collapse">
                <tbody>
                  {stages.map(({ label, count, verified, total }) => (
                    <tr key={label} className="border-b border-surface-3 last:border-0">
                      <td className="py-1 pr-4 text-text-secondary">{label}</td>
                      <td className="py-1 text-right text-accent font-semibold">{count}</td>
                      {verified != null && (
                        <td className="py-1 pl-4 text-right text-text-muted">
                          {verified}/{total} genre✓
                        </td>
                      )}
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
  const [debugDiag, setDebugDiag]     = useState(null)

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
    setDebugDiag(null)

    const stages = []
    // verified/total are optional — only set on the genre-verification stage
    const stage = (label, count, verified = null, total = null) => {
      stages.push({ label, count, verified, total })
      if (verified != null) LOG(`[${label}]: ${count} tracks (${verified}/${total} genre-verified)`)
      else                  LOG(`[${label}]: ${count} tracks`)
    }

    // Accumulate diagnostics as we go so the panel updates live
    const diag = {}
    const pushDiag = (patch) => { Object.assign(diag, patch); setDebugDiag({ ...diag }) }

    try {
      let token = await getToken()
      if (!token) throw new Error('Not authenticated — please reconnect Spotify')

      const { spotifyTokenExpiry } = useStore.getState()
      LOG(`Token: ${token.slice(0, 8)}… stored expiry in ${Math.round((spotifyTokenExpiry - Date.now()) / 1000)}s`)

      // ── Auth health check ─────────────────────────────────────────────────
      // Calls GET /me with the current token. Returns the raw HTTP status so
      // we can distinguish 401 (expired/invalid token) from 403 (missing scope).
      setLoadingStep('Verifying Spotify auth…')
      let health = await spotifyHealthCheck(token)
      LOG(`Health check: ${health.status}`, JSON.stringify(health.body).slice(0, 200))
      pushDiag({
        health: {
          status: health.status,
          ok: health.ok,
          summary: health.ok
            ? `Logged in as ${health.body?.display_name || health.body?.id || 'unknown'}`
            : health.body?.error?.message || JSON.stringify(health.body).slice(0, 100),
          rawBody: JSON.stringify(health.body).slice(0, 200),
        },
      })

      // If token is rejected, attempt one force-refresh before giving up
      if (!health.ok && health.status === 401) {
        LOG('Token rejected — attempting force-refresh')
        pushDiag({ refreshAttempted: true })
        try {
          const { spotifyRefreshToken, setSpotifyAuth } = useStore.getState()
          const refreshed = await refreshAccessToken(spotifyRefreshToken)
          setSpotifyAuth(
            refreshed.access_token,
            refreshed.refresh_token || spotifyRefreshToken,
            refreshed.expires_in,
          )
          token = refreshed.access_token
          LOG('Force-refresh succeeded, re-checking health')
          pushDiag({ refreshOk: true })

          // Re-run health check with new token
          health = await spotifyHealthCheck(token)
          LOG(`Health check (post-refresh): ${health.status}`)
          pushDiag({
            health: {
              status: health.status,
              ok: health.ok,
              summary: health.ok
                ? `Logged in as ${health.body?.display_name || health.body?.id} (after refresh)`
                : health.body?.error?.message || JSON.stringify(health.body).slice(0, 100),
              rawBody: JSON.stringify(health.body).slice(0, 200),
            },
          })
        } catch (e) {
          LOG('Force-refresh failed:', e.message)
          pushDiag({ refreshOk: false, refreshError: e.message })
        }
      }

      if (!health.ok) {
        if (health.status === 401)
          throw new Error('Spotify auth failed (401) — token is invalid or expired. Please disconnect and reconnect Spotify.')
        if (health.status === 403)
          throw new Error('Spotify permission denied (403) — a required scope is missing. Please disconnect and reconnect Spotify to grant fresh permissions.')
        throw new Error(`Spotify API error ${health.status}: ${JSON.stringify(health.body).slice(0, 100)}`)
      }

      // ── Test search: hardcoded Drake query to verify search works at all ──
      LOG('Running test search: q=Drake')
      try {
        const testRes = await searchTracksPage(token, 'Drake', 0)
        const testCount = testRes?.tracks?.items?.length ?? 0
        LOG(`Test search (Drake): ${testCount} tracks, first="${testRes?.tracks?.items?.[0]?.name}"`)
        pushDiag({ testSearch: { count: testCount, error: null } })
      } catch (e) {
        LOG('Test search (Drake) FAILED:', e.message)
        pushDiag({ testSearch: { count: 0, error: e.message } })
      }

      // ── Step 0: Parse prompt with Claude ─────────────────────────────────
      const topArtistNames = await ensureSpotifyHistory(token)
      const profile = { ...tasteProfile, lastfmUsername, lastfmData, spotifyTopArtistNames: topArtistNames }
      const params = await getPlaylistParams(text, profile)

      LOG('Claude parsed params:', JSON.stringify(params, null, 2))
      setDebugParams(params)

      if (params.raw) {
        throw new Error('Claude returned an unexpected response format. Please try again.')
      }

      const artists     = params.artists ?? []
      const genres      = params.genres ?? []
      const trackCount  = Math.min(Math.max(params.track_count ?? 20, 1), 50)
      const minMs       = params.duration_min_ms ?? null
      const isSingle    = params.isSingleArtistPlaylist === true
      // use_library: true → user's listening history is a primary source
      //              false → genre/artist/mood request; library is backfill only
      const useLibrary      = params.use_library !== false // default true if absent
      const releaseYearMin  = params.release_year_min ?? null
      const releaseYearMax  = params.release_year_max ?? null
      const sortByHits      = params.sort_by_hits === true
      // yearFilter is appended to every Spotify search query for API-level era filtering
      const yearFilter      = buildYearFilter(releaseYearMin, releaseYearMax)

      LOG(`artists=[${artists.join(', ')}] genres=[${genres.join(', ')}] count=${trackCount} era=${releaseYearMin ?? '?'}-${releaseYearMax ?? '?'} sortByHits=${sortByHits} use_library=${useLibrary}`)

      // Raw pool — dedup by track ID, no filtering until Step 5
      const rawPool = new Map()
      const pool = (items) => { for (const t of items) { if (t?.id) rawPool.set(t.id, t) } }

      // Artist genre cache — scoped to this generate() call to avoid repeat /artists/{id} fetches
      const artistGenreCache = new Map()

      // ── Step 1: User's own top tracks ────────────────────────────────────
      // Primary when use_library=true (taste-based prompt).
      // Skipped when use_library=false (genre/mood request) — added in backfill instead.
      if (useLibrary) {
        setLoadingStep('Loading your listening history…')
        const [medTermTracks, shortTermTracks] = await Promise.allSettled([
          getTopTracks(token, 'medium_term', 50),
          getTopTracks(token, 'short_term', 50),
        ])
        if (medTermTracks.status === 'fulfilled')
          pool(medTermTracks.value?.items ?? [])
        else
          LOG('Step1 | medium_term failed:', medTermTracks.reason?.message)

        if (shortTermTracks.status === 'fulfilled')
          pool(shortTermTracks.value?.items ?? [])
        else
          LOG('Step1 | short_term failed:', shortTermTracks.reason?.message)

        stage('Step 1 — user top tracks (library)', rawPool.size)
      } else {
        LOG('Step1 | skipping user library (use_library=false — genre/mood request)')
        stage('Step 1 — user top tracks (skipped: genre request)', 0)
      }

      // ── Step 2: Seed artist discography ───────────────────────────────────
      // Always runs. Resolves name → artist ID, then fetches full album catalog.
      // Also pre-populates the genre cache from artist objects returned by search.
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

        // Pre-populate genre cache from artist objects (free — we already have them)
        for (const a of seedArtists) {
          if (a?.id && a?.genres) artistGenreCache.set(a.id, a.genres)
        }

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

      // ── Step 3: User's top artist discography ────────────────────────────
      // Primary when use_library=true. Skipped for genre requests (use_library=false).
      if (useLibrary) {
        setLoadingStep('Adding from your top artists…')
        try {
          const topArtistsRes = await getTopArtists(token, 'medium_term', 50)
          const topArtistItems = (topArtistsRes?.items ?? [])
            .filter((a) => !artists.some((n) => n.toLowerCase() === a.name.toLowerCase()))
            .slice(0, 8)

          // Pre-populate genre cache
          for (const a of topArtistItems) {
            if (a?.id && a?.genres) artistGenreCache.set(a.id, a.genres)
          }

          LOG(`Step3 | ${topArtistItems.length} top artists to fetch discography`)
          const topArtistTracks = await Promise.all(
            topArtistItems.map((a) =>
              fetchArtistDiscography(token, a.id, a.name, 3).catch(() => [])
            )
          )
          for (const tracks of topArtistTracks) pool(tracks)
          stage('Step 3 — user top artist discography', rawPool.size)
        } catch (e) {
          LOG('Step3 | top artists fetch failed:', e.message)
        }
      } else {
        stage('Step 3 — user top artist discography (skipped)', rawPool.size)
      }

      // ── Step 4: Genre-first searches ──────────────────────────────────────
      // For each genre: tries q=genre:{slug} first, then plain keyword variants.
      // This is the proven order: genre: filter → plain text → artist-based (Step 2).
      // Also searches by mood and artist names to surface featuring tracks.
      setLoadingStep('Searching by genre and mood…')

      const genreSearchResults = await Promise.all(
        genres.slice(0, 4).map((g) =>
          searchGenreWithFallback(token, g, 30, yearFilter).catch((e) => {
            LOG(`Step4 | genre "${g}" error:`, e.message)
            return []
          })
        )
      )
      for (const tracks of genreSearchResults) pool(tracks)

      // Mood + artist name searches also carry the year filter
      const supplementQueries = [
        ...(params.mood ? [params.mood] : []),
        ...artists.slice(0, 3),
      ]
      const supplementResults = await Promise.all(
        supplementQueries.map((q) =>
          searchTracksPaginated(token, `${q}${yearFilter}`, 20).catch(() => [])
        )
      )
      for (const tracks of supplementResults) pool(tracks)

      stage('Step 4 — genre + mood searches', rawPool.size)

      // ── Step 4b: Year hard filter ─────────────────────────────────────────
      // Applied to the full raw pool so tracks from ALL sources (library, discography,
      // search) are era-filtered consistently. album.release_date is already present in
      // track objects from /search, /me/top/tracks, and our enriched discography fetches.
      if (releaseYearMin !== null || releaseYearMax !== null) {
        const before = rawPool.size
        for (const [id, t] of rawPool) {
          const year = getTrackYear(t)
          if (year === null) continue // no date — keep (rather than silently drop)
          if (releaseYearMin !== null && year < releaseYearMin) { rawPool.delete(id); continue }
          if (releaseYearMax !== null && year > releaseYearMax) { rawPool.delete(id) }
        }
        const label = `Step 4b — year filter (${releaseYearMin ?? '?'}–${releaseYearMax ?? '?'})`
        stage(label, rawPool.size)
        LOG(`Year filter removed ${before - rawPool.size} out-of-era tracks, ${rawPool.size} remain`)
      }

      // ── Step 4c: Era-specific fallback for thin pools ─────────────────────
      // If the year-filtered pool is under 15 tracks and the request matches a known
      // era/genre combo, seed with canonical artists from that era and re-apply the
      // year filter to keep only their era-correct releases.
      const isNinetiesRap =
        releaseYearMin !== null && releaseYearMin >= 1990 &&
        releaseYearMax !== null && releaseYearMax <= 1999 &&
        genres.some((g) => ['hip-hop', 'rap'].includes(g.replace(/-/g, ' ')))

      if (isNinetiesRap && rawPool.size < 15) {
        LOG(`Step4c | 90s rap pool thin (${rawPool.size}), seeding era artists`)
        setLoadingStep('Seeding with essential 90s rap artists…')
        const eraResults = await Promise.all(
          ERA_SEED_ARTISTS['hip-hop-90s'].map(async (name) => {
            try {
              const artist = await resolveArtist(token, name)
              if (!artist) return []
              return fetchArtistDiscography(token, artist.id, name, 3)
            } catch { return [] }
          })
        )
        for (const tracks of eraResults) pool(tracks)
        // Re-apply year filter to new additions
        for (const [id, t] of rawPool) {
          const year = getTrackYear(t)
          if (year === null) continue
          if (releaseYearMin !== null && year < releaseYearMin) { rawPool.delete(id); continue }
          if (releaseYearMax !== null && year > releaseYearMax) { rawPool.delete(id) }
        }
        stage('Step 4c — 90s rap era artists', rawPool.size)
      }

      LOG(`Raw pool after all sources: ${rawPool.size} unique tracks`)

      // ── Step 5: Duration filter + popularity bias + diversity cap ─────────
      let filtered = Array.from(rawPool.values())
      if (minMs !== null) {
        filtered = filtered.filter((t) => t.duration_ms >= minMs)
        stage(`Step 5a — duration filter (≥${Math.round(minMs / 60000)}min)`, filtered.length)
      }

      // Sorting strategy depends on the request type.
      // Note: popularity field was removed Feb 2026 — sorts are no-ops when absent.
      if (sortByHits) {
        // "biggest hits / classics / greatest" → sort by popularity DESC so well-known
        // songs surface before deep cuts. Tracks without popularity data go to the end.
        filtered.sort((a, b) => (b.popularity ?? -1) - (a.popularity ?? -1))
        LOG('sortByHits: sorted by popularity desc')
      } else if (genres.length > 0) {
        // Genre-specific (non-hits) requests: prefer mid-range popularity (20-60),
        // which tends to be more genre-accurate than crossover pop (>65).
        filtered.sort((a, b) => {
          const ap = a.popularity, bp = b.popularity
          if (ap == null && bp == null) return 0
          if (ap == null) return -1 // no data → keep early (treat as genre-appropriate)
          if (bp == null) return 1
          const aPenalty = ap > 65 ? ap - 65 : 0
          const bPenalty = bp > 65 ? bp - 65 : 0
          return aPenalty - bPenalty
        })
      } else {
        filtered.sort(() => Math.random() - 0.5)
      }

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

      // ── Step 5c: Genre verification ───────────────────────────────────────
      // Fetches artist genre tags from Spotify and filters out tracks whose artist
      // genres don't match the requested genre. Runs only when genres are specified
      // and the pool is large enough to allow filtering without going below trackCount.
      // Tracks with no genre data are kept as unverified fallback.
      if (genres.length > 0 && capped.length > trackCount) {
        setLoadingStep('Verifying genre accuracy…')
        const { verified, unverified, rejected } = await verifyPoolGenres(
          token, capped, genres, artistGenreCache,
        )
        LOG(`Genre verification: ${verified.length} verified, ${unverified.length} unverified, ${rejected.length} rejected`)
        stage('Step 5c — genre verification', capped.length, verified.length, verified.length + unverified.length + rejected.length)

        if (verified.length >= trackCount) {
          capped = verified
        } else if (verified.length + unverified.length >= trackCount) {
          // Mix verified + unverified; keep rejected out
          capped = [...verified, ...unverified]
        }
        // If even verified+unverified is below target, keep full capped list (include rejected)
      }

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

        // Backfill L1: user's own library — primary if use_library=true was already
        // used, but used here as the FIRST backfill when use_library=false so the
        // library only bleeds in when genre searches didn't produce enough.
        if (!useLibrary && capped.length < trackCount) {
          setLoadingStep('Adding from your library as fallback…')
          const [libMed, libShort] = await Promise.allSettled([
            getTopTracks(token, 'medium_term', 50),
            getTopTracks(token, 'short_term', 50),
          ])
          absorb(libMed.status === 'fulfilled' ? (libMed.value?.items ?? []) : [])
          absorb(libShort.status === 'fulfilled' ? (libShort.value?.items ?? []) : [])
          stage('Backfill L0 — user library (genre fallback)', capped.length)
        }

        // Backfill L2: alternative keyword variants for each genre
        setLoadingStep('Backfilling with broader searches…')
        for (const g of genres) {
          if (capped.length >= trackCount) break
          const alternatives = GENRE_KEYWORDS[g]?.slice(1) ?? [g.split('-')[0]]
          for (const kw of alternatives) {
            if (capped.length >= trackCount) break
            const r = await searchTracksPaginated(token, kw, 30).catch(() => [])
            absorb(r)
            stage(`Backfill L2 — "${kw}"`, capped.length)
          }
        }

        // Backfill L3: last.fm artist discographies
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
              stage(`Backfill L3 — Last.fm: ${name}`, capped.length)
            } catch (e) {
              LOG(`Backfill L3 | ${name} error:`, e.message)
            }
          }
        }

        // Backfill L4: broader mood/energy search
        if (capped.length < trackCount && params.mood) {
          setLoadingStep('Broadening search…')
          const r = await searchTracksPaginated(token, params.mood, 50).catch(() => [])
          absorb(r)
          stage(`Backfill L4 — mood "${params.mood}"`, capped.length)
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
      setDebugDiag({ ...diag })
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
          <DebugPanel params={debugParams} stages={debugStages} diag={debugDiag} />
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

          <DebugPanel params={debugParams} stages={debugStages} diag={debugDiag} />
        </div>
      )}
    </div>
  )
}
