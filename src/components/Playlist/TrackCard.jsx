import { ExternalLink } from 'lucide-react'

function msToTime(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export default function TrackCard({ track, index }) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-xl hover:bg-surface-2 transition-colors group">
      <span className="text-text-muted text-sm w-6 text-right flex-shrink-0">{index + 1}</span>

      {track.album?.images?.[0]?.url && (
        <img
          src={track.album.images[0].url}
          alt={track.album.name}
          className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
        />
      )}

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{track.name}</p>
        <p className="text-xs text-text-secondary truncate">
          {track.artists?.map((a) => a.name).join(', ')}
          {track.album?.name && ` · ${track.album.name}`}
        </p>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        <span className="text-xs text-text-muted hidden sm:block">
          {msToTime(track.duration_ms)}
        </span>
        {track.external_urls?.spotify && (
          <a
            href={track.external_urls.spotify}
            target="_blank"
            rel="noopener noreferrer"
            className="opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-text-primary"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        )}
      </div>
    </div>
  )
}
