const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIP();
const BASE_URL = `http://${LOCAL_IP}:${PORT}`;

app.use(express.json());
app.use(express.static('public'));

// In-memory job store: jobId -> { status, playlistId, lines: [] }
const jobs = {};

// Extract playlist ID from a YouTube URL (handles both ?list= and /playlist?list=)
function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('list') || null;
  } catch {
    return null;
  }
}

// POST /download — kick off a yt-dlp job
app.post('/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const playlistId = extractPlaylistId(url);
  if (!playlistId) return res.status(400).json({ error: 'Could not extract playlist ID from URL' });

  const jobId = crypto.randomUUID();
  const outDir = path.join(DOWNLOADS_DIR, playlistId);
  fs.mkdirSync(outDir, { recursive: true });

  jobs[jobId] = { status: 'running', playlistId, lines: [] };

  // yt-dlp invocation
  const cookiesFile = path.join(__dirname, 'cookies.txt');
  const args = [
    '--extract-audio',
    '--audio-format', 'mp3',
    '--audio-quality', '0',
    '--write-info-json',
    '--embed-thumbnail',
    '--extractor-args', 'youtube:player_client=mweb,web',
    '--sleep-interval', '2',
    '--max-sleep-interval', '5',
    '--retries', '5',
    ...(fs.existsSync(cookiesFile) ? ['--cookies', cookiesFile] : []),
    '--output', path.join(outDir, '%(title)s.%(ext)s'),
    url,
  ];

  const proc = spawn('yt-dlp', args);

  const pushLine = (line) => {
    jobs[jobId].lines.push(line);
    // Keep log from growing unbounded
    if (jobs[jobId].lines.length > 2000) jobs[jobId].lines.shift();
  };

  proc.stdout.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(pushLine));
  proc.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach(pushLine));

  proc.on('close', (code) => {
    jobs[jobId].status = code === 0 ? 'done' : 'error';
    pushLine(`__EXIT__${code}`);
  });

  res.json({ jobId, playlistId });
});

// GET /status/:jobId — SSE stream of log lines
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let sent = 0;

  const flush = () => {
    while (sent < job.lines.length) {
      const line = job.lines[sent++];
      res.write(`data: ${JSON.stringify(line)}\n\n`);
      if (line.startsWith('__EXIT__')) {
        res.end();
        clearInterval(timer);
        return;
      }
    }
  };

  flush();
  const timer = setInterval(flush, 300);

  req.on('close', () => clearInterval(timer));
});

// GET /playlists — list downloaded playlist folders
app.get('/playlists', (req, res) => {
  if (!fs.existsSync(DOWNLOADS_DIR)) return res.json([]);
  const entries = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const playlistId = e.name;
      const dir = path.join(DOWNLOADS_DIR, playlistId);
      const title = inferPlaylistTitle(dir, playlistId);
      const mp3Count = fs.readdirSync(dir).filter(f => f.endsWith('.mp3')).length;
      return { playlistId, title, mp3Count, feedUrl: `${BASE_URL}/feed/${playlistId}` };
    });
  res.json(entries);
});

// DELETE /playlist/:playlistId — remove all files and folder for a playlist
app.delete('/playlist/:playlistId', (req, res) => {
  const dir = path.join(DOWNLOADS_DIR, req.params.playlistId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Playlist not found' });
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// GET /audio/:playlistId/:filename — serve MP3 files
app.get('/audio/:playlistId/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.playlistId, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// GET /feed/:playlistId — generate podcast RSS 2.0 feed
app.get('/feed/:playlistId', (req, res) => {
  const { playlistId } = req.params;
  const dir = path.join(DOWNLOADS_DIR, playlistId);
  if (!fs.existsSync(dir)) return res.status(404).send('Playlist not found');

  const mp3Files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.mp3'))
    .sort();

  const channelTitle = inferPlaylistTitle(dir, playlistId);
  const baseUrl = BASE_URL;

  // Build feed image URL from first info.json that has a thumbnail
  let channelImage = '';
  for (const mp3 of mp3Files) {
    const infoPath = path.join(dir, mp3.replace(/\.mp3$/, '.info.json'));
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        if (info.thumbnail) { channelImage = info.thumbnail; break; }
      } catch { /* skip */ }
    }
  }

  const items = mp3Files.map(filename => {
    const filePath = path.join(dir, filename);
    const stat = fs.statSync(filePath);
    const encodedFilename = encodeURIComponent(filename);
    const audioUrl = `${baseUrl}/audio/${playlistId}/${encodedFilename}`;

    let title = filename.replace(/\.mp3$/, '');
    let pubDate = stat.mtime.toUTCString();
    let durationSeconds = 0;
    let description = '';

    const infoPath = path.join(dir, filename.replace(/\.mp3$/, '.info.json'));
    if (fs.existsSync(infoPath)) {
      try {
        const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
        title = info.title || title;
        description = info.description || '';
        durationSeconds = info.duration || 0;
        if (info.upload_date) {
          // upload_date is YYYYMMDD
          const d = info.upload_date;
          pubDate = new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`).toUTCString();
        }
      } catch { /* skip */ }
    }

    const durationStr = formatDuration(durationSeconds);

    const desc = description.slice(0, 500).replace(/]]>/g, ']]]]><![CDATA[>');
    return `
    <item>
      <title>${escapeXml(title)}</title>
      <description><![CDATA[${desc}]]></description>
      <itunes:summary><![CDATA[${desc}]]></itunes:summary>
      <itunes:author>${escapeXml(channelTitle)}</itunes:author>
      <itunes:title>${escapeXml(title)}</itunes:title>
      <itunes:duration>${durationStr}</itunes:duration>
      <pubDate>${pubDate}</pubDate>
      <enclosure url="${audioUrl}" length="${stat.size}" type="audio/mpeg"/>
      <guid isPermaLink="false">${audioUrl}</guid>
    </item>`;
  }).join('\n');

  const feedUrl = `${baseUrl}/feed/${playlistId}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(channelTitle)}</title>
    <link>${feedUrl}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml"/>
    <description><![CDATA[${channelTitle}]]></description>
    <language>en-us</language>
    <itunes:author><![CDATA[${channelTitle}]]></itunes:author>
    <itunes:summary><![CDATA[${channelTitle}]]></itunes:summary>
    <itunes:type>episodic</itunes:type>
    <itunes:owner>
      <itunes:name><![CDATA[${channelTitle}]]></itunes:name>
      <itunes:email>podcast@example.com</itunes:email>
    </itunes:owner>
    <itunes:category text="Music"/>
    <itunes:explicit>false</itunes:explicit>${channelImage ? `
    <itunes:image href="${escapeXml(channelImage)}"/>
    <image><url>${escapeXml(channelImage)}</url><title>${escapeXml(channelTitle)}</title><link>${feedUrl}</link></image>` : ''}
    ${items}
  </channel>
</rss>`;

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.send(xml);
});

// --- helpers ---

function inferPlaylistTitle(dir, fallback) {
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.info.json'));
    for (const f of files) {
      const info = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (info.playlist_title) return info.playlist_title;
      if (info.playlist) return info.playlist;
    }
  } catch { /* fall through */ }
  return fallback;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

app.listen(PORT, () => {
  console.log(`YT Playlist Podcaster running at http://localhost:${PORT}`);
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
});
