// POST /api/friends/remove — Phase 6 (Addendum A5, 2026-05-03).
//
// Symmetric removal: delete the friendship pair. Either side can
// initiate. Idempotent — removing a non-existent friendship returns
// 200 + ok=true (no error).
//
// Body: { my_handle: string, friend_handle: string }
//
// Note: this does NOT cancel pending challenges between the two
// players. They remain in the `challenges` table and can still be
// completed/declined; only the friendship link is severed. (Real
// Twitter / Discord pattern: blocking is a stronger signal than
// unfriending.)

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  orderFriendPair,
} from "../../lib/supabase.js";
import { checkRateLimit, clientIp } from "../../lib/ratelimit.js";

interface RemoveBody {
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

  const body = (req.body ?? {}) as RemoveBody;
  if (!isValidHandle(body.my_handle) || !isValidHandle(body.friend_handle)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }
  const myHandle = body.my_handle as string;
  const friendHandle = body.friend_handle as string;
  if (myHandle === friendHandle) {
    res.status(400).json({ error: "cannot_remove_self" });
    return;
  }

  try {
    const [a, b] = orderFriendPair(myHandle, friendHandle);
    const { error } = await supabase
      .from("friends")
      .delete()
      .eq("handle_a", a)
      .eq("handle_b", b);
    if (error) {
      res.status(502).json({ error: "supabase_write_failed", detail: error.message });
      return;
    }
    // Whether the row existed or not, the result is "you are not
    // friends with this person" — return ok=true either way.
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
