// Daily Challenge leaderboard — Phase 3 (Addendum A5, 2026-05-01).
//
// Slay-the-Spire-style daily climb: every player who completes today's
// daily challenge submits a score, the top 100 ranks display on the
// leaderboard screen. Lower-is-better (golf scoring) — see
// services/dailyChallenge.ts for the formula.
//
// Storage shape: one Upstash sorted set per local date.
//   key:    wildex:daily:YYYY-MM-DD
//   members: leaderboard handle (3-16 char alphanumeric + dash + underscore)
//   scores:  challenge score (lower is better, 1 minimum)
//
// Sets auto-expire after 30 days so the proxy doesn't accumulate
// historical leaderboards forever (only "today" matters in practice;
// past days are interesting only for the 7-day "rolling top scores"
// future feature).
//
// Endpoints:
//   POST /api/daily
//     Body: { date, handle, score }
//     Submits the player's score. Uses ZADD LT — only replaces the
//     handle's existing score if the new submission is LOWER (better).
//     Returns: { ok, myScore, myRank, total }
//   GET /api/daily?date=YYYY-MM-DD&handle=mine
//     Returns: { top: [{handle, score, rank}], myRank, myScore, total, date }
//     Cache: 20s edge cache. Top 100 + caller's row by handle if any.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";
import { checkRateLimit, clientIp } from "../lib/ratelimit.js";

const TOP_N = 100;
const KEY_TTL_DAYS = 30;
const KEY_TTL_SECONDS = KEY_TTL_DAYS * 86_400;

const dateKey = (date: string) => `wildex:daily:${date}`;

let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

interface SubmitBody {
  date?: unknown;
  handle?: unknown;
  score?: unknown;
}

interface LeaderboardEntry {
  rank: number;
  handle: string;
  score: number;
}

/** Validate YYYY-MM-DD format. Defensive — rejects anything else so a
 *  malicious client can't seed a key like "wildex:daily:*" with wildcards. */
function isValidDate(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const d = new Date(raw + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return true;
}

/** Validate handle: 3-16 chars, lowercase alphanumeric + dash + underscore.
 *  Mirrors state/player.ts setLeaderboardHandle sanitization so the
 *  client + server agree on format. */
function isValidHandle(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length < 3 || raw.length > 16) return false;
  return /^[a-z0-9_-]+$/.test(raw);
}

/** Validate score: positive integer between 1 and 10000. The score
 *  formula caps far below this in practice (max ~120 for a 12-turn
 *  perfect-loss run); the cap protects against malicious submissions. */
function isValidScore(raw: unknown): raw is number {
  if (typeof raw !== "number") return false;
  if (!Number.isFinite(raw)) return false;
  if (raw < 1 || raw > 10000) return false;
  return Math.floor(raw) === raw;
}

async function readTopAndMine(
  redis: Redis,
  date: string,
  myHandle: string | null,
): Promise<{
  top: LeaderboardEntry[];
  myRank: number | null;
  myScore: number | null;
  total: number;
}> {
  const key = dateKey(date);
  // Pipeline: top N by ascending score, my rank if handle given, total
  // count for "rank X of N" display.
  const [topRaw, myRankRaw, myScoreRaw, total] = await Promise.all([
    // ZRANGE with WITHSCORES + REV=false (default ascending = lower-is-better top).
    redis.zrange<(string | number)[]>(key, 0, TOP_N - 1, { withScores: true }),
    myHandle ? redis.zrank(key, myHandle) : Promise.resolve(null),
    myHandle ? redis.zscore<number>(key, myHandle) : Promise.resolve(null),
    redis.zcard(key),
  ]);

  // ZRANGE WITHSCORES returns flat [member, score, member, score, ...]
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
    const date = typeof req.query.date === "string" ? req.query.date : "";
    const myHandle = typeof req.query.handle === "string" ? req.query.handle : null;
    if (!isValidDate(date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    if (myHandle !== null && !isValidHandle(myHandle)) {
      res.status(400).json({ error: "invalid_handle" });
      return;
    }
    try {
      const data = await readTopAndMine(redis, date, myHandle);
      res.setHeader("cache-control", "public, max-age=20");
      res.status(200).json({ ...data, date });
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
    if (!isValidDate(body.date)) {
      res.status(400).json({ error: "invalid_date" });
      return;
    }
    if (!isValidHandle(body.handle)) {
      res.status(400).json({ error: "invalid_handle" });
      return;
    }
    if (!isValidScore(body.score)) {
      res.status(400).json({ error: "invalid_score" });
      return;
    }
    const date = body.date as string;
    const handle = body.handle as string;
    const score = body.score as number;
    const key = dateKey(date);

    try {
      // ZADD with LT modifier: only update if the new score is LESS than
      // the existing one. New entries always added. Mirrors "best score
      // of the day per handle" — players can replay + improve.
      // Then EXPIRE so old leaderboard keys auto-clean after 30 days.
      await Promise.all([
        redis.zadd(key, { lt: true }, { score, member: handle }),
        redis.expire(key, KEY_TTL_SECONDS),
      ]);
      // Return the player's resulting score + rank so the client can
      // celebrate immediately without a follow-up GET.
      const data = await readTopAndMine(redis, date, handle);
      res.setHeader("cache-control", "no-store");
      res.status(200).json({ ok: true, ...data, date });
    } catch {
      res.status(502).json({ error: "redis_write_failed" });
    }
    return;
  }

  res.setHeader("allow", "GET, POST");
  res.status(405).json({ error: "method_not_allowed" });
}
