import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-wildex-warmup", "ok");
  res.status(200).end();
}
