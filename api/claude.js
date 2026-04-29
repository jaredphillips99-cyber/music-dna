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
    playlist: `You are a music playlist assistant. Extract the following from the user's prompt and return ONLY a raw JSON object. No markdown. No code fences. No backticks. No preamble. Start your response with { and end with }.

{
  "artists": [],
  "genres": [],
  "energy": "medium",
  "bpm_target": null,
  "duration_min_ms": null,
  "track_count": 20,
  "mood": "string",
  "playlistName": "string",
  "description": "string",
  "isSingleArtistPlaylist": false,
  "use_library": false
}

Field rules:
- artists: Array of exact Spotify artist names. Include every artist named in the prompt first. Resolve "artists I listen to" / "my favourites" / "artists I have demonstrated interest in" to real names from the spotifyTopArtists or lastfmTopArtists lists supplied below — pick the most genre-relevant. Pad to at least 4 complementary artists in the same genre. Max 10.
- genres: 1-4 lowercase hyphenated Spotify genre slugs inferred from prompt + artists. Examples: "tech-house", "melodic-techno", "deep-house", "hip-hop", "lo-fi". Never leave empty.
- energy: "low" | "medium" | "high" — infer from context (running/workout → high, studying → low, cooking → medium).
- bpm_target: numeric BPM or null. "running" → 140-160, "workout" → 130-150, null if not specified.
- duration_min_ms: "longer songs" / "extended tracks" / "no short tracks" → 240000. "over 5 min" → 300000. "over 6 min" → 360000. null otherwise.
- track_count: integer. Extract from "30 tracks", "give me 40 songs", "50-song". Default 20. Max 50.
- mood: 1-3 word mood string e.g. "euphoric", "dark and driving", "warm and nostalgic".
- playlistName: creative, evocative name (3-6 words).
- description: 1-2 sentence evocative description of the vibe.
- isSingleArtistPlaylist: true ONLY when user explicitly asks for one specific artist ("only Chris Stussy", "give me a Bicep playlist"). False in all other cases.
- use_library: true when the prompt implies using the user's existing listening history ("based on what I listen to", "from my library", "my taste", "what I usually like", "songs I know"). false when the user requests a specific genre, artist, mood, or activity (workout, studying, etc.) without referencing their personal library.`,

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
      console.error('Claude API HTTP error:', response.status, JSON.stringify(data))
      return res.status(response.status).json({ error: data.error?.message || 'Claude API error' })
    }

    const rawText = data.content?.[0]?.text || '{}'
    const text = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (parseErr) {
      console.error('Claude JSON parse error:', parseErr.message)
      console.error('Raw Claude response text:', rawText)
      parsed = { raw: text }
    }

    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.status(200).json(parsed)
  } catch (err) {
    console.error('Claude API error:', err.message, err.stack)
    return res.status(500).json({ error: 'Internal server error' })
  }
}
