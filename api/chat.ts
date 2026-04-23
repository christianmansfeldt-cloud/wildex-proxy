import Anthropic from "@anthropic-ai/sdk";
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

  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

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
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }

  const client = new Anthropic({ apiKey });
  const system = SYSTEM_PROMPT_TEMPLATE(w.commonName, w.latinName, w.iucnStatus, w.lore);

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const encoder = new TextEncoder();
    const sse = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              const data = JSON.stringify({ type: "delta", text: event.delta.text });
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } else if (event.type === "message_stop") {
              controller.enqueue(encoder.encode(`data: {"type":"done"}\n\n`));
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "stream_error";
          const data = JSON.stringify({ type: "error", error: msg });
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(sse, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    return Response.json({ error: "claude_failed", detail: msg }, { status: 502 });
  }
}
