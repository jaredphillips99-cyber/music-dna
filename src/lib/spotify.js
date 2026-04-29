const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID
const REDIRECT_URI = import.meta.env.VITE_SPOTIFY_REDIRECT_URI || `${window.location.origin}/callback`
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-top-read',
  'user-read-recently-played',
  'playlist-modify-public',
  'playlist-modify-private',
  'playlist-read-private',
].join(' ')

// --- OAuth ---

export function getAuthUrl() {
  const state = crypto.randomUUID()
  sessionStorage.setItem('spotify_oauth_state', state)

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    show_dialog: 'false',
  })

  return `https://accounts.spotify.com/authorize?${params}`
}

export async function exchangeCode(code) {
  const res = await fetch('/api/auth/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, redirectUri: REDIRECT_URI }),
  })
  if (!res.ok) throw new Error('Token exchange failed')
  return res.json()
}

export async function refreshAccessToken(refreshToken) {
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  })
  if (!res.ok) throw new Error('Token refresh failed')
  return res.json()
}

// --- API helpers ---

async function spotifyFetch(path, token, options = {}) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Spotify API error ${res.status}`)
  }
  if (res.status === 204) return null
  return res.json()
}

export const getMe = (token) => spotifyFetch('/me', token)

// Health check — returns raw status + body without throwing, so callers can inspect auth errors
export async function spotifyHealthCheck(token) {
  const res = await fetch('https://api.spotify.com/v1/me', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, ok: res.ok, body }
}

// /me/top/artists and /me/top/tracks support limit up to 50
export const getTopArtists = (token, timeRange = 'medium_term', limit = 50) =>
  spotifyFetch(`/me/top/artists?time_range=${timeRange}&limit=${limit}`, token)

export const getTopTracks = (token, timeRange = 'medium_term', limit = 50) =>
  spotifyFetch(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`, token)

export const getRecentlyPlayed = (token, limit = 20) =>
  spotifyFetch(`/me/player/recently-played?limit=${limit}`, token)

// Artist search — limit capped at 10 per Feb 2026 search restrictions
export const searchArtists = (token, query, limit = 5) =>
  spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=artist&limit=${Math.min(limit, 10)}`, token)

export const searchArtistStrict = (token, name) =>
  spotifyFetch(`/search?q=${encodeURIComponent(`artist:"${name}"`)}&type=artist&limit=1`, token)

// Single-page track search — limit capped at 10 per Feb 2026 search restrictions
// Use searchTracksPaginated for larger result sets
export const searchTracksPage = (token, query, offset = 0) =>
  spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track&limit=10&offset=${offset}`, token)

// Paginated track search — fetches up to `want` tracks across multiple pages of 10
export async function searchTracksPaginated(token, query, want = 30) {
  const tracks = []
  const seen = new Set()
  let offset = 0
  while (tracks.length < want) {
    let items
    try {
      const r = await searchTracksPage(token, query, offset)
      items = r?.tracks?.items ?? []
    } catch (e) {
      console.log('[MusicDNA] searchTracksPaginated error:', query, offset, e.message)
      break
    }
    for (const t of items) {
      if (t?.id && !seen.has(t.id)) { seen.add(t.id); tracks.push(t) }
    }
    if (items.length < 10) break // no more pages
    offset += 10
  }
  return tracks
}

// Discography — /artists/{id}/albums + /albums/{id}/tracks
// GET /artists/{id}/top-tracks was removed in the Feb 2026 API update
export const getArtistAlbums = (token, artistId, limit = 10) =>
  spotifyFetch(`/artists/${artistId}/albums?include_groups=album,single&limit=${limit}`, token)

export const getAlbumTracks = (token, albumId) =>
  spotifyFetch(`/albums/${albumId}/tracks?limit=10`, token)

export const getArtist = (token, artistId) =>
  spotifyFetch(`/artists/${artistId}`, token)

export async function createPlaylist(token, userId, name, description) {
  return spotifyFetch(`/users/${userId}/playlists`, token, {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false }),
  })
}

// Feb 2026: endpoint renamed from /playlists/{id}/tracks → /playlists/{id}/items
export async function addTracksToPlaylist(token, playlistId, trackUris) {
  return spotifyFetch(`/playlists/${playlistId}/items`, token, {
    method: 'POST',
    body: JSON.stringify({ uris: trackUris }),
  })
}
