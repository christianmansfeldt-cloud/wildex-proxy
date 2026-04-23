export default async function handler(_req: Request): Promise<Response> {
  return new Response(null, {
    status: 200,
    headers: { "cache-control": "no-store", "x-wildex-warmup": "ok" },
  });
}
