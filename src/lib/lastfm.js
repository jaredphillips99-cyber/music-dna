const API_KEY = import.meta.env.VITE_LASTFM_API_KEY
const BASE = 'https://ws.audioscrobbler.com/2.0'

async function lfmFetch(params) {
  const q = new URLSearchParams({ ...params, api_key: API_KEY, format: 'json' })
  const res = await fetch(`${BASE}?${q}`)
  if (!res.ok) throw new Error(`Last.fm API error ${res.status}`)
  const data = await res.json()
  if (data.error) throw new Error(data.message || 'Last.fm error')
  return data
}

export async function getUserInfo(username) {
  const data = await lfmFetch({ method: 'user.getinfo', user: username })
  return data.user
}

export async function getTopArtists(username, period = '6month', limit = 20) {
  const data = await lfmFetch({ method: 'user.gettopartists', user: username, period, limit })
  return data.topartists?.artist || []
}

export async function getTopTracks(username, period = '6month', limit = 20) {
  const data = await lfmFetch({ method: 'user.gettoptracks', user: username, period, limit })
  return data.toptracks?.track || []
}

export async function getTopTags(username, limit = 10) {
  const data = await lfmFetch({ method: 'user.gettoptags', user: username, limit })
  return data.toptags?.tag || []
}

export async function getSimilarArtists(artistName, limit = 10) {
  const data = await lfmFetch({ method: 'artist.getsimilar', artist: artistName, limit })
  return data.similarartists?.artist || []
}

export async function getArtistTags(artistName) {
  const data = await lfmFetch({ method: 'artist.gettoptags', artist: artistName })
  return data.toptags?.tag?.slice(0, 5) || []
}

export async function importUserData(username) {
  const [info, topArtists, topTracks, topTags] = await Promise.all([
    getUserInfo(username).catch(() => null),
    getTopArtists(username).catch(() => []),
    getTopTracks(username).catch(() => []),
    getTopTags(username).catch(() => []),
  ])

  return { info, topArtists, topTracks, topTags, username }
}
