// POST /api/challenges/complete — Phase 6 (Addendum A5, 2026-05-03).
//
// Receiver finished a battle accepted from the challenge. Posts the
// final score back so the sender sees the outcome. ALSO supports
// 'declined' status: receiver opened the challenge, decided not to
// fight (e.g., wrong tier of difficulty, taking a break), and dismisses
// it cleanly.
//
// Body: {
//   challenge_id: uuid,
//   receiver: string,
//   outcome: 'completed' | 'declined',
//   // when outcome=='completed':
//   score?: number,             // tournament-style score (lower = better)
//   won?: boolean,              // did the receiver beat the sender's deck?
//   turns?: number              // turns used to finish
// }
//
// Returns: { ok: true, challenge: ChallengeRow }
//
// Errors:
//   404: no such challenge
//   403: receiver doesn't match
//   409: challenge in wrong state (must be 'pending' or 'accepted')

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  type ChallengeRow,
} from "../../lib/supabase.js";
import { checkRateLimit, clientIp } from "../../lib/ratelimit.js";

interface CompleteBody {
  challenge_id?: unknown;
  receiver?: unknown;
  outcome?: unknown;
  score?: unknown;
  won?: unknown;
  turns?: unknown;
}

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sanitizeInt(raw: unknown, max: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  if (n < 0) return null;
  return Math.min(n, max);
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

  const body = (req.body ?? {}) as CompleteBody;
  if (typeof body.challenge_id !== "string" || !UUID_RX.test(body.challenge_id)) {
    res.status(400).json({ error: "invalid_challenge_id" });
    return;
  }
  if (!isValidHandle(body.receiver)) {
    res.status(400).json({ error: "invalid_handle" });
    return;
  }
  if (body.outcome !== "completed" && body.outcome !== "declined") {
    res.status(400).json({ error: "invalid_outcome" });
    return;
  }
  const challengeId = body.challenge_id;
  const receiver = body.receiver as string;
  const outcome = body.outcome as "completed" | "declined";

  // Score fields only meaningful when outcome=='completed'
  const score = outcome === "completed" ? sanitizeInt(body.score, 99_999) : null;
  const turns = outcome === "completed" ? sanitizeInt(body.turns, 12) : null;
  const won = outcome === "completed" && body.won === true;
  if (outcome === "completed" && score === null) {
    res.status(400).json({ error: "missing_score" });
    return;
  }

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
    if (challenge.status !== "pending" && challenge.status !== "accepted") {
      res.status(409).json({ error: "wrong_state", state: challenge.status });
      return;
    }

    const update: Record<string, unknown> = {
      status: outcome,
      completed_at: new Date().toISOString(),
    };
    if (outcome === "completed") {
      update.receiver_score = score;
      update.receiver_won = won;
      update.receiver_turns = turns;
    }

    const { data: updated, error: updateErr } = await supabase
      .from("challenges")
      .update(update)
      .eq("id", challengeId)
      .select()
      .single();
    if (updateErr) {
      res.status(502).json({ error: "supabase_write_failed", detail: updateErr.message });
      return;
    }

    res.setHeader("cache-control", "no-store");
    res.status(200).json({ ok: true, challenge: updated as ChallengeRow });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}
