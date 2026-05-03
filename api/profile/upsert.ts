// POST /api/profile/upsert — Phase 6 (Addendum A5, 2026-05-03).
//
// Claim a handle in the public namespace + push the player's lifetime
// stats. Lazy claim: the client calls this on first friend interaction
// (Add Friend / Send Challenge / view Friends leaderboard). Same handle
// can be re-upserted by the same player to refresh stats.
//
// Body: {
//   handle: string,                            // 3-16 char alphanumeric + - _
//   stats: {
//     lifetime_captures: number,
//     lifetime_wins: number,
//     lifetime_sqm: number,
//     lifetime_trophies: number,
//     weekly_wins: number,
//     mastered_species: number,
//     current_streak: number,
//   }
// }
//
// Returns: { ok: true, profile: ProfileRow }
//
// Conflict semantics: handle is the PRIMARY KEY. If two players try to
// claim the same handle, the SECOND one wins (UPSERT behavior). For v1
// this is acceptable — handle conflicts are rare + manually resolvable.
// Future: lock handle to first claimant via insert + 409 conflict path
// once a real auth model exists.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase, isValidHandle, isHandleProfane, type ProfileRow } from "../../lib/supabase.js";
import { checkRateLimit, clientIp } from "../../lib/ratelimit.js";

interface UpsertBody {
  handle?: unknown;
  stats?: unknown;
}

interface StatsBody {
  lifetime_captures?: unknown;
  lifetime_wins?: unknown;
  lifetime_sqm?: unknown;
  lifetime_trophies?: unknown;
  weekly_wins?: unknown;
  mastered_species?: unknown;
  current_streak?: unknown;
}

/** Validate + clamp a stat value to a reasonable range. Same caps as
 *  the leaderboards endpoint — bounds malicious or buggy clients. */
function sanitizeStat(raw: unknown): number {
  if (typeof raw !== "number") return 0;
  if (!Number.isFinite(raw)) return 0;
  const n = Math.floor(raw);
  if (n < 0) return 0;
  return Math.min(n, 999_999);
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const ip = clientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "supabase_unavailable" });
    return;
  }

  const body = (req.body ?? {}) as UpsertBody;
  if (!isValidHandle(body.handle)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }
  if (isHandleProfane(body.handle)) {
    res.status(400).json({ error: "profane_handle" });
    return;
  }
  const handle = body.handle as string;
  const stats = (body.stats ?? {}) as StatsBody;

  const upsertRow = {
    handle,
    last_seen_at: new Date().toISOString(),
    lifetime_captures: sanitizeStat(stats.lifetime_captures),
    lifetime_wins: sanitizeStat(stats.lifetime_wins),
    lifetime_sqm: sanitizeStat(stats.lifetime_sqm),
    lifetime_trophies: sanitizeStat(stats.lifetime_trophies),
    weekly_wins: sanitizeStat(stats.weekly_wins),
    mastered_species: sanitizeStat(stats.mastered_species),
    current_streak: sanitizeStat(stats.current_streak),
  };

  try {
    const { data, error } = await supabase
      .from("profiles")
      .upsert(upsertRow, { onConflict: "handle" })
      .select()
      .single();
    if (error) {
      res.status(502).json({ error: "supabase_write_failed", detail: error.message });
      return;
    }
    res.setHeader("cache-control", "no-store");
    res.status(200).json({ ok: true, profile: data as ProfileRow });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
