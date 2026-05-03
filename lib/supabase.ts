// Wildex Phase 6 — Supabase admin client.
//
// Single lazy-init wrapper around `@supabase/supabase-js` using the
// SERVICE_ROLE key. The proxy is the only caller — clients NEVER talk
// to Supabase directly. RLS is enabled on every table but the
// service_role key bypasses it, so we have full read/write access
// from inside endpoint handlers without per-request auth.
//
// Why service_role + no per-user auth: this proxy is the ONLY trusted
// boundary. Adding Supabase Auth (email/OAuth) would force the player
// onto a sign-in flow we explicitly cut from MVP. The handle-as-identity
// model claims a row in `profiles` on first interaction; ownership is
// established by the proxy's enforcement of one-handle-per-write.
//
// 2026-05-03: also exports a typed `Database` shape that mirrors the
// migration SQL. Hand-written (not generated) so we don't need the
// Supabase CLI in CI; keep it in sync if the schema changes.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface ProfileRow {
  handle: string;
  created_at: string;
  last_seen_at: string;
  lifetime_captures: number;
  lifetime_wins: number;
  lifetime_sqm: number;
  lifetime_trophies: number;
  weekly_wins: number;
  mastered_species: number;
  current_streak: number;
}

export interface FriendRow {
  handle_a: string;
  handle_b: string;
  created_at: string;
}

export type ChallengeStatus =
  | "pending"
  | "accepted"
  | "completed"
  | "declined"
  | "expired";

export interface ChallengeRow {
  id: string;
  sender_handle: string;
  receiver_handle: string;
  deck_code: string;
  status: ChallengeStatus;
  receiver_score: number | null;
  receiver_won: boolean | null;
  receiver_turns: number | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
}

// 2026-05-03: supabase-js v2's Database<...> type system is overly
// strict for hand-written schemas (requires Row/Insert/Update for every
// table + matches supabase CLI codegen output). For the proxy's
// purposes we use the untyped client + assert row shapes at the call
// site via the ProfileRow/FriendRow/ChallengeRow interfaces above. If
// we ever pull in `supabase gen types` we can re-introduce the typed
// client.

let _client: SupabaseClient | null = null;

/** Lazy-init the admin client. Returns null if env vars aren't set
 *  (caller should 500 in that case — Supabase is required for Phase 6). */
export function getSupabase(): SupabaseClient | null {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient(url, key, {
    auth: {
      // No per-request auth — service_role bypasses RLS.
      // Disable token refresh (no user session) + persist (no client storage).
      persistSession: false,
      autoRefreshToken: false,
    },
    db: {
      schema: "public",
    },
  });
  return _client;
}

// ──────────────────────────────────────────────────────────────────────
// Handle validation — shared by every endpoint that takes a handle.
// Mirrors the regex in state/friends.ts + state/player.ts so the client
// can pre-validate before calling the proxy.
// ──────────────────────────────────────────────────────────────────────

const HANDLE_RX = /^[a-z0-9_-]{3,16}$/;

export function isValidHandle(raw: unknown): raw is string {
  return typeof raw === "string" && HANDLE_RX.test(raw);
}

/** Canonical ordering for the `friends` composite key. The schema
 *  enforces `check (handle_a < handle_b)` so callers must order before
 *  insert/select. Returns [smaller, larger] lexicographically. */
export function orderFriendPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// ──────────────────────────────────────────────────────────────────────
// Deck code validation — light regex check matching the v1+v2 codec.
// ──────────────────────────────────────────────────────────────────────

const DECK_CODE_RX = /^WX1-[A-Za-z0-9_-]+$/;

export function isValidDeckCode(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length < 6 || raw.length > 200) return false;
  return DECK_CODE_RX.test(raw);
}

// ──────────────────────────────────────────────────────────────────────
// Profanity filter — basic regex denylist for handle claims (#8 lock).
// Stops the worst slurs + scatology at claim time. Imperfect, but a
// reasonable v1 floor; full moderation can come later.
// ──────────────────────────────────────────────────────────────────────

// Word fragments that match common slurs/scatology. Underscore + dash
// equivalents covered via the optional `[_-]?` separator. Conservative
// list — false positives are recoverable (the player picks another
// handle) while false negatives are harder to walk back at demo time.
const PROFANITY_FRAGMENTS = [
  "fuck", "shit", "cunt", "nigg", "fag", "kike", "spic", "chink",
  "tranny", "retard", "rape", "nazi", "kkk", "porn", "pussy", "dick",
  "cock", "twat", "wank", "bitch", "bastard", "whore", "slut",
];

export function isHandleProfane(raw: string): boolean {
  const lowered = raw.toLowerCase().replace(/[_-]/g, "");
  return PROFANITY_FRAGMENTS.some((f) => lowered.includes(f));
}
