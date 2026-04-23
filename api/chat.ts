import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { checkBudget, checkRateLimit, clientIp } from "../lib/ratelimit.js";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 600;
const ESTIMATED_COST_PER_CALL_USD = 0.04;

const SYSTEM_PROMPT_TEMPLATE = (commonName: string, latinName: string, iucnStatus: string, lore: string) =>
  `You are speaking as the wild Wilder "${commonName}" (${latinName}, IUCN: ${iucnStatus}).

Backstory you can draw from:
${lore}

Voice:
- First person, warm but not cute. You are a real animal, not a cartoon.
- Mix natural-history facts with conservation reality.
- Keep replies short: 1-3 sentences, occasional 4. No essays.
- If asked about your habitat or threats, be honest about danger and what helps.
- If asked something off-topic (e.g. coding, math), gently steer back: "I am a ${commonName}, not your assistant."
- Never invent species facts you are unsure of. If unsure, say so.
- Never break character.`;

interface ChatRequest {
  wilder?: { commonName?: string; latinName?: string; iucnStatus?: string; lore?: string };
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
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

  const body = (req.body ?? {}) as ChatRequest;
  const w = body.wilder ?? {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (
    !w.commonName ||
    !w.latinName ||
    !w.iucnStatus ||
    !w.lore ||
    messages.length === 0 ||
    messages.length > 12
  ) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "server_misconfigured" });
    return;
  }

  const client = new Anthropic({ apiKey });
  const system = SYSTEM_PROMPT_TEMPLATE(w.commonName, w.latinName, w.iucnStatus, w.lore);

  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const data = JSON.stringify({ type: "delta", text: event.delta.text });
        res.write(`data: ${data}\n\n`);
      } else if (event.type === "message_stop") {
        res.write(`data: {"type":"done"}\n\n`);
      }
    }
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "stream_error";
    const data = JSON.stringify({ type: "error", error: msg });
    res.write(`data: ${data}\n\n`);
    res.end();
  }
}
