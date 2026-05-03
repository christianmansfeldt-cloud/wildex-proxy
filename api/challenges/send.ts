// POST /api/challenges/send — Phase 6 (Addendum A5, 2026-05-03).
//
// Send a deck challenge to a friend. The receiver fights a deterministic
// battle against the sender's deck (Champion-style) on their device,
// posts the score back via /complete, and the sender sees the result.
//
// Body: {
//   sender:   string,           // sender's claimed handle
//   receiver: string,           // receiver's claimed handle
//   deck_code: string           // WX1-... — sender's current deck
// }
//
// Returns: { ok: true, challenge_id: uuid, expires_at: string }
//
// Spam guards (locked decision #4):
//   · sender != receiver (no self-challenge)
//   · max 1 PENDING challenge from the same sender to the same
//     receiver (the prior one must be accepted/completed/declined/
//     expired before another can be sent)
//   · max 5 PENDING outbound challenges per sender at once
//   · receiver must exist + sender must have claimed handle
//
// 7-day TTL applied automatically by the schema's default expires_at.
//
// Phase 6 v1: no friendship requirement. Anyone can challenge any
// claimed handle. (Future: gate on the friends table to prevent
// "challenge spam from strangers" — the spam guards above plus
// receiver's ability to decline cover the worst case for now.)

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  isValidDeckCode,
} from "../../lib/supabase.js";
import { checkRateLimit, clientIp } from "../../lib/ratelimit.js";

interface SendBody {
  sender?: unknown;
  receiver?: unknown;
  deck_code?: unknown;
}

const MAX_PENDING_OUTBOUND_PER_SENDER = 5;

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

  const body = (req.body ?? {}) as SendBody;
  if (!isValidHandle(body.sender) || !isValidHandle(body.receiver)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }
  if (!isValidDeckCode(body.deck_code)) {
    res.status(400).json({ error: "invalid_deck_code" });
    return;
  }
  const sender = body.sender as string;
  const receiver = body.receiver as string;
  const deckCode = body.deck_code as string;
  if (sender === receiver) {
    res.status(400).json({ error: "cannot_challenge_self" });
    return;
  }

  try {
    // Verify both handles exist
    const { data: profiles, error: lookupErr } = await supabase
      .from("profiles")
      .select("handle")
      .in("handle", [sender, receiver]);
    if (lookupErr) {
      res.status(502).json({ error: "supabase_read_failed", detail: lookupErr.message });
      return;
    }
    const found = new Set((profiles ?? []).map((p: { handle: string }) => p.handle));
    if (!found.has(sender)) {
      res.status(409).json({ error: "claim_handle_first", missing: sender });
      return;
    }
    if (!found.has(receiver)) {
      res.status(404).json({ error: "receiver_not_found", missing: receiver });
      return;
    }

    // Spam guard 1: existing pending challenge to the same receiver
    const { count: dupCount, error: dupErr } = await supabase
      .from("challenges")
      .select("id", { count: "exact", head: true })
      .eq("sender_handle", sender)
      .eq("receiver_handle", receiver)
      .eq("status", "pending");
    if (dupErr) {
      res.status(502).json({ error: "supabase_read_failed", detail: dupErr.message });
      return;
    }
    if ((dupCount ?? 0) > 0) {
      res.status(409).json({ error: "duplicate_pending_challenge" });
      return;
    }

    // Spam guard 2: total outbound pending cap
    const { count: outboundCount, error: capErr } = await supabase
      .from("challenges")
      .select("id", { count: "exact", head: true })
      .eq("sender_handle", sender)
      .eq("status", "pending");
    if (capErr) {
      res.status(502).json({ error: "supabase_read_failed", detail: capErr.message });
      return;
    }
    if ((outboundCount ?? 0) >= MAX_PENDING_OUTBOUND_PER_SENDER) {
      res.status(429).json({
        error: "too_many_pending_challenges",
        max: MAX_PENDING_OUTBOUND_PER_SENDER,
      });
      return;
    }

    // Insert the challenge — expires_at defaults to now + 7 days per the schema
    const { data, error: insertErr } = await supabase
      .from("challenges")
      .insert({
        sender_handle: sender,
        receiver_handle: receiver,
        deck_code: deckCode,
      })
      .select("id, expires_at")
      .single();
    if (insertErr) {
      res.status(502).json({ error: "supabase_write_failed", detail: insertErr.message });
      return;
    }

    res.setHeader("cache-control", "no-store");
    res.status(200).json({
      ok: true,
      challenge_id: data?.id,
      expires_at: data?.expires_at,
    });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
