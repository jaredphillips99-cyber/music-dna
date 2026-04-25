import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import { Compass, BarChart3, Users, LogOut, Dna } from 'lucide-react'
import useStore from '@/store/useStore'
import clsx from 'clsx'

const navItems = [
  { to: '/', label: 'Discover', icon: Compass, exact: true },
  { to: '/artists', label: 'Artists', icon: Users },
  { to: '/stats', label: 'Stats', icon: BarChart3 },
]

export default function Layout() {
  const { spotifyUser, clearSpotifyAuth } = useStore()
  const navigate = useNavigate()

  function handleLogout() {
    clearSpotifyAuth()
    navigate('/login')
  }

  return (
    <div className="flex min-h-screen bg-surface">
      {/* Sidebar */}
      <aside className="hidden md:flex flex-col w-64 bg-surface-1 border-r border-surface-3 p-6 fixed h-full z-20">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-10">
          <div className="w-9 h-9 rounded-xl bg-gradient-brand flex items-center justify-center">
            <Dna className="w-5 h-5 text-black" />
          </div>
          <span className="font-bold text-xl tracking-tight">Music DNA</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-1">
          {navItems.map(({ to, label, icon: Icon, exact }) => (
            <NavLink
              key={to}
              to={to}
              end={exact}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-150',
                  isActive
                    ? 'bg-accent/10 text-accent border border-accent/20'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-3'
                )
              }
            >
              <Icon className="w-4 h-4" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* User */}
        {spotifyUser && (
          <div className="border-t border-surface-3 pt-4 mt-4">
            <div className="flex items-center gap-3 mb-3">
              {spotifyUser.images?.[0]?.url ? (
                <img
                  src={spotifyUser.images[0].url}
                  alt={spotifyUser.display_name}
                  className="w-9 h-9 rounded-full object-cover"
                />
              ) : (
                <div className="w-9 h-9 rounded-full bg-surface-4 flex items-center justify-center text-sm font-bold">
                  {spotifyUser.display_name?.[0]?.toUpperCase()}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{spotifyUser.display_name}</p>
                <p className="text-xs text-text-muted">Spotify</p>
              </div>
            </div>
            <button onClick={handleLogout} className="btn-ghost w-full text-left flex items-center gap-2 text-sm text-text-muted hover:text-red-400">
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
          </div>
        )}
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-20 bg-surface-1 border-b border-surface-3 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-brand flex items-center justify-center">
            <Dna className="w-4 h-4 text-black" />
          </div>
          <span className="font-bold text-lg">Music DNA</span>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-surface-1 border-t border-surface-3 px-2 py-2 flex justify-around">
        {navItems.map(({ to, label, icon: Icon, exact }) => (
          <NavLink
            key={to}
            to={to}
            end={exact}
            className={({ isActive }) =>
              clsx(
                'flex flex-col items-center gap-1 px-4 py-2 rounded-xl text-xs font-medium transition-colors',
                isActive ? 'text-accent' : 'text-text-muted'
              )
            }
          >
            <Icon className="w-5 h-5" />
            {label}
          </NavLink>
        ))}
      </div>

      {/* Main content */}
      <main className="flex-1 md:ml-64 pt-16 md:pt-0 pb-20 md:pb-0">
        <div className="max-w-4xl mx-auto px-4 md:px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
