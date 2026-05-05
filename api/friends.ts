// /api/friends — Phase 6 (Addendum A5, 2026-05-03), consolidated
// 2026-05-05.
//
// 2026-05-05 (Vercel Hobby plan limit): merged the prior 3 endpoints
// (api/friends/{add,remove,list}.ts) into this single dispatcher
// because Vercel Hobby plan caps Serverless Functions at 12 per
// deployment — Phase 6 + the existing endpoints pushed us over. Same
// behavior, same wire shapes; just routed by method + body.action.
//
// Routing:
//   GET  /api/friends?handle=mine             → list (sorted by last_seen desc)
//   POST /api/friends  body { action: "add"|"remove", my_handle, friend_handle }
//
// All sub-handlers are isomorphic to the original files — no logic
// changes, just inlined into private functions in this file. The
// sender/receiver client (services/friendsApi.ts) is updated in the
// paired commit to call the new shapes.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getSupabase,
  isValidHandle,
  orderFriendPair,
  type ProfileRow,
} from "../lib/supabase.js";
import { checkRateLimit, clientIp } from "../lib/ratelimit.js";

// ── Top-level dispatcher ───────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === "GET") return handleList(req, res);
  if (req.method === "POST") {
    const action = (req.body as { action?: unknown } | undefined)?.action;
    if (action === "add") return handleAdd(req, res);
    if (action === "remove") return handleRemove(req, res);
    res.status(400).json({ error: "unknown_action", allowed: ["add", "remove"] });
    return;
  }
  res.setHeader("allow", "GET, POST");
  res.status(405).json({ error: "method_not_allowed" });
}

// ── add ────────────────────────────────────────────────────────────

interface AddBody {
  action?: unknown;
  my_handle?: unknown;
  friend_handle?: unknown;
}

async function handleAdd(req: VercelRequest, res: VercelResponse): Promise<void> {
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

// ── remove ─────────────────────────────────────────────────────────

interface RemoveBody {
  action?: unknown;
  my_handle?: unknown;
  friend_handle?: unknown;
}

async function handleRemove(req: VercelRequest, res: VercelResponse): Promise<void> {
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
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(502).json({
      error: "supabase_write_failed",
      detail: (err as Error)?.message ?? "unknown",
    });
  }
}

// ── list ───────────────────────────────────────────────────────────

interface FriendWithProfile {
  handle: string;
  created_at: string;
  profile: ProfileRow;
}

async function handleList(req: VercelRequest, res: VercelResponse): Promise<void> {
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
