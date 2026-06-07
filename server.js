const express = require("express");
const { JSDOM } = require("jsdom");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HOSTNAME = process.env.HOSTNAME || "0.0.0.0";
const BASE_URL = "https://lordflix.org";
const SNOWHOUSE = "https://snowhouse.lordflix.club";
const ENC_DEC_API = "https://enc-dec.app/api";

const HEADERS = {
  "Accept": "*/*",
  "Origin": "https://lordflix.org",
  "Referer": "https://lordflix.org/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
};

// ─── CORS ───────────────────────────────────────────────────────────────────
app.use((_, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (_.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    service: "LordFlix Stream Extractor API",
    version: "2.0.0",
    engine: "enc-dec.app (no browser needed)",
    endpoints: {
      health: "GET /",
      movie: "GET /movie/:tmdbId",
      tv: "GET /tv/:tmdbId/:season/:episode",
      extractPost: "POST /api/extract",
    },
    usage: {
      movie: "GET /movie/1216578",
      tv: "GET /tv/220102/1/1",
      post: 'POST /api/extract  body: { "type":"tv", "tmdbId":"220102", "season":"1", "episode":"1" }',
    },
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJSON(url, timeout = 30000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  return res.json();
}

async function fetchText(url, timeout = 30000) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeout) });
  return res.text();
}

async function getServers() {
  try {
    const data = await fetchJSON(`${SNOWHOUSE}/servers`);
    const servers = Array.isArray(data) ? data : data.servers || [];
    return servers.map((s) => s.name);
  } catch {
    return [];
  }
}

// Scrape title, year, imdb_id from LordFlix page
async function getMeta(tmdbId, type, season, episode) {
  const url = type === "movie"
    ? `${BASE_URL}/watch/movie/${tmdbId}`
    : `${BASE_URL}/watch/tv/${tmdbId}/${season}/${episode}`;

  try {
    const html = await fetchText(url, 8000);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // Try JSON-LD first
    const jsonLd = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const el of jsonLd) {
      try {
        const parsed = JSON.parse(el.textContent);
        const movie = parsed["@type"] === "Movie" ? parsed :
                      Array.isArray(parsed) ? parsed.find((e) => e["@type"] === "Movie") : null;
        if (movie) {
          return {
            title: movie.name || doc.title || "",
            year: (movie.datePublished || "").substring(0, 4),
            imdbId: (movie.url || "").match(/tt\d+/)?.[0] || "",
          };
        }
      } catch {}
    }

    // Fallback: parse from og:title or page title
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.content || "";
    const title = ogTitle || doc.title || "";
    const yearMatch = title.match(/\((\d{4})\)/);
    return { title, year: yearMatch?.[1] || "", imdbId: "" };
  } catch {
    return { title: "", year: "", imdbId: "" };
  }
}

