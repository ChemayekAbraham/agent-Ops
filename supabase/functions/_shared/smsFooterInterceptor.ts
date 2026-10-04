// Global fetch interceptor that guarantees every outbound SMS body sent to
// Yoola, Africa's Talking or Lana carries the standard Welile support footer.
//
// Historically, many edge functions ship their OWN inline provider clients
// (they don't go through `sendSmsMultiProvider` / `yoolaPrimary`). Rather than
// patch every one of them individually and risk drift when new ones are added,
// we install a single fetch wrapper here. Any edge function that might send an
// SMS simply `import`s this module for its side effect and every downstream
// provider request is post-processed to include the footer.
//
// The wrapper is:
//   - Idempotent per process (guarded by a global flag)
//   - Idempotent per message (delegates to `appendSupportFooter`)
//   - Non-destructive on non-provider URLs (passes straight through)
//   - Robust to non-JSON bodies (silently skips on parse failure)

import { appendSupportFooter } from "./smsFooter.ts";

const FLAG = "__welile_sms_footer_installed__";

function isProviderUrl(url: string): { host: "yoola" | "at" | "lana" } | null {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith("yoolasms.com")) return { host: "yoola" };
    if (u.hostname.endsWith("africastalking.com") && u.pathname.includes("/messaging")) return { host: "at" };
    if (u.hostname.endsWith("lanasms.com")) return { host: "lana" };
  } catch { /* not a URL — leave alone */ }
  return null;
}

async function readBodyText(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body as Uint8Array);
  // Blob / ReadableStream / FormData — not used by our SMS clients. Skip.
  return null;
}

function rewriteJsonBody(raw: string): string | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && typeof obj.message === "string") {
      obj.message = appendSupportFooter(obj.message);
      return JSON.stringify(obj);
    }
  } catch { /* not JSON */ }
  return null;
}

function rewriteFormBody(raw: string): string | null {
  try {
    const params = new URLSearchParams(raw);
    const msg = params.get("message");
    if (msg == null) return null;
    params.set("message", appendSupportFooter(msg));
    return params.toString();
  } catch { /* not form-encoded */ }
  return null;
}

function installOnce() {
  const g = globalThis as any;
  if (g[FLAG]) return;
  g[FLAG] = true;

  const originalFetch = g.fetch.bind(g) as typeof fetch;
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : (input as Request).url);
      const provider = isProviderUrl(url);
      if (!provider) return originalFetch(input as any, init);

      // We only patch when we have an init.body we can read as text. If the
      // caller passed a Request object with its own body, we let it through
      // unchanged (none of the in-tree SMS clients do this).
      if (!init || init.body == null) return originalFetch(input as any, init);
      const raw = await readBodyText(init.body);
      if (raw == null) return originalFetch(input as any, init);

      const rewritten = provider.host === "at" ? rewriteFormBody(raw) : rewriteJsonBody(raw);
      if (rewritten == null || rewritten === raw) return originalFetch(input as any, init);

      return originalFetch(input as any, { ...init, body: rewritten });
    } catch {
      // Never let footer post-processing break an SMS send.
      return originalFetch(input as any, init);
    }
  }) as typeof fetch;
}

installOnce();