import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CURATED_SPECIES, CURATED_SPECIES_BLOCK } from "../lib/species.js";
import { checkBudget, checkRateLimit, clientIp } from "../lib/ratelimit.js";

const MODEL = "claude-opus-4-7";
// 2026-04-26 H3: bumped 400 → 900 to fit the optional `generated` block
// (lore 40-80 words + conservation 2-3 sentences + stat fields). For
// curated matches the response stays small; only un-curated species
// emit the longer generated block.
const MAX_TOKENS = 900;
// Slight bump from 0.06 because the generated branch can roughly double
// the output token count. Daily budget cap (env: MAX_DAILY_USD) still
// fail-closes if a player rapidly photographs many new species.
const ESTIMATED_COST_PER_CALL_USD = 0.09;

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

CURATED CATALOGUE (33 species — for matchedId only):
${CURATED_SPECIES_BLOCK}

RESPONSE SHAPE — single JSON object, no markdown, no commentary:
{
  "matchedId": string | null,   // a catalogue id, OR null if no match
  "commonName": string,         // what you actually see, always
  "latinName": string,          // what you actually see, always
  "confidence": number,         // 0.0 to 1.0
  "iucnGuess": "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD",
  "isEgg": boolean,
  "generated": null | { /* see GENERATED BLOCK below */ }
}

GENERATED BLOCK (only when matchedId is null AND confidence >= 0.4 AND isEgg is false):
When the species you identified is NOT in the curated catalogue, ALSO
populate "generated" with complete game-ready stats. Use the species'
real-world traits to drive the numbers. When the conditions above are
not met, set "generated": null.

{
  "type": "land" | "air" | "water" | "forest" | "mythic",
    // mythic is RESERVED for iucnGuess CR or EN species ONLY.
    // Otherwise: terrestrial mammals=land, birds+flying insects+bats=air,
    // fish+amphibians+aquatic mammals=water, forest specialists+small
    // woodland creatures+ground inverts=forest.
  "habitat": string,             // human-readable, ~3-5 words ("urban", "savanna", "alpine forest")
  "cost": 1 | 2 | 3 | 4 | 5,     // Energy cost — derive from real body mass:
                                 //   < 1 kg → 1, 1-10 kg → 2, 10-100 kg → 3,
                                 //   100-500 kg → 4, > 500 kg → 5.
                                 //   ALSO: any CR or EN species → cost 4 or 5 (legendary tier).
  "hp": number,                  // Pick within the cost-curve bracket:
  "attack": number,              //   1c: HP 18-30 / atk 10-15
                                 //   2c: HP 35-45 / atk 18-22
                                 //   3c: HP 50-60 / atk 25-30
                                 //   4c: HP 75-85 / atk 35-40
                                 //   5c: HP 90-110 / atk 40-50
  "rarity": "common" | "uncommon" | "rare" | "legendary",
                                 //   CR/EN → legendary, VU → rare, NT → uncommon,
                                 //   LC → common (cost 1-2) or uncommon (cost 3+)
  "lore": string,                // 40-80 words FIRST PERSON from the species' POV,
                                 //   warm naturalist tone, end on something memorable.
  "conservationNote": string,    // 2-3 sentences with at least one named conservation
                                 //   organization or program (real ones — IUCN, WWF,
                                 //   regional trusts, etc.).
  "location": string,            // ~3-7 words human-readable range
                                 //   ("Sub-Saharan Africa, savanna + grassland")
  "metricsBase": { "heightCm": number, "weightG": number },
                                 //   Real adult body height in cm, weight in grams.
                                 //   Use canonical adult averages.
  "signatureAbility": "frostbite" | "horn_charge" | "silent_hunt" | "burrow" | "tail_whip" | null
                                 //   ONLY for legendary tier (cost 4 or 5). Pick by behavior:
                                 //   cold-climate predator=frostbite, horned/tusked=horn_charge,
                                 //   ambush predator=silent_hunt, burrowing/hiding=burrow,
                                 //   aquatic mammal=tail_whip. Default frostbite if none fit.
                                 //   For non-legendary tiers ALWAYS set null.
}

EXAMPLES:
- Photo of a Pomeranian: matchedId="dog", commonName="Pomeranian", latinName="Canis familiaris", confidence=0.95, iucnGuess="LC", isEgg=false, generated=null. (Curated match → no generated block needed.)
- Photo of a hamster: matchedId=null, commonName="Syrian Hamster", latinName="Mesocricetus auratus", confidence=0.9, iucnGuess="EN", isEgg=false, generated={type:"land", habitat:"arid grassland + burrow", cost:1, hp:24, attack:13, rarity:"legendary", lore:"...", conservationNote:"...", location:"Aleppo region, Syria — semi-arid steppe", metricsBase:{heightCm:11, weightG:120}, signatureAbility:"burrow"}. (Hamster not in catalogue — generate complete block. Note signatureAbility="burrow" because hamsters are burrowers and rarity=legendary because EN.)
- Photo of a Bengal tiger: matchedId=null, commonName="Bengal Tiger", latinName="Panthera tigris tigris", confidence=0.95, iucnGuess="EN", isEgg=false, generated={type:"mythic", habitat:"tropical forest + grassland", cost:5, hp:100, attack:48, rarity:"legendary", lore:"...", conservationNote:"...", location:"Indian subcontinent, mangrove + dry forest", metricsBase:{heightCm:90, weightG:220000}, signatureAbility:"silent_hunt"}.
- Photo of a slightly blurry small bird: matchedId=null, commonName="songbird (uncertain)", latinName="", confidence=0.3, iucnGuess="LC", isEgg=false, generated=null. (Confidence < 0.4 → no generated block; client will fall back.)
- Photo of a stuffed snow leopard plush: matchedId="snowleopard", commonName="Snow Leopard", latinName="Panthera uncia", confidence=0.6, iucnGuess="VU", isEgg=false, generated=null.
- Photo of nothing recognizable: matchedId=null, commonName="No animal detected", latinName="", confidence=0.0, iucnGuess="DD", isEgg=false, generated=null.

