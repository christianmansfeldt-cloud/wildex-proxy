import Anthropic from "@anthropic-ai/sdk";
import { CURATED_SPECIES, CURATED_SPECIES_BLOCK } from "../lib/species.js";
import { checkBudget, checkRateLimit, clientIp } from "../lib/ratelimit.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 400;
const ESTIMATED_COST_PER_CALL_USD = 0.06;

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
  "iucnGuess": "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD"
}

Rules:
- matchedId MUST be one of the catalogue ids OR null. Never invent ids.
- confidence is 0.0 to 1.0. Below 0.4 means "really not sure".
- If no animal is visible at all, return commonName="No animal detected", confidence=0.0, iucnGuess="DD".
- If the subject is a stuffed toy or illustration of an animal, identify the depicted species and set confidence accordingly (treat plushies as their real species but cap confidence around 0.6).
- iucnGuess is your best estimate; we will not use it for legal claims.

Respond with JSON only. No markdown fences. No commentary.`;

interface IdentifyResult {
  matchedId: string | null;
  commonName: string;
  latinName: string;
  confidence: number;
  iucnGuess: "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD";
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
  return { matchedId, commonName, latinName, confidence, iucnGuess };
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const ip = clientIp(req);
  const rl = await checkRateLimit(ip);
  if (!rl.ok) {
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  const budget = await checkBudget(ESTIMATED_COST_PER_CALL_USD);
  if (!budget.ok) {
    return Response.json({ error: "budget_exceeded", spent: budget.spent }, { status: 503 });
  }

  let body: { imageBase64?: string; mediaType?: string };
  try {
    body = (await req.json()) as { imageBase64?: string; mediaType?: string };
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const imageBase64 = body.imageBase64;
  if (typeof imageBase64 !== "string" || imageBase64.length < 100) {
    return Response.json({ error: "missing_image" }, { status: 400 });
  }
  if (imageBase64.length > 2_500_000) {
    return Response.json({ error: "image_too_large" }, { status: 413 });
  }
  const mediaType = body.mediaType ?? "image/jpeg";
  if (!/^image\/(jpeg|png|webp|gif)$/.test(mediaType)) {
    return Response.json({ error: "unsupported_media_type" }, { status: 415 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const client = new Anthropic({ apiKey });

  try {
    const message = await client.messages.create({
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
    });

    const textBlock = message.content.find((c) => c.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return Response.json({ error: "no_text_response" }, { status: 502 });
    }

    const result = parseModelResponse(textBlock.text);
    return Response.json(result, {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "x-wildex-budget-spent": String(budget.spent.toFixed(2)),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    return Response.json({ error: "claude_failed", detail: msg }, { status: 502 });
  }
}
