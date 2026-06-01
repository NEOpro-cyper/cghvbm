const express = require("express");
const { chromium } = require("playwright");
const path = require("path");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const BASE_URL = "https://lordflix.org";

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
    version: "1.0.0",
    endpoints: {
      extract: "POST /api/extract",
      health: "GET /",
    },
    usage: {
      movie: 'POST /api/extract  body: { "type":"movie", "tmdbId":"1216578" }',
      tv: 'POST /api/extract  body: { "type":"tv", "tmdbId":"220102", "season":"1", "episode":"1" }',
    },
  });
});

// ─── Extract endpoint ────────────────────────────────────────────────────────
app.post("/api/extract", async (req, res) => {
  const { type, tmdbId, season, episode } = req.body;

  if (!type || !tmdbId) {
    return res.status(400).json({ error: "Missing required fields: type and tmdbId" });
  }
  if (!["movie", "tv"].includes(type)) {
    return res.status(400).json({ error: 'type must be "movie" or "tv"' });
  }
  if (type === "tv" && (!season || !episode)) {
    return res.status(400).json({ error: "TV shows require season and episode" });
  }

  const watchUrl = type === "movie"
    ? `${BASE_URL}/watch/movie/${tmdbId}`
    : `${BASE_URL}/watch/tv/${tmdbId}/${season}/${episode}`;

  try {
    const result = await extractStreams({ type, tmdbId, season, episode, watchUrl });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Core extractor ──────────────────────────────────────────────────────────
async function extractStreams({ type, tmdbId, season, episode, watchUrl }) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  let masterM3u8 = null;
  const qualityPlaylists = [];
  let serverList = [];
  let pageError = null;
  let title = null;

  // ── Network interceptor ──
  await page.route("**/*", async (route) => {
    const reqUrl = route.request().url();

    // Capture server list
    if (reqUrl.includes("snowhouse.lordflix.club/servers")) {
      try {
        const resp = await route.fetch();
        const body = await resp.text();
        const parsed = JSON.parse(body);
        const servers = Array.isArray(parsed) ? parsed : parsed.servers || [];
        serverList = servers.map((s) => s.name);
        await route.fulfill({ response: resp });
        return;
      } catch {
        await route.fallback();
        return;
      }
    }

    // Capture m3u8 playlists
    if (reqUrl.includes(".m3u8") && !reqUrl.includes("_init") && !qualityPlaylists.some((q) => q.url === reqUrl)) {
      const isQuality = reqUrl.includes("m3u8_proxy");
      if (!isQuality) {
        masterM3u8 = reqUrl;
      } else {
        const qualityMatch = reqUrl.match(/video_(\d+p)/);
        const audioMatch = reqUrl.match(/audio_\d/);
        const quality = qualityMatch ? qualityMatch[1] : audioMatch ? "audio" : "unknown";
        qualityPlaylists.push({ url: reqUrl, quality });
      }
    }

    await route.fallback();
  });

  // ── Navigate & wait ──
  try {
    await page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for master m3u8 (up to 45s)
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (masterM3u8) { clearInterval(check); resolve(true); }
      }, 500);
      setTimeout(() => { clearInterval(check); resolve(false); }, 45000);
    });

    if (!masterM3u8) {
      await page.waitForTimeout(15000);
    }

    // Extra wait for quality playlists
    await page.waitForTimeout(3000);

    try { title = await page.title(); } catch {}
  } catch (err) {
    pageError = err.message;
  }

  // Parse subtitles from DOM
  let subtitles = [];
  try {
    subtitles = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("video track")).map((t) => ({
        language: t.getAttribute("srclang") || "unknown",
        label: t.getAttribute("label") || "",
        url: t.getAttribute("src") || "",
      }));
    });
  } catch {}

  await browser.close();

  return {
    title: title || null,
    type,
    tmdbId,
    season: season || null,
    episode: episode || null,
    watchUrl,
    masterM3u8: masterM3u8 || null,
    streams: qualityPlaylists,
    subtitles,
    servers: serverList,
    timestamp: new Date().toISOString(),
    error: pageError || null,
  };
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`LordFlix API running on http://0.0.0.0:${PORT}`);
});
