// POST /api/friends/add — Phase 6 (Addendum A5, 2026-05-03).
//
// Asymmetric instant-add (Twitter-follow style per locked decision #2):
// caller creates a friendship row with the target handle. No accept/
// decline; the target sees the friendship the next time they open
// their friends list. Friendships are bidirectional in storage (one
// row per pair, ordered handle_a < handle_b) — both sides see each
// other.
//
// Body: { my_handle: string, friend_handle: string }
//
// Validation:
//   · both handles valid format
//   · my_handle != friend_handle (no self-add)
//   · both handles must exist in `profiles` (no adding ghosts)
//   · friend_handle's profile must exist (we 404 otherwise so the
//     client can show "no such player" instead of silently storing a
//     dead reference)
//
// Idempotent: re-adding an already-friends pair returns 200 + ok=true
// + already=true (no error). The schema's PRIMARY KEY constraint
// would otherwise throw a duplicate-key error.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  orderFriendPair,
} from "../../lib/supabase.js";
import { checkRateLimit, clientIp } from "../../lib/ratelimit.js";

interface AddBody {
  my_handle?: unknown;
  friend_handle?: unknown;
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

  const body = (req.body ?? {}) as AddBody;
  if (!isValidHandle(body.my_handle) || !isValidHandle(body.friend_handle)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }
  const myHandle = body.my_handle as string;
  const friendHandle = body.friend_handle as string;
  if (myHandle === friendHandle) {
    res.status(400).json({ error: "cannot_add_self" });
    return;
  }

  try {
    // Verify both profiles exist before inserting the friendship row.
    // The friends table FKs to profiles ON DELETE CASCADE, but FK
    // enforcement at insert time gives a generic error — checking
    // upfront lets us return a clean 404 telling the client which
    // handle was missing.
    const { data: profiles, error: lookupErr } = await supabase
      .from("profiles")
      .select("handle")
      .in("handle", [myHandle, friendHandle]);
    if (lookupErr) {
      res.status(502).json({ error: "supabase_read_failed", detail: lookupErr.message });
      return;
    }
    const found = new Set((profiles ?? []).map((p: { handle: string }) => p.handle));
    if (!found.has(myHandle)) {
      res.status(409).json({ error: "claim_handle_first", missing: myHandle });
      return;
    }
    if (!found.has(friendHandle)) {
      res.status(404).json({ error: "friend_not_found", missing: friendHandle });
      return;
    }

    const [a, b] = orderFriendPair(myHandle, friendHandle);
    // Idempotent insert: ignore duplicate-key errors. Postgres returns
    // SQLSTATE 23505 for unique violations; the supabase-js error has
    // .code === "23505" in that case.
    const { error: insertErr } = await supabase
      .from("friends")
      .insert({ handle_a: a, handle_b: b });
    if (insertErr) {
      const code = (insertErr as { code?: string }).code;
      if (code === "23505") {
        res.status(200).json({ ok: true, already: true });
        return;
      }
      res.status(502).json({ error: "supabase_write_failed", detail: insertErr.message });
      return;
    }

    res.status(200).json({ ok: true, already: false });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
