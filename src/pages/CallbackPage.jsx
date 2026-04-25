import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { exchangeCode, getMe } from '@/lib/spotify'
import useStore from '@/store/useStore'
import { Dna } from 'lucide-react'

export default function CallbackPage() {
  const navigate = useNavigate()
  const { setSpotifyAuth, setSpotifyUser, onboardingComplete } = useStore()
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    handled.current = true

    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const error = params.get('error')
    const state = params.get('state')
    const savedState = sessionStorage.getItem('spotify_oauth_state')

    if (error || !code) {
      navigate('/login')
      return
    }

    if (state !== savedState) {
      console.warn('OAuth state mismatch')
      navigate('/login')
      return
    }

    sessionStorage.removeItem('spotify_oauth_state')

    exchangeCode(code)
      .then(async (data) => {
        setSpotifyAuth(data.access_token, data.refresh_token, data.expires_in)
        const user = await getMe(data.access_token)
        setSpotifyUser(user)
        navigate(onboardingComplete ? '/' : '/onboarding', { replace: true })
      })
      .catch(() => navigate('/login'))
  }, [])

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <div className="text-center animate-fade-in">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-brand mb-6 animate-pulse-slow">
          <Dna className="w-7 h-7 text-black" />
        </div>
        <p className="text-text-secondary">Connecting your Spotify account…</p>
      </div>
    </div>
  )
}
