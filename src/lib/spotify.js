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

export const getTopArtists = (token, timeRange = 'medium_term', limit = 20) =>
  spotifyFetch(`/me/top/artists?time_range=${timeRange}&limit=${limit}`, token)

export const getTopTracks = (token, timeRange = 'medium_term', limit = 20) =>
  spotifyFetch(`/me/top/tracks?time_range=${timeRange}&limit=${limit}`, token)

export const getRecentlyPlayed = (token, limit = 20) =>
  spotifyFetch(`/me/player/recently-played?limit=${limit}`, token)

export const getRecommendations = (token, params) => {
  const q = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') q.set(k, v)
  })
  return spotifyFetch(`/recommendations?${q}`, token)
}

export const getRelatedArtists = (token, artistId) =>
  spotifyFetch(`/artists/${artistId}/related-artists`, token)

export const getArtist = (token, artistId) =>
  spotifyFetch(`/artists/${artistId}`, token)

export const searchArtists = (token, query, limit = 5) =>
  spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=artist&limit=${limit}`, token)

export async function createPlaylist(token, userId, name, description) {
  return spotifyFetch(`/users/${userId}/playlists`, token, {
    method: 'POST',
    body: JSON.stringify({ name, description, public: false }),
  })
}

export async function addTracksToPlaylist(token, playlistId, trackUris) {
  return spotifyFetch(`/playlists/${playlistId}/tracks`, token, {
    method: 'POST',
    body: JSON.stringify({ uris: trackUris }),
  })
}
