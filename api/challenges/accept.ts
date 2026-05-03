// POST /api/challenges/accept — Phase 6 (Addendum A5, 2026-05-03).
//
// Receiver opens a pending challenge to play it. Marks the challenge
// as 'accepted' (transitional state — completion lands via /complete
// after the actual battle finishes). Returns the deck_code so the
// receiver can launch the battle screen.
//
// Body: { challenge_id: uuid, receiver: string }
//
// Returns: {
//   ok: true,
//   challenge: ChallengeRow,
//   deck_code: string         // sender's deck for the receiver to fight
// }
//
// Errors:
//   404: no such challenge OR receiver doesn't match
//   409: challenge already accepted/completed/declined/expired
//
// Note: the 'accepted' state is mostly informational — the receiver
// could in theory tap accept, never complete, and the challenge would
// sit at 'accepted' until expiry (7 days from creation). This is fine
// for v1; the sender sees "accepted but not finished" in their list
// and can interpret it as "they're playing it" or "they got distracted."

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  type ChallengeRow,
} from "../../lib/supabase.js";
import { checkRateLimit, clientIp } from "../../lib/ratelimit.js";

interface AcceptBody {
  challenge_id?: unknown;
  receiver?: unknown;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  const body = (req.body ?? {}) as AcceptBody;
  if (typeof body.challenge_id !== "string" || !UUID_RX.test(body.challenge_id)) {
    res.status(400).json({ error: "invalid_challenge_id" });
    return;
  }
  if (!isValidHandle(body.receiver)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }
  const challengeId = body.challenge_id;
  const receiver = body.receiver as string;

  try {
    const { data: row, error: readErr } = await supabase
      .from("challenges")
      .select("*")
      .eq("id", challengeId)
      .maybeSingle();
    if (readErr) {
      res.status(502).json({ error: "supabase_read_failed", detail: readErr.message });
      return;
    }
    if (!row) {
      res.status(404).json({ error: "challenge_not_found" });
      return;
    }
    const challenge = row as ChallengeRow;
    if (challenge.receiver_handle !== receiver) {
      res.status(403).json({ error: "not_your_challenge" });
      return;
    }
    if (challenge.status !== "pending") {
      res.status(409).json({ error: "wrong_state", state: challenge.status });
      return;
    }
    // Reject if expired (defense — schema TTL is enforced lazily on
    // /list calls; we double-check here in case expiry crossed since
    // the receiver opened the screen).
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      // Mark expired in-place + return 410.
      await supabase.from("challenges").update({ status: "expired" }).eq("id", challengeId);
      res.status(410).json({ error: "challenge_expired" });
      return;
    }

    const { data: updated, error: updateErr } = await supabase
      .from("challenges")
      .update({ status: "accepted" })
      .eq("id", challengeId)
      .select()
      .single();
    if (updateErr) {
      res.status(502).json({ error: "supabase_write_failed", detail: updateErr.message });
      return;
    }

    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      ok: true,
      challenge: updated as ChallengeRow,
      deck_code: challenge.deck_code,
    });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
