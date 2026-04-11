# YFIT Video Assembly Service

Lightweight microservice that assembles branded fitness videos from ElevenLabs voiceover audio + YFIT branded background image using ffmpeg. Runs on Railway alongside n8n.

## How It Works

1. Receives POST `/assemble` from n8n workflow
2. Downloads the ElevenLabs MP3 voiceover from Supabase Storage
3. Creates a branded YFIT background (1080x1920 for vertical video)
4. Runs ffmpeg to combine image + audio into MP4
5. Uploads finished MP4 to Supabase Storage (`yfit-videos` bucket)
6. Returns the public video URL to n8n

## Endpoints

- `GET /health` — Health check, reports ffmpeg version
- `POST /assemble` — Assemble video (requires `Authorization: Bearer <API_SECRET>`)

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (Railway sets this automatically) |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `API_SECRET` | Bearer token for authenticating n8n requests |

## Deploy to Railway

1. Push this repo to GitHub (e.g., `yfitai/yfit-video-service`)
2. In Railway dashboard → New Service → Deploy from GitHub repo
3. Set environment variables above
4. Railway auto-builds via Dockerfile (installs ffmpeg + Node.js)

## Request Format

```json
POST /assemble
Authorization: Bearer <API_SECRET>
Content-Type: application/json

{
  "voiceover_url": "https://mxggxpoxgqubojvumjlt.supabase.co/storage/v1/object/public/yfit-voiceovers/voiceovers/2026-04-03_workout_tips.mp3",
  "run_date": "2026-04-03",
  "content_angle": "3 quick tips to boost your morning workout energy",
  "caption_text": "3 quick tips to boost your morning workout energy",
  "video_items": [
    { "platform": "tiktok", "caption": "#fitness #workout", "hashtags": ["fitness"] },
    { "platform": "instagram", "caption": "Morning tips", "hashtags": ["fitness"] }
  ],
  "text_items": [
    { "platform": "linkedin", "content": "Science-backed morning workout tips..." }
  ],
  "dry_run": false
}
```

## Response

```json
{
  "success": true,
  "dry_run": false,
  "job_id": "2026-04-03_1712345678",
  "video_url": "https://mxggxpoxgqubojvumjlt.supabase.co/storage/v1/object/public/yfit-videos/videos/2026-04-03_workout_tips.mp4",
  "video_size_bytes": 4500000,
  "platforms": ["tiktok", "instagram"],
  "text_platforms": ["linkedin"],
  "voiceover_url": "...",
  "content_angle": "...",
  "run_date": "2026-04-03"
}
```
# v2.5.1 - BGM fix deployed Sat Apr 11 10:14:44 EDT 2026
