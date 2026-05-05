// /api/challenges — Phase 6 (Addendum A5, 2026-05-03), consolidated
// 2026-05-05.
//
// 2026-05-05 (Vercel Hobby plan limit): merged the prior 4 endpoints
// (api/challenges/{send,accept,complete,list}.ts) into this single
// dispatcher. Same behavior, same wire shapes; routed by method +
// body.action. Saves 3 of the 5 endpoints needed to fit under the
// 12-Function Hobby cap.
//
// Routing:
//   GET  /api/challenges?handle=mine&direction=inbound|outbound|all
//        → list (lazy expiry sweep + sorted by created_at desc)
//   POST /api/challenges  body { action: "send"|"accept"|"complete", ... }
//
// All sub-handlers are isomorphic to the original files. The client
// (services/friendsApi.ts) is updated in the paired commit to call
// the new shapes.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  isValidDeckCode,
  type ChallengeRow,
} from "../lib/supabase.js";
import { checkRateLimit, clientIp } from "../lib/ratelimit.js";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PENDING_OUTBOUND_PER_SENDER = 5;

// ── Top-level dispatcher ───────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "GET") return handleList(req, res);
  if (req.method === "POST") {
    const action = (req.body as { action?: unknown } | undefined)?.action;
    if (action === "send") return handleSend(req, res);
    if (action === "accept") return handleAccept(req, res);
    if (action === "complete") return handleComplete(req, res);
    res.status(400).json({
      error: "unknown_action",
      allowed: ["send", "accept", "complete"],
    });
    return;
  }
  res.setHeader("allow", "GET, POST");
  res.status(405).json({ error: "method_not_allowed" });
}

// ── send ───────────────────────────────────────────────────────────

interface SendBody {
  action?: unknown;
  sender?: unknown;
  receiver?: unknown;
  deck_code?: unknown;
}

async function handleSend(req: VercelRequest, res: VercelResponse): Promise<void> {
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

// ── accept ─────────────────────────────────────────────────────────

interface AcceptBody {
  action?: unknown;
  challenge_id?: unknown;
  receiver?: unknown;
}

async function handleAccept(req: VercelRequest, res: VercelResponse): Promise<void> {
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
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
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

// ── complete ───────────────────────────────────────────────────────

interface CompleteBody {
  action?: unknown;
  challenge_id?: unknown;
  receiver?: unknown;
  outcome?: unknown;
  score?: unknown;
  won?: unknown;
  turns?: unknown;
}

function sanitizeInt(raw: unknown, max: number): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const n = Math.floor(raw);
  if (n < 0) return null;
  return Math.min(n, max);
}

async function handleComplete(req: VercelRequest, res: VercelResponse): Promise<void> {
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

// ── list ───────────────────────────────────────────────────────────

async function handleList(req: VercelRequest, res: VercelResponse): Promise<void> {
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
    try {
      await supabase.rpc("expire_old_challenges");
    } catch {
      // Swallow — sweep retries next /list call.
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
