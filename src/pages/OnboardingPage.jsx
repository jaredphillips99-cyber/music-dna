import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, ChevronLeft, Check, Dna } from 'lucide-react'
import useStore from '@/store/useStore'
import clsx from 'clsx'

const GENRES = [
  'Hip-Hop', 'R&B', 'Pop', 'Indie', 'Rock', 'Electronic', 'Jazz', 'Classical',
  'Country', 'Folk', 'Metal', 'Punk', 'Soul', 'Funk', 'Reggae', 'Latin',
  'Ambient', 'Lo-fi', 'House', 'Drum & Bass',
]

const CONTEXTS = [
  { id: 'workout', label: 'Working out', emoji: '💪' },
  { id: 'study', label: 'Studying / Focus', emoji: '📚' },
  { id: 'commute', label: 'Commuting', emoji: '🚇' },
  { id: 'chill', label: 'Chilling at home', emoji: '🛋️' },
  { id: 'party', label: 'Parties / Social', emoji: '🎉' },
  { id: 'sleep', label: 'Winding down', emoji: '🌙' },
  { id: 'cooking', label: 'Cooking / Cleaning', emoji: '🍳' },
  { id: 'driving', label: 'Road trips', emoji: '🚗' },
]

const steps = [
  { id: 'genres', title: 'What genres move you?', subtitle: 'Pick everything that resonates — no wrong answers.' },
  { id: 'artists', title: 'Name 3 artists you love', subtitle: 'These anchor your taste profile.' },
  { id: 'contexts', title: 'When do you listen most?', subtitle: 'Helps us match the vibe to the moment.' },
  { id: 'adventure', title: 'How adventurous are you?', subtitle: 'We use this to calibrate how far to push recommendations.' },
]

function ProgressBar({ step, total }) {
  return (
    <div className="flex gap-1.5 mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={clsx(
            'h-1 rounded-full flex-1 transition-all duration-300',
            i <= step ? 'bg-accent' : 'bg-surface-4'
          )}
        />
      ))}
    </div>
  )
}

export default function OnboardingPage() {
  const navigate = useNavigate()
  const { setTasteProfile } = useStore()
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState({
    genres: [],
    artists: ['', '', ''],
    contexts: [],
    adventure: 5,
  })

  function toggleGenre(g) {
    setAnswers((a) => ({
      ...a,
      genres: a.genres.includes(g) ? a.genres.filter((x) => x !== g) : [...a.genres, g],
    }))
  }

  function toggleContext(id) {
    setAnswers((a) => ({
      ...a,
      contexts: a.contexts.includes(id) ? a.contexts.filter((x) => x !== id) : [...a.contexts, id],
    }))
  }

  function updateArtist(i, val) {
    setAnswers((a) => {
      const artists = [...a.artists]
      artists[i] = val
      return { ...a, artists }
    })
  }

  function canAdvance() {
    if (step === 0) return answers.genres.length >= 1
    if (step === 1) return answers.artists.filter(Boolean).length >= 1
    if (step === 2) return answers.contexts.length >= 1
    return true
  }

  function finish() {
    const profile = {
      genres: answers.genres,
      favoriteArtists: answers.artists.filter(Boolean),
      listeningContexts: answers.contexts,
      adventureScore: answers.adventure,
      createdAt: new Date().toISOString(),
    }
    setTasteProfile(profile)
    navigate('/')
  }

  const current = steps[step]

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center p-4">
      <div className="w-full max-w-lg animate-slide-up">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="w-8 h-8 rounded-lg bg-gradient-brand flex items-center justify-center">
            <Dna className="w-4 h-4 text-black" />
          </div>
          <span className="font-bold">Music DNA</span>
        </div>

        <ProgressBar step={step} total={steps.length} />

        <h2 className="text-2xl font-bold mb-1">{current.title}</h2>
        <p className="text-text-secondary mb-8">{current.subtitle}</p>

        {/* Step content */}
        {step === 0 && (
          <div className="flex flex-wrap gap-2">
            {GENRES.map((g) => (
              <button
                key={g}
                onClick={() => toggleGenre(g)}
                className={clsx(
                  'px-4 py-2 rounded-full text-sm font-medium border transition-all duration-150',
                  answers.genres.includes(g)
                    ? 'bg-accent/10 border-accent text-accent'
                    : 'bg-surface-3 border-surface-4 text-text-secondary hover:border-text-muted hover:text-text-primary'
                )}
              >
                {g}
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            {answers.artists.map((val, i) => (
              <input
                key={i}
                value={val}
                onChange={(e) => updateArtist(i, e.target.value)}
                placeholder={`Artist ${i + 1}${i === 0 ? ' (required)' : ''}`}
                className="input-base"
              />
            ))}
          </div>
        )}

        {step === 2 && (
          <div className="grid grid-cols-2 gap-3">
            {CONTEXTS.map(({ id, label, emoji }) => (
              <button
                key={id}
                onClick={() => toggleContext(id)}
                className={clsx(
                  'flex items-center gap-3 p-4 rounded-xl border text-left transition-all duration-150',
                  answers.contexts.includes(id)
                    ? 'bg-accent/10 border-accent'
                    : 'bg-surface-2 border-surface-4 hover:border-text-muted'
                )}
              >
                <span className="text-xl">{emoji}</span>
                <span className="text-sm font-medium">{label}</span>
                {answers.contexts.includes(id) && (
                  <Check className="w-4 h-4 text-accent ml-auto" />
                )}
              </button>
            ))}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-8">
            <div>
              <div className="flex justify-between text-sm mb-3">
                <span className="text-text-secondary">Stick to what I know</span>
                <span className="text-text-secondary">Total wild cards</span>
              </div>
              <input
                type="range"
                min={1}
                max={10}
                value={answers.adventure}
                onChange={(e) => setAnswers((a) => ({ ...a, adventure: Number(e.target.value) }))}
                className="w-full accent-accent h-2 rounded-full"
              />
              <div className="text-center mt-4">
                <span className="text-4xl font-black gradient-text">{answers.adventure}</span>
                <span className="text-text-muted text-sm ml-2">/ 10</span>
              </div>
            </div>
            <p className="text-sm text-text-secondary text-center">
              {answers.adventure <= 3
                ? "You like familiarity — we'll keep recommendations close to what you know."
                : answers.adventure <= 7
                ? "Balanced explorer — a mix of familiar favourites and fresh discoveries."
                : "True adventurer — expect artists and sounds you've never heard before."}
            </p>
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-10">
          <button
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0}
            className="btn-ghost flex items-center gap-2 disabled:opacity-0"
          >
            <ChevronLeft className="w-4 h-4" />
            Back
          </button>

          {step < steps.length - 1 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canAdvance()}
              className="btn-primary flex items-center gap-2"
            >
              Continue
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={finish} className="btn-primary flex items-center gap-2">
              Build my DNA
              <Dna className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
