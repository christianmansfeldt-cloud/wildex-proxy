// GET /api/profile/{handle} — Phase 6 (Addendum A5, 2026-05-03).
//
// Public-readable profile lookup. Returns the row from `profiles` for
// the given handle, or 404 if no such handle has claimed yet. Used by:
//   · Friends list rendering (lifetime stats + last_seen_at)
//   · "Add friend by handle" flow — confirms the handle exists before
//     storing it locally
//   · Future "view friend's profile" detail screen
//
// Cache: 60s edge cache. Stats only change at battle/capture intervals
// (fastest cadence: once per ~10s of foreground play). Stale-by-60s is
// acceptable for the friends list; the player can pull-to-refresh for
// fresh data on the detail screen.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase, isValidHandle, type ProfileRow } from "../../lib/supabase.js";

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  // Vercel routes /api/profile/{handle} → req.query.handle
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
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("handle", handle)
      .maybeSingle();
    if (error) {
      res.status(502).json({ error: "supabase_read_failed", detail: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ error: "not_found", handle });
      return;
    }
    res.setHeader("cache-control", "public, max-age=60");
    res.status(200).json({ profile: data as ProfileRow });
  } catch (err) {
    res.status(502).json({
      error: "supabase_read_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
