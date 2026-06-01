# LordFlix Stream Extractor API

Extract streaming URLs from LordFlix as JSON.

## Quick Deploy

```bash
# Install dependencies
npm install

# Install Chromium (required by Playwright)
npx playwright install chromium --with-deps

# Start server
npm start
```

Server runs on `http://0.0.0.0:3000`.

## API Endpoints

### Health Check
```
GET /
```

### Extract Streams
```
POST /api/extract
Content-Type: application/json

{
  "type": "tv",
  "tmdbId": "220102",
  "season": "1",
  "episode": "1"
}
```

**Movie example:**
```json
{ "type": "movie", "tmdbId": "1216578" }
```

**TV example:**
```json
{ "type": "tv", "tmdbId": "220102", "season": "1", "episode": "1" }
```

### Response
```json
{
  "title": "Show Name",
  "type": "tv",
  "tmdbId": "220102",
  "season": "1",
  "episode": "1",
  "watchUrl": "https://lordflix.org/watch/tv/220102/1/1",
  "masterM3u8": "https://...",
  "streams": [
    { "quality": "1080p", "url": "https://..." },
    { "quality": "720p", "url": "https://..." },
    { "quality": "480p", "url": "https://..." },
    { "quality": "audio", "url": "https://..." }
  ],
  "subtitles": [
    { "language": "en", "label": "English", "url": "https://..." }
  ],
  "servers": ["Berlin", "Backrooms", "Marseille"],
  "timestamp": "2025-01-01T00:00:00.000Z",
  "error": null
}
```

## Deploy on VPS

```bash
# Clone your repo
git clone <your-repo-url> && cd lordflix-api

# Install & start
npm install
npx playwright install chromium --with-deps
npm start
```

### Run with PM2 (recommended)
```bash
npm install -g pm2
pm2 start server.js --name lordflix-api
pm2 save
pm2 startup
```

### Reverse proxy with Nginx
```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 120s;
    }
}
```

### Change port
```bash
PORT=8080 npm start
```