// Try a single server — returns result or null
async function tryServer({ type, tmdbId, season, episode, serverName, meta }) {
  const typeParam = type === "movie" ? "movie" : "series";
  const params = new URLSearchParams({
    title: meta.title || "",
    type: typeParam,
    year: meta.year || "",
    imdb: meta.imdbId || "",
    tmdb: tmdbId,
    server: serverName,
  });
  if (type === "tv") {
    params.set("season", season);
    params.set("episode", episode);
  }
  const snowhouseUrl = `${SNOWHOUSE}/?${params.toString()}`;

  // 1. Encrypt via enc-dec.app
  const encRes = await fetchJSON(`${ENC_DEC_API}/enc-lordflix?url=${encodeURIComponent(snowhouseUrl)}`);
  if (encRes.status !== 200) return null;

  const encUrl = encRes.result?.url;
  const sign = encRes.result?.sign;
  if (!encUrl || !sign) return null;

  // 2. Fetch encrypted data
  const encrypted = await fetchText(encUrl, 15000);

  // 3. Decrypt via enc-dec.app
  const decRes = await fetch(`${ENC_DEC_API}/dec-lordflix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: encrypted, sign }),
    signal: AbortSignal.timeout(15000),
  });
  const decData = await decRes.json();
  if (decRes.status !== 200 || decData.status !== 200) return null;

  const decrypted = decData.result;

  // 4. Check if decrypted response is an error
  if (typeof decrypted === "object" && decrypted?.error) return null;

  return decrypted;
}

// Core extraction — tries servers with auto-fallback
async function extractStreams({ type, tmdbId, season, episode, server }) {
  // 1. Get servers and metadata in parallel
  const [servers, meta] = await Promise.all([
    getServers(),
    getMeta(tmdbId, type, season, episode),
  ]);

  // 2. Build server order: requested server first, then the rest
  let serverOrder = [];
  if (server) {
    serverOrder.push(server);
    servers.forEach((s) => { if (s !== server) serverOrder.push(s); });
  } else {
    serverOrder = [...servers];
  }
  if (serverOrder.length === 0) serverOrder.push("Berlin");

  // 3. Try each server until one works
  let lastError = null;
  for (const serverName of serverOrder) {
    try {
      const decrypted = await tryServer({ type, tmdbId, season, episode, serverName, meta });
      if (decrypted !== null) {
        return parseDecrypted(decrypted, { type, tmdbId, season, episode, selectedServer: serverName, servers, meta });
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  // All servers failed
  return {
    title: meta?.title || null,
    type, tmdbId,
    season: season || null, episode: episode || null,
    watchUrl: type === "movie"
      ? `${BASE_URL}/watch/movie/${tmdbId}`
      : `${BASE_URL}/watch/tv/${tmdbId}/${season}/${episode}`,
    selectedServer: null,
    masterM3u8: null, streams: [], subtitles: [],
    servers,
    decrypted: null,
    timestamp: new Date().toISOString(),
    error: lastError || "All servers failed",
  };
}

function parseDecrypted(decrypted, info) {
  const result = {
    title: info.meta?.title || null,
    type: info.type,
    tmdbId: info.tmdbId,
    season: info.season || null,
    episode: info.episode || null,
    watchUrl: info.type === "movie"
      ? `${BASE_URL}/watch/movie/${info.tmdbId}`
      : `${BASE_URL}/watch/tv/${info.tmdbId}/${info.season}/${info.episode}`,
    selectedServer: info.selectedServer,
    masterM3u8: null,
    streams: [],
    subtitles: [],
    servers: info.servers,
    decrypted,
    timestamp: new Date().toISOString(),
    error: null,
  };

  // Parse M3U8 content if returned
  if (typeof decrypted === "string") {
    if (decrypted.includes("#EXTM3U")) {
      return parseM3U8(decrypted, result);
    }
    // Try to parse as JSON
    try {
      const parsed = JSON.parse(decrypted);
      if (parsed.url) result.masterM3u8 = parsed.url;
      if (parsed.sources) {
        result.streams = parsed.sources.map((s) => ({
          quality: s.quality || s.label || "unknown",
          url: s.url || s.file || "",
        }));
      }
      if (parsed.tracks) {
        result.subtitles = parsed.tracks
          .filter((t) => t.kind === "captions" || t.kind === "subtitles")
          .map((t) => ({ language: t.language || "unknown", label: t.label || "", url: t.url || "" }));
      }
    } catch {}
  } else if (typeof decrypted === "object" && decrypted !== null) {
    if (decrypted.url) result.masterM3u8 = decrypted.url;
    if (decrypted.sources) {
      result.streams = decrypted.sources.map((s) => ({
        quality: s.quality || s.label || "unknown",
        url: s.url || s.file || "",
      }));
    }
  }

  return result;
}

function parseM3U8(m3u8, result) {
  const lines = m3u8.split("\n").map((l) => l.trim()).filter(Boolean);

  // Find master playlist streams
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const qualityMatch = line.match(/RESOLUTION=\d+x(\d+)/);
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const nextLine = lines[i + 1];

      if (nextLine && !nextLine.startsWith("#")) {
        let quality = "unknown";
        if (qualityMatch) {
          const height = parseInt(qualityMatch[1]);
          quality = `${Math.round(height / 2) * 2}p`; // round to nearest
        }
        if (nameMatch) quality = nameMatch[1];

        result.streams.push({ quality, url: nextLine });

        if (!result.masterM3u8) {
          // The URL that returned this m3u8 IS the master
          result.masterM3u8 = result.streams[0].url.split("/").slice(0, -1).join("/") || null;
        }
      }
    }

    if (line.startsWith("#EXT-X-MEDIA:TYPE=SUBTITLES")) {
      const langMatch = line.match(/LANGUAGE="([^"]+)"/);
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        result.subtitles.push({
          language: langMatch?.[1] || "unknown",
          label: nameMatch?.[1] || "",
          url: uriMatch[1],
        });
      }
    }
  }

  // If no quality streams parsed but have m3u8 content, store as master
  if (result.streams.length === 0 && result.subtitles.length === 0) {
    // It might be a quality playlist itself
    const urls = lines.filter((l) => l.startsWith("http"));
    if (urls.length > 0) {
      result.streams.push({ quality: "unknown", url: urls[0] });
    }
  }

  return result;
}

// ─── GET endpoints (URL path based) ─────────────────────────────────────────
app.get("/movie/:tmdbId", async (req, res) => {
  const tmdbId = req.params.tmdbId;
  const server = req.query.server || null;
  try {
    const result = await extractStreams({ type: "movie", tmdbId, server });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/tv/:tmdbId/:season/:episode", async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  const server = req.query.server || null;
  try {
    const result = await extractStreams({ type: "tv", tmdbId, season, episode, server });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST endpoint (JSON body) ─────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { type, tmdbId, season, episode, server } = req.body;

  if (!type || !tmdbId) {
    return res.status(400).json({ error: "Missing required fields: type and tmdbId" });
  }
  if (!["movie", "tv"].includes(type)) {
    return res.status(400).json({ error: 'type must be "movie" or "tv"' });
  }
  if (type === "tv" && (!season || !episode)) {
    return res.status(400).json({ error: "TV shows require season and episode" });
  }

  try {
    const result = await extractStreams({ type, tmdbId, season, episode, server });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOSTNAME, () => {
  console.log(`LordFlix API v2 running on http://${HOSTNAME}:${PORT}`);
});
