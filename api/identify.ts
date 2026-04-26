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
4. Check the curated catalogue below. Each entry has a \`matches\` rule describing what real-world species count as that catalogue id (e.g., "dog" matches any domestic breed, "deer" matches any small/medium deer including roe/sika/fallow but NOT moose/elk, "fox" matches any true fox INCLUDING fennec but NOT coyote/wolf). If the species you identified satisfies a \`matches\` rule, set matchedId to that catalogue id. The commonName + latinName fields ALWAYS describe the actual subject regardless — a Roe Deer captured under matchedId="deer" still has commonName="Roe Deer" + latinName="Capreolus capreolus". If no \`matches\` rule applies (e.g., you saw a hamster, a moose, a coyote, a parakeet), set matchedId=null. The catalogue is for matching, NOT for forcing — never warp your species ID just to fit a rule, and respect the explicit NOT clauses.
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
  "rarity": "common" | "uncommon" | "rare" | "legendary",
                                 // SET THIS FIRST. Derive from iucnGuess:
                                 //   CR / EN → legendary
                                 //   VU      → rare
                                 //   NT      → uncommon
                                 //   LC      → common (default) — but if the species is
                                 //            legitimately uncommon to encounter (large
                                 //            apex predators, rare-color morphs, etc.) you
                                 //            MAY use uncommon.
  "cost": 1 | 2 | 3 | 4 | 5,     // SET SECOND, derived from rarity FIRST then refined by
                                 // body mass within the rarity-legal range. The chain is:
                                 //   rarity → cost range → real mass picks within range
                                 //
                                 // Rarity-legal cost ranges (HARD RULE — out-of-range is
                                 // clamped client-side and logged as a tuning issue):
                                 //   common    → cost 1-2
                                 //   uncommon  → cost 2-3
                                 //   rare      → cost 3-4
                                 //   legendary → cost 4-5
                                 //
                                 // Within the legal range, refine by real body mass:
                                 //   < 1 kg     → pick the lower of the range
                                 //   1-100 kg   → pick the middle
                                 //   > 100 kg   → pick the upper
                                 //
                                 // Examples: a CR Syrian Hamster (small, EN→legendary)
                                 // is legendary cost 4 (lowest legendary rung). A
                                 // CR Bengal Tiger (huge, CR→legendary) is legendary
                                 // cost 5. A common 200kg moose would be… common
                                 // doesn't allow cost 3+, so bump rarity to uncommon
                                 // and use cost 3.
  "hp": number,                  // Pick within the cost-curve bracket for \`cost\`:
  "attack": number,              //   1c: HP 18-30 / atk 10-15
                                 //   2c: HP 35-45 / atk 18-22
                                 //   3c: HP 50-60 / atk 25-30
                                 //   4c: HP 75-85 / atk 35-40
                                 //   5c: HP 90-110 / atk 40-50
  "lore": string,                // 40-80 words FIRST PERSON from the species' POV,
                                 //   warm naturalist tone, end on something memorable.
  "conservationNote": string,    // 2-3 sentences with at least one named conservation
                                 //   organization or program (real ones — IUCN, WWF,
                                 //   regional trusts, etc.).
  "location": string,            // GEO ONLY — countries / regions / continents
                                 //   ("Sub-Saharan Africa", "Indian subcontinent",
                                 //   "Eastern North America"). NO ecological terms
                                 //   like "savanna" or "forest" here — those go in
                                 //   the dedicated "range" field below.
  "range": string,               // ECOLOGY ONLY — comma list of habitats this
                                 //   species lives in ("Forest, plains, fresh water",
                                 //   "Coastal marine, estuaries", "Savanna, scrubland").
                                 //   Distinct from "location" so the card detail can
                                 //   render geo + ecology as separate FIELD NOTES rows.
                                 //   3-6 ecology terms, comma-separated, sentence case.
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
- Photo of a Pomeranian: matchedId="dog", commonName="Pomeranian", latinName="Canis familiaris", confidence=0.95, iucnGuess="LC", isEgg=false, generated=null. (Pomeranian satisfies the dog \`matches\` rule "any domestic dog breed" — keep the breed name on the row.)
- Photo of a Roe Deer: matchedId="deer", commonName="Roe Deer", latinName="Capreolus capreolus", confidence=0.92, iucnGuess="LC", isEgg=false, generated=null. (Roe deer satisfies "any small/medium deer" — actual species name preserved on the row regardless of catalogue match.)
- Photo of a Sea Otter: matchedId="otter", commonName="Sea Otter", latinName="Enhydra lutris", confidence=0.95, iucnGuess="EN", isEgg=false, generated=null. (Sea otter satisfies "any otter species".)
- Photo of a Fennec Fox: matchedId="fox", commonName="Fennec Fox", latinName="Vulpes zerda", confidence=0.94, iucnGuess="LC", isEgg=false, generated=null. (Fennec is a true fox in the Vulpes genus → matches.)
- Photo of a Coyote: matchedId=null, commonName="Coyote", latinName="Canis latrans", confidence=0.88, iucnGuess="LC", isEgg=false, generated={type:"land", habitat:"prairie", cost:3, hp:55, attack:28, rarity:"uncommon", lore:"...", conservationNote:"...", location:"North America", range:"Prairie, scrubland, suburban edge, desert", metricsBase:{heightCm:60, weightG:14000}, signatureAbility:null}. (Coyote is explicitly NOT in the fox \`matches\` rule — it's Canis, not Vulpes — so matchedId=null and generated block fires.)
- Photo of a Moose: matchedId=null, commonName="Moose", latinName="Alces alces", confidence=0.96, iucnGuess="LC", isEgg=false, generated={type:"land", habitat:"boreal forest", cost:3, hp:60, attack:30, rarity:"uncommon", lore:"...", conservationNote:"...", location:"Northern Hemisphere boreal zone", range:"Boreal forest, taiga, lake shore, marsh", metricsBase:{heightCm:200, weightG:500000}, signatureAbility:null}. (Moose is explicitly NOT in the deer \`matches\` rule — much larger body, different ecology.)
- Photo of a hamster: matchedId=null, commonName="Syrian Hamster", latinName="Mesocricetus auratus", confidence=0.9, iucnGuess="EN", isEgg=false, generated={type:"land", habitat:"arid grassland", cost:4, hp:78, attack:36, rarity:"legendary", lore:"...", conservationNote:"...", location:"Aleppo region, Syria", range:"Arid grassland, steppe, burrows, semi-desert", metricsBase:{heightCm:11, weightG:120}, signatureAbility:"burrow"}. (Hamster not in catalogue — generate complete block. EN → legendary; legendary requires cost 4-5; small body picks the lower of the range = cost 4 with HP/atk in the 4c bracket [HP 75-85, atk 35-40]. signatureAbility="burrow" because hamsters are burrowers. Note location is GEO ONLY; ecology lives in range.)
- Photo of a Bengal tiger: matchedId=null, commonName="Bengal Tiger", latinName="Panthera tigris tigris", confidence=0.95, iucnGuess="EN", isEgg=false, generated={type:"mythic", habitat:"tropical forest", cost:5, hp:110, attack:48, rarity:"legendary", lore:"...", conservationNote:"...", location:"Indian subcontinent (India, Bangladesh, Nepal, Bhutan)", range:"Mangrove swamp, dry forest, grassland, tropical forest", metricsBase:{heightCm:90, weightG:220000}, signatureAbility:"silent_hunt"}. (HP 110 lands at the upper of the 5c bracket [90-110] — apex predator, biggest body, biggest stat. location is GEO; ecology in range.)
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
  /** Geographic location — countries / regions / continents only. */
  location: string;
  /** 2026-04-26 v2 (post device QA): ecological range — comma list of
   *  habitats. Distinct from `location` (geo) so the card detail can
   *  render geo + ecology as separate FIELD NOTES rows.
   *  Optional in the wire shape so older cached responses don't break;
   *  client falls back to a humanized form of `habitat` when missing. */
  range?: string;
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
  // P6 (post qa-review): explicit Number.isFinite to reject NaN/Infinity
  // (typeof NaN === "number" passes the type check otherwise).
  if (typeof g.cost !== "number" || !Number.isFinite(g.cost) || ![1, 2, 3, 4, 5].includes(g.cost)) return null;
  // P6 (post qa-review): tighten hp ceiling 250 → 150. Cost-curve max is
  // 110 (5c upper); 150 leaves a 40-pt buffer for Opus drift but rejects
  // wild outliers before they reach the cache. Mirrors the client-side
  // guard in services/claude.ts.
  if (typeof g.hp !== "number" || !Number.isFinite(g.hp) || g.hp <= 0 || g.hp > 150) return null;
  if (typeof g.attack !== "number" || !Number.isFinite(g.attack) || g.attack <= 0 || g.attack > 100) return null;
  if (
    typeof g.rarity !== "string" ||
    !["common", "uncommon", "rare", "legendary"].includes(g.rarity)
  ) return null;
  if (typeof g.lore !== "string" || g.lore.length < 20) return null;
  if (typeof g.conservationNote !== "string" || g.conservationNote.length < 20) return null;
  if (typeof g.location !== "string" || g.location.length === 0) return null;
  // 2026-04-26 v2: range is optional for back-compat with pre-v2 cached
  // responses. When present, must be non-empty string. Client falls back
  // to humanized habitat when missing.
  let range: string | undefined;
  if (g.range !== undefined) {
    if (typeof g.range !== "string" || g.range.length === 0) return null;
    range = g.range;
  }
  const m = g.metricsBase as { heightCm?: unknown; weightG?: unknown } | undefined;
  if (
    !m ||
    typeof m.heightCm !== "number" || !Number.isFinite(m.heightCm) || m.heightCm <= 0 ||
    typeof m.weightG !== "number" || !Number.isFinite(m.weightG) || m.weightG <= 0
  ) return null;
  let signatureAbility: GeneratedBlock["signatureAbility"] = null;
  if (
    typeof g.signatureAbility === "string" &&
    ["frostbite", "horn_charge", "silent_hunt", "burrow", "tail_whip"].includes(g.signatureAbility)
  ) {
    signatureAbility = g.signatureAbility as GeneratedBlock["signatureAbility"];
  }
  // 2026-04-26 P1 fix (post QA): the prompt says "signatureAbility ONLY
  // for legendary tier (cost 4 or 5)". Opus drift sometimes returns one
  // on a common species. Hard-gate here so a generated common Wilder
  // can never inherit Snow Leopard's Frostbite mechanics. Mirror gate
  // also lives client-side in services/claude.ts (defense in depth).
  if (g.rarity !== "legendary" || typeof g.cost !== "number" || g.cost < 4) {
    signatureAbility = null;
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
    ...(range !== undefined ? { range } : {}),
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