isEgg DETECTION (SECONDARY — never overrides species ID):
- isEgg=true ONLY when the photo's primary subject is unmistakably an egg AND no live animal is visible. Examples: chicken egg in a carton, decorated egg on a table, painted Easter egg, bird's egg in a bowl.
- If any animal is visible — even partially, even out of focus, even in the background — isEgg=false and identify the animal normally. A bird sitting on its egg → isEgg=false, identify the bird.
- If unsure, isEgg=false. False negatives are fine (user sees a regular reveal). False positives hurt (user catches a "Speckled Egg" instead of their pet).
- All other fields are set per the rules above regardless of isEgg.

Respond with JSON only. No markdown fences. No commentary.`;

interface GeneratedBlock {
  type: "land" | "air" | "water" | "forest" | "mythic";
  habitat: string;
  cost: 1 | 2 | 3 | 4 | 5;
  hp: number;
  attack: number;
  rarity: "common" | "uncommon" | "rare" | "legendary";
  lore: string;
  conservationNote: string;
  location: string;
  metricsBase: { heightCm: number; weightG: number };
  signatureAbility: "frostbite" | "horn_charge" | "silent_hunt" | "burrow" | "tail_whip" | null;
}

interface IdentifyResult {
  matchedId: string | null;
  commonName: string;
  latinName: string;
  confidence: number;
  iucnGuess: "LC" | "NT" | "VU" | "EN" | "CR" | "EW" | "EX" | "DD";
  /** F1 (2026-04-25): true if the photo's subject is an egg. Drives the
   *  Easter-egg incubation flow on the client. Defaults to false. */
  isEgg: boolean;
  /** H3 (2026-04-26): for un-curated species (matchedId=null) Opus
   *  generates complete game-ready stats. null when the species
   *  matched the curated list, when confidence is too low, or when
   *  the photo was an egg. Client validates + clamps stats to the
   *  cost-curve before rendering. */
  generated: GeneratedBlock | null;
}

function isCuratedId(id: unknown): id is string {
  return typeof id === "string" && CURATED_SPECIES.some((s) => s.id === id);
}

// 2026-04-26 H3: server-side validation of the generated block. Any
// shape mismatch returns null so the client falls back to the existing
// UNKNOWN_WILDER_TEMPLATE path instead of crashing on bad data. Stat
// clamping happens client-side (services/claude.ts) for defense in depth
// — we don't want to discard a near-valid block over a 1-point overshoot.
function parseGenerated(raw: unknown): GeneratedBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const type = g.type;
  if (
    typeof type !== "string" ||
    !["land", "air", "water", "forest", "mythic"].includes(type)
  ) return null;
  if (typeof g.habitat !== "string" || g.habitat.length === 0) return null;
  if (typeof g.cost !== "number" || ![1, 2, 3, 4, 5].includes(g.cost)) return null;
  if (typeof g.hp !== "number" || g.hp <= 0 || g.hp > 250) return null;
  if (typeof g.attack !== "number" || g.attack <= 0 || g.attack > 100) return null;
  if (
    typeof g.rarity !== "string" ||
    !["common", "uncommon", "rare", "legendary"].includes(g.rarity)
  ) return null;
  if (typeof g.lore !== "string" || g.lore.length < 20) return null;
  if (typeof g.conservationNote !== "string" || g.conservationNote.length < 20) return null;
  if (typeof g.location !== "string" || g.location.length === 0) return null;
  const m = g.metricsBase as { heightCm?: unknown; weightG?: unknown } | undefined;
  if (
    !m ||
    typeof m.heightCm !== "number" || m.heightCm <= 0 ||
    typeof m.weightG !== "number" || m.weightG <= 0
  ) return null;
  let signatureAbility: GeneratedBlock["signatureAbility"] = null;
  if (
    typeof g.signatureAbility === "string" &&
    ["frostbite", "horn_charge", "silent_hunt", "burrow", "tail_whip"].includes(g.signatureAbility)
  ) {
    signatureAbility = g.signatureAbility as GeneratedBlock["signatureAbility"];
  }
  return {
    type: type as GeneratedBlock["type"],
    habitat: g.habitat,
    cost: g.cost as GeneratedBlock["cost"],
    hp: g.hp,
    attack: g.attack,
    rarity: g.rarity as GeneratedBlock["rarity"],
    lore: g.lore,
    conservationNote: g.conservationNote,
    location: g.location,
    metricsBase: { heightCm: m.heightCm, weightG: m.weightG },
    signatureAbility,
  };
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
  // Only accept a generated block when the species was un-curated AND
  // confidence is high enough AND it wasn't an egg. Any of those false
  // → drop the block. Defense against Opus over-generating.
  const generated =
    matchedId === null && confidence >= 0.4 && !isEgg
      ? parseGenerated(parsed.generated)
      : null;
  return { matchedId, commonName, latinName, confidence, iucnGuess, isEgg, generated };
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
