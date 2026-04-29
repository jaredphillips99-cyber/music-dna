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
  "use_library": false,
  "release_year_min": null,
  "release_year_max": null,
  "sort_by_hits": false
}

Field rules:
- artists: Array of exact Spotify artist names. Include every artist named in the prompt first. For "similar to X" or "like X" prompts, include X plus 3-5 stylistically similar artists. Resolve "my favourites" / "artists I listen to" from spotifyTopArtists/lastfmTopArtists below — pick the most genre-relevant. Pad to at least 4 complementary artists total. Max 10.
- genres: 1-4 lowercase hyphenated Spotify genre slugs inferred from prompt + artists. Examples: "tech-house", "melodic-techno", "deep-house", "hip-hop", "lo-fi", "r-n-b", "drum-and-bass". Never leave empty.
- energy: "low" | "medium" | "high" — infer from context (running/workout → high, studying/sleeping → low, cooking/commute → medium).
- bpm_target: numeric BPM or null. "running" → 150, "workout" → 140, null if not specified.
- duration_min_ms: "longer songs" / "extended tracks" → 240000. "over 5 min" → 300000. "over 6 min" → 360000. null otherwise.
- track_count: integer. Extract from "30 tracks", "40 songs", "50-song playlist". Default 20. Max 50.
- mood: 1-3 word mood string e.g. "euphoric", "dark and driving", "warm and nostalgic".
- playlistName: creative, evocative name (3-6 words).
- description: 1-2 sentence evocative description of the vibe.
- isSingleArtistPlaylist: true ONLY when user explicitly asks for one specific artist ("only Chris Stussy", "give me a Bicep playlist", "just Frank Ocean"). False in all other cases including "similar to X".
- use_library: true ONLY when the prompt explicitly references the user's personal history ("based on what I listen to", "from my library", "my taste", "what I usually like", "songs I know", "my favourites"). false for ALL other prompts — genre requests, mood requests, activity requests, artist requests, era requests, "similar to X" requests. When uncertain, use false.
- release_year_min / release_year_max: integers or null. "90s" → 1990/1999. "80s" → 1980/1989. "70s" → 1970/1979. "60s" → 1960/1969. "2000s" → 2000/2009. "2010s" → 2010/2019. "classic" (no decade) → null/1994. "modern"/"new"/"recent" → 2018/null. null/null when no era mentioned.
- sort_by_hits: true when the user says "biggest", "hits", "classics", "greatest", "best of", "top songs", "most popular", "anthems", "top tracks". false otherwise.

EXAMPLES — study these carefully:

Prompt: "Late night deep house for cooking dinner"
spotifyTopArtists: Bicep, Four Tet, Caribou
{ "artists": ["Floating Points", "Bicep", "Four Tet", "Burial", "Hunee"], "genres": ["deep-house"], "energy": "low", "bpm_target": null, "duration_min_ms": null, "track_count": 20, "mood": "late night atmospheric", "playlistName": "Midnight Kitchen Sessions", "description": "Warm, rolling deep house to fill your kitchen with soul.", "isSingleArtistPlaylist": false, "use_library": false, "release_year_min": null, "release_year_max": null, "sort_by_hits": false }

Prompt: "The biggest hip-hop hits of the 90s"
spotifyTopArtists: Drake, Kendrick Lamar, J. Cole
{ "artists": ["Notorious B.I.G", "Tupac Shakur", "Nas", "Jay-Z", "Wu-Tang Clan", "Snoop Dogg", "DMX", "OutKast"], "genres": ["hip-hop"], "energy": "high", "bpm_target": null, "duration_min_ms": null, "track_count": 20, "mood": "golden era triumphant", "playlistName": "90s Hip-Hop Anthems", "description": "The defining tracks that built hip-hop's golden decade.", "isSingleArtistPlaylist": false, "use_library": false, "release_year_min": 1990, "release_year_max": 1999, "sort_by_hits": true }

Prompt: "Based on what I usually listen to, something for working out"
spotifyTopArtists: Bicep, Chase & Status, Pendulum, Noisia
{ "artists": ["Bicep", "Chase & Status", "Pendulum", "Noisia", "Sub Focus"], "genres": ["drum-and-bass", "electronic"], "energy": "high", "bpm_target": 170, "duration_min_ms": null, "track_count": 20, "mood": "intense energetic", "playlistName": "High Intensity Training", "description": "Fast-paced electronic and drum & bass drawn from your listening history.", "isSingleArtistPlaylist": false, "use_library": true, "release_year_min": null, "release_year_max": null, "sort_by_hits": false }

Prompt: "Give me only Frank Ocean songs, all of them"
spotifyTopArtists: Frank Ocean, The Weeknd, SZA
{ "artists": ["Frank Ocean"], "genres": ["r-n-b"], "energy": "medium", "bpm_target": null, "duration_min_ms": null, "track_count": 30, "mood": "introspective soulful", "playlistName": "Frank Ocean Deep Dive", "description": "Every side of Frank Ocean — from Nostalgia Ultra to Blonde.", "isSingleArtistPlaylist": true, "use_library": false, "release_year_min": null, "release_year_max": null, "sort_by_hits": false }

Prompt: "Something like Caribou but more danceable"
spotifyTopArtists: Radiohead, Bon Iver, Sufjan Stevens
{ "artists": ["Caribou", "Four Tet", "Jon Hopkins", "Bonobo", "Tycho", "Com Truise"], "genres": ["melodic-house", "indie-pop"], "energy": "medium", "bpm_target": null, "duration_min_ms": null, "track_count": 20, "mood": "warm psychedelic groove", "playlistName": "Like Caribou But Danceable", "description": "Organic, melodic electronic music with a pulse — for when you want to move but still feel something.", "isSingleArtistPlaylist": false, "use_library": false, "release_year_min": null, "release_year_max": null, "sort_by_hits": false }`,

    discovery: `You are a music taste analyst. Given a user's taste profile, generate 3 insightful observations about their listening personality in a JSON array of strings. Each insight should be specific, flattering, and interesting — like something a knowledgeable music-loving friend would say. Max 2 sentences each.

Respond with valid JSON only: { "insights": ["insight1", "insight2", "insight3"] }`,

    stats: `You are a music personality analyst. Given data about a user's top artists, top tracks, and genre tags from Last.fm, write a single engaging paragraph (3-5 sentences) describing their listening personality. Be specific, insightful, and conversational — reference actual artists and genres from their data. Respond with valid JSON only: { "insight": "paragraph here" }`,

    iconic: `You are a music historian and critic. Given a genre and decade, list the 30 most iconic and culturally significant songs from that era. Return ONLY a raw JSON array. No markdown. No code fences. No backticks. No preamble. Start your response with [ and end with ].

Each element must be exactly: {"track": "exact song title", "artist": "exact artist name as known on Spotify", "tier": "mainstream hit" | "cult classic" | "deep cut"}

Order by cultural significance descending — songs that defined the genre and era first, then cult classics, then deeper cuts. Focus on songs that would appear on every authoritative best-of list. Be precise with artist names so Spotify search can find them.`,
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
    : action === 'iconic'
    ? prompt
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
