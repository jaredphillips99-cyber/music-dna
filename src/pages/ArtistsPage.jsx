import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, ExternalLink } from 'lucide-react'
import { useSpotify } from '@/hooks/useSpotify'
import { getTopArtists, getRelatedArtists } from '@/lib/spotify'
import { getSimilarArtists } from '@/lib/lastfm'
import useStore from '@/store/useStore'
import clsx from 'clsx'

function ArtistCard({ artist, isNew }) {
  return (
    <div className={clsx('card flex items-center gap-4 transition-all', isNew && 'border-accent/30 bg-accent/5')}>
      {artist.images?.[0]?.url ? (
        <img src={artist.images[0].url} alt={artist.name} className="w-14 h-14 rounded-xl object-cover flex-shrink-0" />
      ) : (
        <div className="w-14 h-14 rounded-xl bg-surface-4 flex-shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold truncate">{artist.name}</p>
          {isNew && <span className="tag text-accent border-accent/30 bg-accent/10 text-xs">New for you</span>}
        </div>
        {artist.genres?.length > 0 && (
          <p className="text-xs text-text-secondary mt-1 truncate">
            {artist.genres.slice(0, 3).join(' · ')}
          </p>
        )}
        {artist.followers?.total && (
          <p className="text-xs text-text-muted mt-0.5">
            {Intl.NumberFormat('en', { notation: 'compact' }).format(artist.followers.total)} followers
          </p>
        )}
      </div>
      {artist.external_urls?.spotify && (
        <a
          href={artist.external_urls.spotify}
          target="_blank"
          rel="noopener noreferrer"
          className="text-text-muted hover:text-text-primary transition-colors flex-shrink-0"
        >
          <ExternalLink className="w-4 h-4" />
        </a>
      )}
    </div>
  )
}

export default function ArtistsPage() {
  const { getToken } = useSpotify()
  const { lastfmUsername } = useStore()
  const [topArtists, setTopArtists] = useState([])
  const [discoveries, setDiscoveries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const token = await getToken()
      if (!token) throw new Error('Not authenticated')

      const data = await getTopArtists(token, 'medium_term', 10)
      setTopArtists(data.items || [])

      // Discover related artists
      const knownIds = new Set((data.items || []).map((a) => a.id))
      const relatedMap = new Map()

      await Promise.all(
        (data.items || []).slice(0, 5).map(async (artist) => {
          try {
            const rel = await getRelatedArtists(token, artist.id)
            ;(rel.artists || []).forEach((ra) => {
              if (!knownIds.has(ra.id)) {
                relatedMap.set(ra.id, {
                  ...ra,
                  score: (relatedMap.get(ra.id)?.score || 0) + 1,
                })
              }
            })
          } catch {}
        })
      )

      // Also merge Last.fm similar artists names for cross-referencing
      if (lastfmUsername && data.items?.length) {
        try {
          const lfmSimilar = await getSimilarArtists(data.items[0].name, 20)
          lfmSimilar.forEach((la) => {
            for (const [, ra] of relatedMap) {
              if (ra.name.toLowerCase() === la.name.toLowerCase()) {
                ra.score += 1
              }
            }
          })
        } catch {}
      }

      const sorted = [...relatedMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)

      setDiscoveries(sorted)
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

  return (
    <div className="space-y-10 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black mb-1">Artists</h1>
          <p className="text-text-secondary">Your current favourites + fresh discoveries.</p>
        </div>
        <button onClick={load} className="btn-ghost flex items-center gap-2 text-sm">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {topArtists.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-widest mb-4">Your Top Artists</h2>
          <div className="grid gap-3">
            {topArtists.map((a) => <ArtistCard key={a.id} artist={a} isNew={false} />)}
          </div>
        </section>
      )}

      {discoveries.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-text-muted uppercase tracking-widest mb-1">Discover</h2>
          <p className="text-xs text-text-secondary mb-4">Artists similar to your favourites that you might not know yet.</p>
          <div className="grid gap-3">
            {discoveries.map((a) => <ArtistCard key={a.id} artist={a} isNew={true} />)}
          </div>
        </section>
      )}
    </div>
  )
}
