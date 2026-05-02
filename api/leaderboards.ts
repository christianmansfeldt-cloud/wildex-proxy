// L2 lifetime-stats leaderboards — Phase 4 (Addendum A5, 2026-05-02).
//
// Multi-dimension lifetime leaderboard (no daily reset). Each
// dimension is a separate Upstash sorted set so reads + writes are
// independent + cheap. The Profile + Daily-Challenge screens both
// read from this endpoint to render "where I rank."
//
// Dimensions:
//   captures   — total captures (lifetime)
//   sqm        — m² protected (playtime / 300 floor)
//   wins       — lifetime battle wins
//   streak     — current capture streak length
//   mastered   — count of species at Mastered tier
//   trophies   — current solo trophy count
//   weekly     — current rolling-window weekly wins
//
// Storage:
//   key:    wildex:lb:{dimension}    (e.g. wildex:lb:captures)
//   member: handle (3-16 char alphanumeric + dash + underscore)
//   score:  the value (HIGHER is better — uses ZADD GT semantics)
//
// Endpoints:
//   POST /api/leaderboards
//     Body: { handle, dims: { [name]: number } }
//     Updates ALL provided dimensions in one call. Uses ZADD GT so
//     only HIGHER scores replace existing entries (cumulative
//     lifetime stats are monotonic, but defensive against bugs).
//     Returns: { ok: true, dims: { [name]: { rank, total } } }
//   GET /api/leaderboards?dim=captures&handle=mine
//     Returns: { dim, top: [{rank, handle, score}], myRank, myScore, total }
//
// Cache: GET = 60s edge cache (lifetime stats change slowly).
// POST = no-cache, written through.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { checkRateLimit, clientIp } from "../lib/ratelimit.js";

const TOP_N = 100;

const DIMENSIONS = ["captures", "sqm", "wins", "streak", "mastered", "trophies", "weekly"] as const;
type Dimension = (typeof DIMENSIONS)[number];

const dimKey = (dim: Dimension) => `wildex:lb:${dim}`;

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

interface LeaderboardEntry {
  rank: number;
  handle: string;
  score: number;
}

interface SubmitBody {
  handle?: unknown;
  dims?: unknown;
}

function isValidDimension(raw: unknown): raw is Dimension {
  return typeof raw === "string" && (DIMENSIONS as readonly string[]).includes(raw);
}

function isValidHandle(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length < 3 || raw.length > 16) return false;
  return /^[a-z0-9_-]+$/.test(raw);
}

function isValidScore(raw: unknown): raw is number {
  if (typeof raw !== "number") return false;
  if (!Number.isFinite(raw)) return false;
  if (raw < 0) return false;
  // Cap at 999_999 — no legitimate stat exceeds this; bounds malice.
  if (raw > 999_999) return false;
  return Math.floor(raw) === raw;
}

