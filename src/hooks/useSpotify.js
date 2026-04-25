import { useCallback } from 'react'
import useStore from '@/store/useStore'
import { refreshAccessToken } from '@/lib/spotify'

export function useSpotify() {
  const { spotifyToken, spotifyRefreshToken, isTokenExpired, setSpotifyAuth } = useStore()

  const getToken = useCallback(async () => {
    if (!spotifyToken) return null
    if (!isTokenExpired()) return spotifyToken

    try {
      const data = await refreshAccessToken(spotifyRefreshToken)
      setSpotifyAuth(
        data.access_token,
        data.refresh_token || spotifyRefreshToken,
        data.expires_in
      )
      return data.access_token
    } catch {
      return null
    }
  }, [spotifyToken, spotifyRefreshToken, isTokenExpired, setSpotifyAuth])

  return { getToken, isAuthenticated: !!spotifyToken }
}
