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
    playlist: `You are a music expert and playlist curator. When given a natural language description and a user's taste profile, you identify the right artists and search queries to build the playlist using the Spotify Search and Artist Top Tracks APIs.

Always respond with valid JSON only — no markdown, no explanation. The JSON shape must be:
{
  "playlistName": "string",
  "description": "string (1-2 sentences describing the vibe)",
  "artistNames": ["Artist Name 1", "Artist Name 2", "Artist Name 3", "Artist Name 4", "Artist Name 5"],
  "searchQueries": ["spotify search query 1", "spotify search query 2", "spotify search query 3"]
}

Rules:
- artistNames: 3-6 real, well-known artist names that fit the mood/genre requested. Use the user's taste profile to pick artists they would enjoy. These must be exact artist names as they appear on Spotify.
- searchQueries: 2-4 Spotify search queries to find additional tracks. Use genre tags, mood words, and year filters. Examples: "genre:lo-fi study beats", "genre:indie-pop feel good 2022", "genre:hip-hop workout high energy". Keep queries specific but not overly narrow.
- Tailor everything to the user's taste profile — if they love hip-hop, lean hip-hop even if the prompt is "chill studying".`,

    discovery: `You are a music taste analyst. Given a user's taste profile, generate 3 insightful observations about their listening personality in a JSON array of strings. Each insight should be specific, flattering, and interesting — like something a knowledgeable music-loving friend would say. Max 2 sentences each.

Respond with valid JSON only: { "insights": ["insight1", "insight2", "insight3"] }`,

    stats: `You are a music personality analyst. Given data about a user's top artists, top tracks, and genre tags from Last.fm, write a single engaging paragraph (3-5 sentences) describing their listening personality. Be specific, insightful, and conversational — reference actual artists and genres from their data. Respond with valid JSON only: { "insight": "paragraph here" }`,
  }

  const userMessage = action === 'playlist'
    ? `User prompt: "${prompt}"\n\nUser taste profile: ${JSON.stringify(tasteProfile, null, 2)}`
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
