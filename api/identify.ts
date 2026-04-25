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

THE TASK (in order):
1. Look at the photo. Identify what species the subject actually is, using your full vision knowledge — pretend the catalogue below doesn't exist for this step. Pick the SPECIFIC species, not a category. ("Golden Retriever" not "dog", "Mallard" not "duck", "House Sparrow" not "bird".)
2. Set commonName + latinName to that species. These are ALWAYS what you actually see — they describe the subject regardless of whether the catalogue matches.
3. Set confidence = how certain you are about the species ID. 0.9+ = obvious, 0.6-0.8 = good guess, 0.4-0.6 = unsure between similar species, <0.4 = really not sure or photo is too poor to tell.
4. Check the curated catalogue below. If the species you identified IS one of these 30, set matchedId to its catalogue id. If it ISN'T (e.g., you saw a hamster or a parakeet), set matchedId=null. The catalogue is for matching, NOT for forcing — never warp your species ID just to match a catalogue entry.
5. Set iucnGuess based on your knowledge of the species (LC for common, EN/CR for endangered, etc.). Best guess; not legally binding.
6. Set isEgg per the rule at the bottom.

CURATED CATALOGUE (30 species — for matchedId only):
${CURATED_SPECIES_BLOCK}

RESPONSE SHAPE — single JSON object, no markdown, no commentary:
{
  "matchedId": string | null,   // a catalogue id, OR null if no match
  "commonName": string,         // what you actually see, always
  "latinName": string,          // what you actually see, always
  "confidence": number,         // 0.0 to 1.0
  "iucnGuess": "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD",
  "isEgg": boolean
}

EXAMPLES:
- Photo of a Pomeranian: matchedId="dog", commonName="Pomeranian", latinName="Canis familiaris", confidence=0.95, iucnGuess="LC", isEgg=false. (Subject is clearly a dog → match catalogue id "dog", but commonName names the breed honestly.)
- Photo of a hamster: matchedId=null, commonName="Syrian Hamster", latinName="Mesocricetus auratus", confidence=0.9, iucnGuess="EN", isEgg=false. (Hamster isn't in the catalogue — null matchedId, but you still identify it.)
- Photo of a slightly blurry small bird in a tree: matchedId=null, commonName="songbird (uncertain)", latinName="", confidence=0.3, iucnGuess="LC", isEgg=false. (Don't force-match to "sparrow" if you can't tell — return null with low confidence.)
- Photo of a stuffed snow leopard plush: matchedId="snowleopard", commonName="Snow Leopard", latinName="Panthera uncia", confidence=0.6, iucnGuess="VU", isEgg=false. (Plush of a real species → identify the depicted species, cap confidence ~0.6.)
- Photo of nothing recognizable: matchedId=null, commonName="No animal detected", latinName="", confidence=0.0, iucnGuess="DD", isEgg=false.

isEgg DETECTION (SECONDARY — never overrides species ID):
- isEgg=true ONLY when the photo's primary subject is unmistakably an egg AND no live animal is visible. Examples: chicken egg in a carton, decorated egg on a table, painted Easter egg, bird's egg in a bowl.
- If any animal is visible — even partially, even out of focus, even in the background — isEgg=false and identify the animal normally. A bird sitting on its egg → isEgg=false, identify the bird.
- If unsure, isEgg=false. False negatives are fine (user sees a regular reveal). False positives hurt (user catches a "Speckled Egg" instead of their pet).
- All other fields are set per the rules above regardless of isEgg.

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
