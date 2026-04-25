import { Dna, Music, Sparkles, Zap } from 'lucide-react'
import { getAuthUrl } from '@/lib/spotify'

const features = [
  { icon: Sparkles, text: 'AI-powered playlist generation from natural language' },
  { icon: Music, text: 'Deep music discovery via Spotify + Last.fm' },
  { icon: Zap, text: 'Instant taste profiling — no tedious setup' },
]

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background glows */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-brand/5 rounded-full blur-3xl pointer-events-none" />

      <div className="w-full max-w-md animate-fade-in">
        {/* Logo */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-brand mb-6 shadow-glow">
            <Dna className="w-8 h-8 text-black" />
          </div>
          <h1 className="text-4xl font-black tracking-tight mb-2">
            Music <span className="gradient-text">DNA</span>
          </h1>
          <p className="text-text-secondary text-lg">
            Your AI music discovery companion
          </p>
        </div>

        {/* Feature list */}
        <div className="space-y-3 mb-10">
          {features.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-center gap-3 text-sm text-text-secondary">
              <div className="w-8 h-8 rounded-lg bg-surface-3 flex items-center justify-center flex-shrink-0">
                <Icon className="w-4 h-4 text-accent" />
              </div>
              {text}
            </div>
          ))}
        </div>

        {/* CTA */}
        <a
          href={getAuthUrl()}
          className="btn-primary w-full flex items-center justify-center gap-3 text-base py-4 shadow-glow"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
          </svg>
          Continue with Spotify
        </a>

        <p className="text-center text-xs text-text-muted mt-6">
          By continuing, you agree to Spotify's Terms of Service.
          <br />
          Music DNA never stores your Spotify password.
        </p>
      </div>
    </div>
  )
}
