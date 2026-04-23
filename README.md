# wildex-proxy

Vercel proxy for the Wildex mobile app. Hides the Anthropic API key, rate-limits per IP, caps daily spend.

## Endpoints

- `POST /api/identify` — Claude Opus 4.7 vision. Body: `{ imageBase64, mediaType? }`. Returns `{ matchedId, commonName, latinName, confidence, iucnGuess }`.
- `POST /api/chat` — Claude Opus 4.7 streaming. Server-sent events (`data: {"type":"delta","text":"..."}` then `data: {"type":"done"}`). Body: `{ wilder: {...}, messages: [...] }`.
- `GET /api/_warmup` — connection warm-up. Returns 200 with no body.

All three run on Vercel Node 22.x (Fluid Compute).

## Env vars

See `.env.example`. Set in Vercel dashboard, not committed.

- `ANTHROPIC_API_KEY` (required)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (optional; without these, rate limit + budget cap fail-open)
- `MAX_DAILY_USD` (default 25)

## Deploy

```bash
vercel deploy --prod
```

First deploy will prompt to create the project.

## Rate limits

60 requests per hour per IP, sliding window via Upstash. Daily budget cap fails-closed on overflow (returns 503).
