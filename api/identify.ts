import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CURATED_SPECIES, CURATED_SPECIES_BLOCK } from "../lib/species.js";
import { checkBudget, checkRateLimit, clientIp } from "../lib/ratelimit.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 400;
const ESTIMATED_COST_PER_CALL_USD = 0.06;

/** Socket timeout for the Anthropic call. ENG REVIEW APPENDIX II §F6
 *  (2026-04-24): Vercel function maxDuration is 30s; we abort at 25s
 *  to leave 5s of buffer for response serialization + network. Without
 *  this, a stuck Anthropic call rides Vercel's hard cap and returns a
 *  502 with no recognizable error code. With this, the catch block
 *  emits `claude_timeout` so the client can surface a clean error. */
const ANTHROPIC_TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT = `You are Wildex, a naturalist identifier for a mobile card-trading game.

Your job: look at the user's photo and identify the most likely animal subject.

You receive a fixed catalogue of curated species. If the photo matches one of them, return its exact id. Otherwise, return matchedId=null and provide your best guess of the species (still useful for fallback card generation).

Curated catalogue (id, common name, latin name):
${CURATED_SPECIES_BLOCK}

ALWAYS respond as a single JSON object with EXACTLY this shape and no surrounding prose:
{
  "matchedId": string | null,
  "commonName": string,
  "latinName": string,
  "confidence": number,
  "iucnGuess": "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD",
  "isEgg": boolean
}

Rules:
- matchedId MUST be one of the catalogue ids OR null. Never invent ids.
- confidence is 0.0 to 1.0. Below 0.4 means "really not sure".
- If no animal is visible at all, return commonName="No animal detected", confidence=0.0, iucnGuess="DD", isEgg=false.
- If the subject is a stuffed toy or illustration of an animal, identify the depicted species and set confidence accordingly (treat plushies as their real species but cap confidence around 0.6).
- iucnGuess is your best estimate; we will not use it for legal claims.
- isEgg: set TRUE when the photo's primary subject is an egg (chicken egg in a carton, decorated egg, bird's nest with visible eggs, painted/Easter egg, etc.). The egg path takes priority over species ID — even if a parent bird is visible nearby with the egg, set isEgg=true. The user's app starts a 3-7 day incubation timer when isEgg is true. When isEgg=true, set commonName="Speckled Egg", latinName="Ovum incognitum", confidence=0.85, iucnGuess="LC". Otherwise FALSE.

Respond with JSON only. No markdown fences. No commentary.`;

interface IdentifyResult {
  matchedId: string | null;
  commonName: string;
  latinName: string;
  confidence: number;
  iucnGuess: "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD";
  /** F1 (2026-04-25): true if the photo's subject is an egg. Drives the
   *  Easter-egg incubation flow on the client. Defaults to false. */
  isEgg: boolean;
}

function isCuratedId(id: unknown): id is string {
  return typeof id === "string" && CURATED_SPECIES.some((s) => s.id === id);
}

function parseModelResponse(text: string): IdentifyResult {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const parsed = JSON.parse(cleaned) as Record<string, unknown>;
  const matchedId = isCuratedId(parsed.matchedId) ? parsed.matchedId : null;
  const commonName = typeof parsed.commonName === "string" ? parsed.commonName : "Unknown";
  const latinName = typeof parsed.latinName === "string" ? parsed.latinName : "";
  const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0;
  const iucnGuess =
    typeof parsed.iucnGuess === "string" && /^(LC|NT|VU|EN|CR|EW|EX|DD)$/.test(parsed.iucnGuess)
      ? (parsed.iucnGuess as IdentifyResult["iucnGuess"])
      : "DD";
  const isEgg = typeof parsed.isEgg === "boolean" ? parsed.isEgg : false;
  return { matchedId, commonName, latinName, confidence, iucnGuess, isEgg };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method_not_allowed" });
    return;
  }

  const ip = clientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const budget = await checkBudget(ESTIMATED_COST_PER_CALL_USD);
  if (!budget.ok) {
    res.status(503).json({ error: "budget_exceeded", spent: budget.spent });
    return;
  }

  const body = (req.body ?? {}) as { imageBase64?: string; mediaType?: string };
  const imageBase64 = body.imageBase64;
  if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
    res.status(400).json({ error: "missing_image" });
    return;
  }
  if (imageBase64.length > 2_500_000) {
    res.status(413).json({ error: "image_too_large" });
    return;
  }
  const mediaType = body.mediaType ?? "image/jpeg";
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
    res.status(415).json({ error: "unsupported_media_type" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "server_misconfigured" });
    return;
  }

  const client = new Anthropic({ apiKey });

  // Server-side socket timeout. The Anthropic SDK accepts an AbortSignal
  // via its second-arg options bag. We wire one here so a stuck upstream
  // doesn't ride Vercel's 30s hard cap. Caller (services/claude.ts on
  // the RN side) ALSO has a 25s AbortController for symmetry — defense
  // in depth.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mediaType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
                  data: imageBase64,
                },
              },
              { type: "text", text: "Identify the animal in this photo. JSON only." },
            ],
          },
        ],
      },
      { signal: controller.signal }
    );

    const textBlock = message.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      res.status(502).json({ error: "no_text_response" });
      return;
    }

    const result = parseModelResponse(textBlock.text);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-wildex-budget-spent", String(budget.spent.toFixed(2)));
    res.status(200).json(result);
  } catch (err) {
    // Distinguish timeout from other failures so the client can route
    // the user to a helpful message ("the wild is shy, try again") vs a
    // generic Claude failure.
    if (err instanceof Error && err.name === "AbortError") {
      res.status(504).json({ error: "claude_timeout", timeout_ms: ANTHROPIC_TIMEOUT_MS });
      return;
    }
    const msg = err instanceof Error ? err.message : "unknown_error";
    res.status(502).json({ error: "claude_failed", detail: msg });
  } finally {
    clearTimeout(timeoutHandle);
  }
}