async function readDimSnapshot(
  redis: Redis,
  dim: Dimension,
  myHandle: string | null,
): Promise<{
  top: LeaderboardEntry[];
  myRank: number | null;
  myScore: number | null;
  total: number;
}> {
  const key = dimKey(dim);
  // ZRANGE with REV=true so HIGHER scores rank first (lifetime stats
  // are higher-is-better; daily challenge uses ascending).
  const [topRaw, myRankRaw, myScoreRaw, total] = await Promise.all([
    redis.zrange<(string | number)[]>(key, 0, TOP_N - 1, { rev: true, withScores: true }),
    myHandle ? redis.zrevrank(key, myHandle) : Promise.resolve(null),
    myHandle ? redis.zscore<number>(key, myHandle) : Promise.resolve(null),
    redis.zcard(key),
  ]);

  const top: LeaderboardEntry[] = [];
  if (Array.isArray(topRaw)) {
    for (let i = 0; i < topRaw.length; i += 2) {
      const member = topRaw[i];
      const score = topRaw[i + 1];
      if (typeof member === "string" && (typeof score === "number" || typeof score === "string")) {
        top.push({
          rank: top.length + 1,
          handle: member,
          score: typeof score === "number" ? score : Number(score),
        });
      }
    }
  }

  return {
    top,
    myRank: typeof myRankRaw === "number" ? myRankRaw + 1 : null,
    myScore: typeof myScoreRaw === "number" ? myScoreRaw : null,
    total: typeof total === "number" ? total : 0,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const redis = getRedis();
  if (!redis) {
    res.status(500).json({ error: "redis_unavailable" });
    return;
  }

  if (req.method === "GET") {
    const dim = typeof req.query.dim === "string" ? req.query.dim : "";
    const myHandle = typeof req.query.handle === "string" ? req.query.handle : null;
    if (!isValidDimension(dim)) {
      res.status(400).json({ error: "invalid_dimension" });
      return;
    }
    if (myHandle !== null && !isValidHandle(myHandle)) {
      res.status(400).json({ error: "invalid_handle" });
      return;
    }
    try {
      const snap = await readDimSnapshot(redis, dim, myHandle);
      res.setHeader("cache-control", "public, max-age=60");
      res.status(200).json({ dim, ...snap });
    } catch {
      res.status(502).json({ error: "redis_read_failed" });
    }
    return;
  }

  if (req.method === "POST") {
    const ip = clientIp(req);
    const rl = await checkRateLimit(ip);
    if (!rl.ok) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    const body = (req.body ?? {}) as SubmitBody;
    if (!isValidHandle(body.handle)) {
      res.status(400).json({ error: "invalid_handle" });
      return;
    }
    if (typeof body.dims !== "object" || body.dims === null) {
      res.status(400).json({ error: "invalid_dims" });
      return;
    }
    const handle = body.handle as string;
    const dimsBody = body.dims as Record<string, unknown>;
    // Validate every entry up-front; reject the whole submission if
    // any single dim is malformed (so partial-write bugs don't drift
    // the leaderboard out of sync with the client).
    const validDims: { dim: Dimension; score: number }[] = [];
    for (const [k, v] of Object.entries(dimsBody)) {
      if (!isValidDimension(k)) {
        res.status(400).json({ error: "invalid_dimension", dim: k });
        return;
      }
      if (!isValidScore(v)) {
        res.status(400).json({ error: "invalid_score", dim: k });
        return;
      }
      validDims.push({ dim: k, score: v });
    }
    if (validDims.length === 0) {
      res.status(400).json({ error: "no_dims" });
      return;
    }
    try {
      // ZADD GT: only update when the new score is GREATER than
      // existing (lifetime stats are monotonic upward — defense in
      // depth against bugs that could submit a stale lower value).
      await Promise.all(
        validDims.map((d) =>
          redis.zadd(dimKey(d.dim), { gt: true }, { score: d.score, member: handle }),
        ),
      );
      // Return the resulting rank/total per dim so the client can
      // celebrate immediately without follow-up reads.
      const out: Record<Dimension, { rank: number | null; total: number }> = {} as Record<
        Dimension,
        { rank: number | null; total: number }
      >;
      const reads = await Promise.all(
        validDims.map(async (d) => {
          const [rank, total] = await Promise.all([
            redis.zrevrank(dimKey(d.dim), handle),
            redis.zcard(dimKey(d.dim)),
          ]);
          return {
            dim: d.dim,
            rank: typeof rank === "number" ? rank + 1 : null,
            total: typeof total === "number" ? total : 0,
          };
        }),
      );
      for (const r of reads) out[r.dim] = { rank: r.rank, total: r.total };
      res.setHeader("cache-control", "no-store");
      res.status(200).json({ ok: true, dims: out });
    } catch {
      res.status(502).json({ error: "redis_write_failed" });
    }
    return;
  }

  res.setHeader("allow", "GET, POST");
  res.status(405).json({ error: "method_not_allowed" });
}
