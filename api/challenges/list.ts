// GET /api/challenges/list?handle={my_handle}&direction={inbound|outbound|all}
//   — Phase 6 (Addendum A5, 2026-05-03).
//
// Returns the caller's challenges. Direction filter:
//   · inbound  = challenges sent TO me (receiver_handle == handle)
//   · outbound = challenges sent BY me (sender_handle == handle)
//   · all      = both (default)
//
// Lazy expiry: every list call also runs `expire_old_challenges()`
// (RPC) to mark stale pending challenges as expired before reading.
// Avoids needing pg_cron or a Vercel scheduled function for v1; cost
// is one extra SQL function call per /list (~5ms).
//
// Returns: {
//   inbound:  ChallengeRow[],   // sorted by created_at desc
//   outbound: ChallengeRow[],
// }

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabase, isValidHandle, type ChallengeRow } from "../../lib/supabase.js";

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
  const direction =
    typeof req.query.direction === "string" ? req.query.direction : "all";
  if (direction !== "inbound" && direction !== "outbound" && direction !== "all") {
    res.status(400).json({ error: "invalid_direction" });
    return;
  }

  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ error: "supabase_unavailable" });
    return;
  }

  try {
    // Lazy expiry sweep — best-effort. Errors don't block the read.
    // 2026-05-03: PostgrestFilterBuilder isn't a Promise until awaited,
    // so .catch chaining doesn't work directly. Wrap in try/catch.
    try {
      await supabase.rpc("expire_old_challenges");
    } catch {
      // Swallow — sweep will retry next /list call. Stale "pending"
      // rows just look pending until then; no functional impact.
    }

    const wantInbound = direction === "inbound" || direction === "all";
    const wantOutbound = direction === "outbound" || direction === "all";

    const [inbound, outbound] = await Promise.all([
      wantInbound
        ? supabase
            .from("challenges")
            .select("*")
            .eq("receiver_handle", handle)
            .order("created_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [], error: null }),
      wantOutbound
        ? supabase
            .from("challenges")
            .select("*")
            .eq("sender_handle", handle)
            .order("created_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (inbound.error || outbound.error) {
      res.status(502).json({
        error: "supabase_read_failed",
        detail: inbound.error?.message ?? outbound.error?.message,
      });
      return;
    }

    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      inbound: (inbound.data ?? []) as ChallengeRow[],
      outbound: (outbound.data ?? []) as ChallengeRow[],
    });
  } catch (err) {
    res.status(502).json({
      error: "supabase_read_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
