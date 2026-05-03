// GET /api/friends/list?handle={my_handle} — Phase 6 (Addendum A5, 2026-05-03).
//
// Returns the caller's friend list with each friend's profile + the
// friendship's created_at timestamp. The query joins `friends` ↔
// `profiles` so the client gets everything it needs in a single round-
// trip (no N+1 lookups).
//
// Returns: {
//   friends: Array<{
//     handle: string,
//     created_at: string,         // friendship started
//     profile: ProfileRow         // friend's stats + last_seen_at
//   }>
// }
//
// The list is sorted most-recently-active-first (last_seen_at desc) so
// the friends list highlights players who are likely to respond to
// challenges quickly.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase, isValidHandle, type ProfileRow } from "../../lib/supabase.js";

interface FriendWithProfile {
  handle: string;
  created_at: string;
  profile: ProfileRow;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const handle = typeof req.query.handle === "string" ? req.query.handle : "";
  if (!isValidHandle(handle)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "supabase_unavailable" });
    return;
  }

  try {
    // The friends table is symmetric — caller could be in handle_a OR
    // handle_b. Query both and union the results, mapping the OTHER
    // handle into the response. Two queries beats a single .or() call
    // here because PostgREST's .or() has limitations with join syntax.
    const [{ data: asA, error: aErr }, { data: asB, error: bErr }] = await Promise.all([
      supabase
        .from("friends")
        .select("created_at, handle_b, profile:profiles!friends_handle_b_fkey(*)")
        .eq("handle_a", handle),
      supabase
        .from("friends")
        .select("created_at, handle_a, profile:profiles!friends_handle_a_fkey(*)")
        .eq("handle_b", handle),
    ]);
    if (aErr || bErr) {
      res.status(502).json({
        error: "supabase_read_failed",
        detail: aErr?.message ?? bErr?.message,
      });
      return;
    }

    const friends: FriendWithProfile[] = [];
    for (const row of asA ?? []) {
      const r = row as unknown as { created_at: string; handle_b: string; profile: ProfileRow | null };
      if (r.profile) {
        friends.push({ handle: r.handle_b, created_at: r.created_at, profile: r.profile });
      }
    }
    for (const row of asB ?? []) {
      const r = row as unknown as { created_at: string; handle_a: string; profile: ProfileRow | null };
      if (r.profile) {
        friends.push({ handle: r.handle_a, created_at: r.created_at, profile: r.profile });
      }
    }

    // Sort by last_seen_at desc — most recently active first so the
    // list highlights players likely to respond to challenges quickly.
    friends.sort((x, y) => {
      const xMs = new Date(x.profile.last_seen_at).getTime();
      const yMs = new Date(y.profile.last_seen_at).getTime();
      return yMs - xMs;
    });

    res.setHeader("cache-control", "no-store");
    res.status(200).json({ friends });
  } catch (err) {
    res.status(502).json({
      error: "supabase_read_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
