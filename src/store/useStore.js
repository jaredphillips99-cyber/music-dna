import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const useStore = create(
  persist(
    (set, get) => ({
      // Auth
      spotifyToken: null,
      spotifyRefreshToken: null,
      spotifyTokenExpiry: null,
      spotifyUser: null,

      setSpotifyAuth: (token, refreshToken, expiresIn) =>
        set({
          spotifyToken: token,
          spotifyRefreshToken: refreshToken,
          spotifyTokenExpiry: Date.now() + expiresIn * 1000,
        }),

      setSpotifyUser: (user) => set({ spotifyUser: user }),

      clearSpotifyAuth: () =>
        set({
          spotifyToken: null,
          spotifyRefreshToken: null,
          spotifyTokenExpiry: null,
          spotifyUser: null,
        }),

      isTokenExpired: () => {
        const { spotifyTokenExpiry } = get()
        if (!spotifyTokenExpiry) return true
        return Date.now() > spotifyTokenExpiry - 60_000
      },

      // Last.fm
      lastfmUsername: null,
      lastfmData: null,
      setLastfmUsername: (username) => set({ lastfmUsername: username }),
      setLastfmData: (data) => set({ lastfmData: data }),

      // Cached Spotify listening history (top artist names, used to enrich Claude prompts)
      spotifyTopArtistNames: null,
      setSpotifyTopArtistNames: (names) => set({ spotifyTopArtistNames: names }),

      // Taste profile (from onboarding quiz or imported data)
      tasteProfile: null,
      onboardingComplete: false,
      setTasteProfile: (profile) => set({ tasteProfile: profile, onboardingComplete: true }),

      // Current playlist
      currentPlaylist: null,
      isGenerating: false,
      setCurrentPlaylist: (playlist) => set({ currentPlaylist: playlist }),
      setIsGenerating: (val) => set({ isGenerating: val }),

      // UI
      activeTab: 'discover',
      setActiveTab: (tab) => set({ activeTab: tab }),
    }),
    {
      name: 'music-dna-store',
      partialize: (state) => ({
        spotifyToken: state.spotifyToken,
        spotifyRefreshToken: state.spotifyRefreshToken,
        spotifyTokenExpiry: state.spotifyTokenExpiry,
        spotifyUser: state.spotifyUser,
        lastfmUsername: state.lastfmUsername,
        tasteProfile: state.tasteProfile,
        onboardingComplete: state.onboardingComplete,
        spotifyTopArtistNames: state.spotifyTopArtistNames,
      }),
    }
  )
)

export default useStore
