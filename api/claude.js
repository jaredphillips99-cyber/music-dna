// Claude API proxy — keeps ANTHROPIC_API_KEY server-side.
// Accepts a user prompt + taste profile and returns Spotify recommendation params.
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { prompt, tasteProfile, action } = req.body

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(500).json({ error: 'Anthropic API key not configured' })
  }

  const systemPrompts = {
    playlist: `You are a music expert and playlist curator. Given a natural language prompt and the user's listening history, extract structured parameters to build a Spotify playlist using the Search and Artist Top Tracks APIs.

Always respond with valid JSON only — no markdown, no explanation. Schema:
{
  "playlistName": "string",
  "description": "string (1-2 sentences, evocative)",
  "artistNames": ["Artist Name", ...],
  "searchQueries": ["spotify search query", ...],
  "playlistSize": 20,
  "minDurationMs": null,
  "maxDurationMs": null,
  "isSingleArtistPlaylist": false,
  "detectedGenres": ["genre-slug", ...],
  "emptyResultSuggestion": "string — a friendly rephrased prompt to try if no tracks are found"
}

Extraction rules:
- artistNames: 4-8 exact Spotify artist names. If the prompt names specific artists (e.g. "Chris Stussy", "Prunk"), include them first. Phrases like "artists I listen to" or "my favourite artists" or "artists I have demonstrated interest in" MUST resolve to real names from the spotifyTopArtists or lastfmTopArtists lists — pick the most genre-relevant ones. Add complementary artists to pad to at least 4 total.
- searchQueries: 4-6 Spotify search strings. Mix artist-targeted (artist:"Name" tech-house) and genre-targeted (genre:melodic-techno dark) queries. Include at least one pure genre sweep. Never leave this empty.
- playlistSize: extract from prompt ("give me 40 songs" → 40, "50 tracks" → 50). Default 20. Cap at 50.
- minDurationMs / maxDurationMs: "longer songs" / "extended tracks" → minDurationMs: 240000. "short" / "quick" → maxDurationMs: 210000. "over 6 minutes" → minDurationMs: 360000. null if not mentioned.
- isSingleArtistPlaylist: true ONLY when the user explicitly asks for a playlist from one specific named artist ("give me a Chris Stussy playlist", "only Bicep tracks"). False in all other cases.
- detectedGenres: 1-3 short genre slugs inferred from the prompt and artist context (e.g. ["tech-house", "melodic-techno"]). Used for backfill searches.
- emptyResultSuggestion: always a helpful broader rephrasing. Shown only on empty results.
- Tailor artist selection to the user's taste profile. If they love hip-hop, lean hip-hop even for "chill studying".`,

    discovery: `You are a music taste analyst. Given a user's taste profile, generate 3 insightful observations about their listening personality in a JSON array of strings. Each insight should be specific, flattering, and interesting — like something a knowledgeable music-loving friend would say. Max 2 sentences each.

Respond with valid JSON only: { "insights": ["insight1", "insight2", "insight3"] }`,

    stats: `You are a music personality analyst. Given data about a user's top artists, top tracks, and genre tags from Last.fm, write a single engaging paragraph (3-5 sentences) describing their listening personality. Be specific, insightful, and conversational — reference actual artists and genres from their data. Respond with valid JSON only: { "insight": "paragraph here" }`,
  }

  function buildPlaylistMessage(prompt, tasteProfile) {
    const spotifyArtists = tasteProfile?.spotifyTopArtistNames ?? []
    const lastfmArtists = (tasteProfile?.lastfmData?.topArtists ?? []).map((a) => a.name).filter(Boolean)
    const onboardingArtists = tasteProfile?.favoriteArtists ?? []

    const lines = [`User prompt: "${prompt}"`, '']

    if (spotifyArtists.length) {
      lines.push(`spotifyTopArtists (their actual Spotify listening history): ${spotifyArtists.join(', ')}`)
    }
    if (lastfmArtists.length) {
      lines.push(`lastfmTopArtists (Last.fm listening history): ${lastfmArtists.join(', ')}`)
    }
    if (onboardingArtists.length) {
      lines.push(`onboardingFavourites (self-reported): ${onboardingArtists.join(', ')}`)
    }

    lines.push('')
    lines.push('Full taste profile:')
    lines.push(JSON.stringify({
      genres: tasteProfile?.genres,
      listeningContexts: tasteProfile?.listeningContexts,
      adventureScore: tasteProfile?.adventureScore,
    }, null, 2))

    return lines.join('\n')
  }

  const userMessage = action === 'playlist'
    ? buildPlaylistMessage(prompt, tasteProfile)
    : action === 'stats'
    ? `User listening data: ${JSON.stringify(tasteProfile, null, 2)}`
    : `User taste profile: ${JSON.stringify(tasteProfile, null, 2)}`

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompts[action] || systemPrompts.playlist,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      return res.status(response.status).json({ error: data.error?.message || 'Claude API error' })
    }

    const text = data.content?.[0]?.text || '{}'
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }

    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.status(200).json(parsed)
  } catch (err) {
    console.error('Claude API error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
