// Stand-in for https://deno.land/std@0.190.0/http/server.ts in the edge handler tests (import_map.json):
// std's serve() is forwarded to Deno.serve, which the harness captures, so functions written against std
// (self-update-phone) load as handlers like the rest. Only the handler argument is used.
export function serve(handler: (req: Request) => Response | Promise<Response>, _opts?: unknown) {
  return Deno.serve(handler);
}
