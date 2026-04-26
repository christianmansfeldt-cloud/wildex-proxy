// Wildex Community counter — global metrics shared across every install.
//
// Three counters live in the same Upstash Redis instance the proxy already
// uses for rate-limit + budget tracking. Atomic INCRBY per write; cheap GET
// on the read side.
//
//   wildex:comm:captures   — cumulative count of every capture by every player
//   wildex:comm:sqm        — cumulative m² protected (floor of playtime/300s)
//   wildex:comm:playtime   — cumulative seconds of foreground play
//
// Endpoints:
//   POST /api/community
//     Body: { captures?: number, sqm?: number, playtime?: number }
//     All fields optional; non-zero positive integers are INCRBY'd.
//     Returns: { ok: true } on success.
//   GET /api/community
//     Returns: { captures: number, sqm: number, playtime: number }
//
// Best-effort design — clients (services/community.ts in the RN app) catch
// errors silently. The Protect tab simply doesn't show stale numbers if the
// proxy is down. The counters don't drive any gameplay; they're a panel.
//
// Rate-limit: shares the existing checkRateLimit (60/hr per IP). Each
// playtime tick = 1 command, each capture = 1 command. Free tier (10k/day)
// covers ~1 active user-day at the current 10s tick cadence; if we hit
// scale, batch the playtime updates client-side or move to paid Upstash.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { checkRateLimit, clientIp } from "../lib/ratelimit.js";

const KEY_CAPTURES = "wildex:comm:captures";
const KEY_SQM = "wildex:comm:sqm";
const KEY_PLAYTIME = "wildex:comm:playtime";

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

interface IncrementBody {
  captures?: unknown;
  sqm?: unknown;
  playtime?: unknown;
}

interface CommunityTotals {
  captures: number;
  sqm: number;
  playtime: number;
}

/** Defensive: only positive finite integers get applied. Caps each delta
 *  at 10000 to bound a misbehaving / malicious client (the largest legit
 *  single-call delta is 10s of playtime or 1 capture; 10000 is absurdly
 *  high but a reasonable safety net). */
function sanitizeDelta(raw: unknown): number {
  if (typeof raw !== "number") return 0;
  if (!Number.isFinite(raw)) return 0;
  const n = Math.floor(raw);
  if (n <= 0) return 0;
  return Math.min(n, 10_000);
}

async function readTotals(redis: Redis): Promise<CommunityTotals> {
  // Pipeline 3 GETs into a single roundtrip for cost efficiency on Upstash.
  const [captures, sqm, playtime] = await Promise.all([
    redis.get<number>(KEY_CAPTURES),
    redis.get<number>(KEY_SQM),
    redis.get<number>(KEY_PLAYTIME),
  ]);
  return {
    captures: typeof captures === "number" ? captures : Number(captures ?? 0) || 0,
    sqm: typeof sqm === "number" ? sqm : Number(sqm ?? 0) || 0,
    playtime: typeof playtime === "number" ? playtime : Number(playtime ?? 0) || 0,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    res.status(500).json({ error: "redis_unavailable" });
    return;
  }

  if (req.method === "GET") {
    // Public-readable. Brief edge cache so the Protect tab doesn't hammer
    // Upstash if many users open the tab simultaneously. 60s is coarse
    // enough that any single capture's update lands on the next refresh
    // without burning IOPs.
    try {
      const totals = await readTotals(redis);
      res.setHeader("cache-control", "public, max-age=60");
      res.status(200).json(totals);
    } catch {
      res.status(502).json({ error: "redis_read_failed" });
    }
    return;
  }

  if (req.method === "POST") {
    // Rate-limit the write side only (reads are cheap + cached).
    const ip = clientIp(req);
    const rl = await checkRateLimit(ip);
    if (!rl.ok) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    const body = (req.body ?? {}) as IncrementBody;
    const dCaptures = sanitizeDelta(body.captures);
    const dSqm = sanitizeDelta(body.sqm);
    const dPlaytime = sanitizeDelta(body.playtime);

    if (dCaptures === 0 && dSqm === 0 && dPlaytime === 0) {
      res.status(400).json({ error: "no_deltas" });
      return;
    }

    try {
      // Pipeline parallel INCRBYs. Atomic per key (Redis INCRBY is
      // single-op atomic). Skip keys with 0 delta to save commands.
      const ops: Promise<unknown>[] = [];
      if (dCaptures > 0) ops.push(redis.incrby(KEY_CAPTURES, dCaptures));
      if (dSqm > 0) ops.push(redis.incrby(KEY_SQM, dSqm));
      if (dPlaytime > 0) ops.push(redis.incrby(KEY_PLAYTIME, dPlaytime));
      await Promise.all(ops);
      res.setHeader("cache-control", "no-store");
      res.status(200).json({ ok: true });
    } catch {
      res.status(502).json({ error: "redis_write_failed" });
    }
    return;
  }

  res.setHeader("allow", "GET, POST");
  res.status(405).json({ error: "method_not_allowed" });
}
