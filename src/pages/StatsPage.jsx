import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Music2 } from 'lucide-react'
import { useSpotify } from '@/hooks/useSpotify'
import { getTopArtists, getTopTracks } from '@/lib/spotify'
import { getTopArtists as lfmTopArtists, getTopTracks as lfmTopTracks, getTopTags } from '@/lib/lastfm'
import { getStatsInsight } from '@/lib/claude'
import useStore from '@/store/useStore'
import clsx from 'clsx'

function StatCard({ label, value, sub }) {
  return (
    <div className="card text-center">
      <p className="text-3xl font-black gradient-text">{value}</p>
      <p className="text-sm font-medium mt-1">{label}</p>
      {sub && <p className="text-xs text-text-muted mt-0.5">{sub}</p>}
    </div>
  )
}

function TagCloud({ tags }) {
  if (!tags?.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {tags.map((t, i) => (
        <span
          key={t.name || t}
          className={clsx('tag', i < 3 && 'border-accent/40 text-accent bg-accent/5')}
        >
          {t.name || t}
        </span>
      ))}
    </div>
  )
}

export default function StatsPage() {
  const { getToken } = useSpotify()
  const { lastfmUsername } = useStore()
  const [data, setData] = useState(null)
  const [insight, setInsight] = useState(null)
  const [loading, setLoading] = useState(true)
  const [insightLoading, setInsightLoading] = useState(false)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Not authenticated')

      const [spotTopArtists, spotTopTracks] = await Promise.all([
        getTopArtists(token, 'medium_term', 10),
        getTopTracks(token, 'medium_term', 10),
      ])

      let lfm = null
      if (lastfmUsername) {
        const [la, lt, tags] = await Promise.all([
          lfmTopArtists(lastfmUsername).catch(() => []),
          lfmTopTracks(lastfmUsername).catch(() => []),
          getTopTags(lastfmUsername, 15).catch(() => []),
        ])
        lfm = { topArtists: la, topTracks: lt, topTags: tags }
      }

      const statsData = {
        spotify: {
          topArtists: spotTopArtists.items || [],
          topTracks: spotTopTracks.items || [],
        },
        lastfm: lfm,
      }

      setData(statsData)

      // Generate Claude insight
      setInsightLoading(true)
      getStatsInsight(statsData)
        .then((r) => setInsight(r.insight))
        .catch(() => {})
        .finally(() => setInsightLoading(false))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="w-6 h-6 text-accent animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="card border-red-500/20 bg-red-500/5 text-center py-12">
        <p className="text-red-400 mb-4">{error}</p>
        <button onClick={load} className="btn-secondary text-sm">Try again</button>
      </div>
    )
  }

  const sp = data?.spotify
  const lfm = data?.lastfm

  return (
    <div className="space-y-10 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black mb-1">Stats</h1>
          <p className="text-text-secondary">Your listening personality, decoded.</p>
        </div>
        <button onClick={load} className="btn-ghost flex items-center gap-2 text-sm">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* AI Insight */}
      <div className="card border-purple-brand/20 bg-gradient-to-br from-purple-brand/10 to-accent/5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple-brand/20 flex items-center justify-center flex-shrink-0">
            <Music2 className="w-4 h-4 text-purple-light" />
          </div>
          <div>
            <p className="text-xs font-semibold text-purple-light uppercase tracking-widest mb-2">Your Listening Personality</p>
            {insightLoading ? (
              <div className="flex items-center gap-2 text-text-secondary text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Claude is analysing your taste…
              </div>
            ) : insight ? (
              <p className="text-sm leading-relaxed text-text-secondary">{insight}</p>
            ) : (
              <p className="text-sm text-text-muted">Connect Last.fm for a deeper personality insight.</p>
            )}
          </div>
        </div>
      </div>

      {/* Quick stats */}
      {lfm && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <StatCard label="Top Artists" value={lfm.topArtists.length} sub="Last 6 months" />
          <StatCard label="Top Tracks" value={lfm.topTracks.length} sub="Last 6 months" />
          <StatCard label="Genre Tags" value={lfm.topTags.length} sub="By scrobbles" />
        </div>
      )}

      {/* Top Spotify Artists */}
      {sp?.topArtists?.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-widest mb-4">Top Artists · Spotify</h2>
          <div className="space-y-2">
            {sp.topArtists.map((a, i) => (
              <div key={a.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-2 transition-colors">
                <span className="text-text-muted text-sm w-5 text-right">{i + 1}</span>
                {a.images?.[0]?.url ? (
                  <img src={a.images[0].url} alt={a.name} className="w-9 h-9 rounded-full object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-full bg-surface-4" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{a.name}</p>
                  <p className="text-xs text-text-muted truncate">{a.genres?.slice(0, 2).join(', ')}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Top Tracks */}
      {sp?.topTracks?.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-widest mb-4">Top Tracks · Spotify</h2>
          <div className="space-y-2">
            {sp.topTracks.map((t, i) => (
              <div key={t.id} className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-2 transition-colors">
                <span className="text-text-muted text-sm w-5 text-right">{i + 1}</span>
                {t.album?.images?.[0]?.url ? (
                  <img src={t.album.images[0].url} alt={t.album.name} className="w-9 h-9 rounded-lg object-cover" />
                ) : (
                  <div className="w-9 h-9 rounded-lg bg-surface-4" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{t.name}</p>
                  <p className="text-xs text-text-muted truncate">{t.artists?.map((a) => a.name).join(', ')}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Genre tags */}
      {lfm?.topTags?.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-widest mb-4">Genre DNA · Last.fm</h2>
          <TagCloud tags={lfm.topTags} />
        </section>
      )}

      {/* Last.fm top artists */}
      {lfm?.topArtists?.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-widest mb-4">Top Artists · Last.fm</h2>
          <div className="space-y-2">
            {lfm.topArtists.slice(0, 10).map((a, i) => (
              <div key={a.name} className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-2 transition-colors">
                <span className="text-text-muted text-sm w-5 text-right">{i + 1}</span>
                <div className="flex-1">
                  <p className="text-sm font-medium">{a.name}</p>
                  {a.playcount && (
                    <p className="text-xs text-text-muted">
                      {Intl.NumberFormat('en', { notation: 'compact' }).format(a.playcount)} plays
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!lastfmUsername && (
        <div className="card text-center py-10 border-dashed">
          <p className="text-text-secondary text-sm mb-2">Connect Last.fm for full stats</p>
          <p className="text-xs text-text-muted">Import your Last.fm username from the Discover page.</p>
        </div>
      )}
    </div>
  )
}
