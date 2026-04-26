import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import type { VercelRequest } from "@vercel/node";

let _ratelimit: Ratelimit | null = null;
let _redis: Redis | null = null;

function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  _redis = new Redis({ url, token });
  return _redis;
}

function getRatelimit(): Ratelimit | null {
  if (_ratelimit) return _ratelimit;
  const redis = getRedis();
  if (!redis) return null;
  _ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "1 h"),
    analytics: false,
    prefix: "wildex:rl",
  });
  return _ratelimit;
}

export async function checkRateLimit(ip: string): Promise<{ ok: boolean; remaining: number }> {
  const rl = getRatelimit();
  // No Redis configured: fail-OPEN (matches checkBudget's no-config branch).
  // This is a deployment concern — missing env vars shouldn't 429 every request
  // in dev. In prod the env vars MUST be set; deployment-time checks catch this.
  if (!rl) return { ok: true, remaining: 999 };
  // Redis configured but call errors (network blip, quota exhaustion, partial
  // outage): fail-CLOSED. Aligns with checkBudget's catch branch — when the
  // backend is misbehaving, deny rather than risk abuse. Caller in
  // api/identify.ts already returns 429 on !ok.
  // 2026-04-25 P2 fix (post qa-review): was fail-OPEN here, abusable.
  try {
    const { success, remaining } = await rl.limit(ip);
    return { ok: success, remaining };
  } catch {
    return { ok: false, remaining: 0 };
  }
}

const DAILY_BUDGET_USD = Number(process.env.MAX_DAILY_USD ?? "25");

export async function checkBudget(estimatedCostUsd: number): Promise<{ ok: boolean; spent: number }> {
  const redis = getRedis();
  if (!redis) return { ok: true, spent: 0 };
  const dayKey = `wildex:budget:${new Date().toISOString().slice(0, 10)}`;
  const cents = Math.ceil(estimatedCostUsd * 100);
  try {
    const newSpentCents = await redis.incrby(dayKey, cents);
    await redis.expire(dayKey, 60 * 60 * 26);
    const spent = newSpentCents / 100;
    return { ok: spent <= DAILY_BUDGET_USD, spent };
  } catch {
    return { ok: false, spent: DAILY_BUDGET_USD };
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export function clientIp(req: VercelRequest): string {
  const realIp = headerValue(req.headers["x-real-ip"]);
  if (realIp) return realIp.trim();
  const fwd = headerValue(req.headers["x-forwarded-for"]);
  if (fwd) {
    const first = fwd.split(",")[0];
    if (first) return first.trim();
  }
  return "unknown";
}
