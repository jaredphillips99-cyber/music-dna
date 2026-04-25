async function claudeRequest(action, prompt, tasteProfile) {
  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, prompt, tasteProfile }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || 'Claude API error')
  }
  return res.json()
}

export const getPlaylistParams = (prompt, tasteProfile) =>
  claudeRequest('playlist', prompt, tasteProfile)

export const getDiscoveryInsights = (tasteProfile) =>
  claudeRequest('discovery', null, tasteProfile)

export const getStatsInsight = (listeningData) =>
  claudeRequest('stats', null, listeningData)
