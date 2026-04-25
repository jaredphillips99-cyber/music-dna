# Music DNA

AI-powered music discovery and playlist generation — built with React, Vite, Tailwind CSS, and Claude.

**Live app:** https://music-dna-five.vercel.app

---

## Features

- **Spotify OAuth** — Authorization Code flow; the Client Secret never touches the browser
- **Natural language playlists** — Type anything like *"hype playlist for my morning run"* and Claude translates it into Spotify recommendations
- **Onboarding quiz** — Builds a taste profile for users without listening history
- **Last.fm import** — Optional; enriches recommendations with real listening history
- **Save to Spotify** — One-click playlist save to your Spotify account
- **Artist discovery** — Surfaces new artists ranked by how many of your favourites point to them
- **Stats dashboard** — Top artists, tracks, genre tags, and a Claude-generated listening personality

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jaredphillips99-cyber/music-dna.git
cd music-dna
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `VITE_SPOTIFY_CLIENT_ID` | [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) |
| `SPOTIFY_CLIENT_SECRET` | Spotify Developer Dashboard — **server-side only** |
| `VITE_SPOTIFY_REDIRECT_URI` | Set to `http://localhost:3000/callback` for local dev |
| `VITE_LASTFM_API_KEY` | [Last.fm API](https://www.last.fm/api/account/create) |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com) |

### 3. Run locally

```bash
npm run dev
```

---

## Deploying to Vercel

> **Important:** Environment variables must be added manually in the Vercel dashboard before the app will work in production.

1. Push to GitHub (already done if you're reading this)
2. Import the repo at [vercel.com/new](https://vercel.com/new)
3. Go to **Project Settings → Environment Variables** and add every variable from `.env.example`:
   - `VITE_SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET` ← **keep this server-side only; never prefix with VITE_**
   - `VITE_SPOTIFY_REDIRECT_URI` → set to `https://music-dna-five.vercel.app/callback`
   - `VITE_LASTFM_API_KEY`
   - `ANTHROPIC_API_KEY`
4. Redeploy

The `api/` directory is automatically deployed as Vercel Serverless Functions.

---

## Architecture

```
music-dna/
├── api/                    # Vercel serverless functions (secrets stay here)
│   ├── auth/
│   │   ├── callback.js     # Spotify OAuth token exchange
│   │   └── refresh.js      # Token refresh
│   └── claude.js           # Claude API proxy
├── src/
│   ├── lib/                # API client utilities
│   │   ├── spotify.js
│   │   ├── lastfm.js
│   │   └── claude.js
│   ├── store/              # Zustand global state (persisted to localStorage)
│   ├── hooks/              # useSpotify (token refresh logic)
│   ├── pages/              # Route-level components
│   └── components/         # Reusable UI components
└── vercel.json             # Vercel routing config
```

---

## Security notes

- `SPOTIFY_CLIENT_SECRET` and `ANTHROPIC_API_KEY` are **only** accessed in serverless functions — never sent to the browser
- `VITE_` prefixed variables are bundled into the frontend; only non-sensitive IDs use this prefix
- `.env` is in `.gitignore` — never commit it
