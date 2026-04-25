import { Routes, Route, Navigate } from 'react-router-dom'
import useStore from '@/store/useStore'
import Layout from '@/components/Layout/Layout'
import LoginPage from '@/pages/LoginPage'
import CallbackPage from '@/pages/CallbackPage'
import OnboardingPage from '@/pages/OnboardingPage'
import DiscoverPage from '@/pages/DiscoverPage'
import StatsPage from '@/pages/StatsPage'
import ArtistsPage from '@/pages/ArtistsPage'

export default function App() {
  const { spotifyToken, onboardingComplete } = useStore()
  const isAuth = !!spotifyToken

  return (
    <Routes>
      <Route path="/callback" element={<CallbackPage />} />
      <Route
        path="/login"
        element={isAuth ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/onboarding"
        element={
          !isAuth ? <Navigate to="/login" replace /> :
          onboardingComplete ? <Navigate to="/" replace /> :
          <OnboardingPage />
        }
      />
      <Route
        path="/"
        element={
          !isAuth ? <Navigate to="/login" replace /> :
          !onboardingComplete ? <Navigate to="/onboarding" replace /> :
          <Layout />
        }
      >
        <Route index element={<DiscoverPage />} />
        <Route path="artists" element={<ArtistsPage />} />
        <Route path="stats" element={<StatsPage />} />
      </Route>
    </Routes>
  )
}
