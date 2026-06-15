# YT Playlist Podcaster

Download a YouTube playlist as MP3s and subscribe to it in any podcast app (Downcast, Overcast, Pocket Casts, etc.).

## Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp)

```bash
brew install yt-dlp   # macOS
```

## Setup

```bash
npm install
node server.js
```

Open http://localhost:3000

## Usage

1. Paste a YouTube playlist URL into the input field
2. Click **Download** — progress streams live in the log area
3. When complete, copy the RSS feed URL shown on screen
4. In Downcast: **Add Podcast** → **Add Manually** → paste the URL

## How it works

- MP3s are saved to `downloads/<playlistId>/`
- Metadata (title, duration, upload date) comes from yt-dlp's `.info.json` files
- The RSS feed is generated on-the-fly from the filesystem — no database needed
- The server must be running for the podcast app to stream audio

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/download` | Start a download job |
| GET | `/status/:jobId` | SSE stream of download progress |
| GET | `/feed/:playlistId` | Podcast RSS 2.0 feed |
| GET | `/audio/:playlistId/:filename` | Serve an MP3 file |
| GET | `/playlists` | List all downloaded playlists (JSON) |

## Notes

- Keep `node server.js` running while listening in your podcast app — it's the audio server
- Re-downloading a playlist URL will add new episodes to the same folder
- The RSS feed always reflects whatever MP3s are currently in the folder
