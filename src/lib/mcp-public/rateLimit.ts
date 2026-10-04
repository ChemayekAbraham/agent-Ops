import { createClient } from "@supabase/supabase-js";
import type { ToolHandlerResult } from "@lovable.dev/mcp-js";
import { publicToolResult } from "./response";

/**
 * Abuse protection for the PUBLIC (no-auth) MCP endpoint.
 *
 * There is no caller identity on a public endpoint, so the limiter keys on the
 * network peer. Two pieces make that work:
 *
 *  1. `Deno.serve` is wrapped once at module load so the peer address of the
 *     in-flight request is available to tool handlers (the MCP SDK's
 *     `ToolContext` intentionally exposes auth only). The wrapper is installed
 *     via `AsyncLocalStorage`, so overlapping requests never read each other's
 *     caller.
 *  2. `enforceRateLimit()` calls the `check_mcp_public_rate_limit` database
 *     routine, which counts the caller's calls in an atomic sliding window and
 *     temporarily blocks repeat offenders.
 *
 * The raw IP is never sent to or stored in the database — only a salted
 * SHA-256 hash of it. Every failure path fails OPEN: this endpoint serves
 * public information, so a limiter outage must not take the tools down.
 *
 * Import-safe: no env reads and no I/O at module top level.
 */

const PER_MINUTE = 30;
const PER_HOUR = 300;

// Static pepper so the stored hash can't be reversed by hashing an IP range.
const HASH_PEPPER = "welile-mcp-public-v1";

type RuntimeGlobals = typeof globalThis & {
  Deno?: {
    env?: { get?: (name: string) => string | undefined };
    serve?: (...args: unknown[]) => unknown;
  };
  process?: { env?: Record<string, string | undefined> };
};

function readEnv(name: string): string | undefined {
  const g = globalThis as RuntimeGlobals;
  return g.Deno?.env?.get?.(name) ?? g.process?.env?.[name];
}

/* ------------------------------------------------------------------ *
 * 1. Capture the in-flight request's peer address.
 * ------------------------------------------------------------------ */

type CallerStore = {
  run: <T>(value: string | undefined, fn: () => T) => T;
  getStore: () => string | undefined;
};

let callerStore: CallerStore | undefined;
// Fallback used only when AsyncLocalStorage is unavailable. Coarser under
// concurrency (a burst may be attributed to a neighbouring caller), which is an
// acceptable trade for a public informational endpoint.
let lastCaller: string | undefined;
let installed = false;

function firstForwardedIp(header: string | null): string | undefined {
  if (!header) return undefined;
  const first = header.split(",")[0]?.trim();
  return first || undefined;
}

function callerFromRequest(request: Request, info: unknown): string | undefined {
  // Supabase terminates TLS upstream, so the client IP arrives in a forwarded
  // header. Fall back to the raw connection peer for direct calls.
  const headers = request.headers;
  const forwarded =
    firstForwardedIp(headers.get("x-forwarded-for")) ??
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    undefined;
  if (forwarded) return forwarded;
  const remote = (info as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr;
  return remote?.hostname ?? undefined;
}

/**
 * Wrap `Deno.serve` so each request's caller is bound to the async context the
 * tool handler runs in. Runs at import time — before the emitted function entry
 * calls `Deno.serve(...)` — and is a no-op outside Deno (e.g. the build-time
 * manifest extraction) and on repeat imports.
 */
function installCallerCapture(): void {
  if (installed) return;
  installed = true;

  const g = globalThis as RuntimeGlobals;
  const deno = g.Deno;
  const originalServe = deno?.serve;
  if (!deno || typeof originalServe !== "function") return;

  deno.serve = ((...args: unknown[]) => {
    const wrapped = args.map((arg) =>
      typeof arg === "function"
        ? (request: Request, info: unknown) => {
            const caller = callerFromRequest(request, info);
            lastCaller = caller;
            const call = () => (arg as (r: Request, i: unknown) => unknown)(request, info);
            return callerStore ? callerStore.run(caller, call) : call();
          }
        : arg,
    );
    return originalServe.apply(deno, wrapped as never);
  }) as typeof originalServe;

  // AsyncLocalStorage keeps concurrent requests isolated. Best-effort: if the
  // runtime doesn't expose it, the wrapper still works via `lastCaller`.
  void (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ "node:async_hooks")) as {
        AsyncLocalStorage?: new () => CallerStore;
      };
      if (mod.AsyncLocalStorage) callerStore = new mod.AsyncLocalStorage();
    } catch {
      // Keep the fallback.
    }
  })();
}

installCallerCapture();

function currentCaller(): string | undefined {
  return callerStore?.getStore() ?? lastCaller;
}

/* ------------------------------------------------------------------ *
 * 2. Hash the caller and ask the database whether the call is allowed.
 * ------------------------------------------------------------------ */

async function hashCaller(ip: string): Promise<string | undefined> {
  try {
    const bytes = new TextEncoder().encode(`${HASH_PEPPER}:${ip}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

function publishableKey(): string | undefined {
  const direct = readEnv("SUPABASE_PUBLISHABLE_KEY") ?? readEnv("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (direct) return direct;
  const keyset = readEnv("SUPABASE_PUBLISHABLE_KEYS");
  if (keyset) {
    try {
      const parsed: unknown = JSON.parse(keyset);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const keys = parsed as Record<string, unknown>;
        const key = [keys.default, ...Object.values(keys)].find(
          (v): v is string => typeof v === "string" && v.trim().startsWith("sb_publishable_"),
        );
        if (key) return key.trim();
      }
    } catch {
      // fall through to the legacy names
    }
  }
  return readEnv("SUPABASE_ANON_KEY") ?? readEnv("VITE_SUPABASE_ANON_KEY");
}

function limiterClient() {
  const url = readEnv("SUPABASE_URL") ?? readEnv("VITE_SUPABASE_URL");
  const key = publishableKey();
  if (!url || !key) return undefined;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function waitLabel(seconds: number): string {
  if (seconds >= 90) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${Math.max(5, seconds)} seconds`;
}

/**
 * Call at the very top of every public tool handler:
 *
 *   const limited = await enforceRateLimit("how_welile_works");
 *   if (limited) return limited;
 *
 * Returns `null` when the call may proceed, or a ready-to-return tool result
 * explaining the limit when it may not.
 */
export async function enforceRateLimit(tool: string): Promise<ToolHandlerResult | null> {
  const ip = currentCaller();
  if (!ip) return null; // Unidentifiable peer — fail open.

  const hash = await hashCaller(ip);
  if (!hash) return null;

  const client = limiterClient();
  if (!client) return null;

  try {
    const { data, error } = await client.rpc("check_mcp_public_rate_limit", {
      p_caller_hash: hash,
      p_tool: tool,
      p_per_minute: PER_MINUTE,
      p_per_hour: PER_HOUR,
    });

    if (error) return null; // Limiter unavailable — fail open.

    const verdict = (data ?? {}) as {
      allowed?: boolean;
      reason?: string;
      retry_after_seconds?: number;
    };
    if (verdict.allowed !== false) return null;

    const retry = Math.max(1, Math.round(verdict.retry_after_seconds ?? 60));
    const blocked = verdict.reason === "temporarily_blocked";
    const text = blocked
      ? `Too many requests from this connection, so it is paused for ${waitLabel(retry)}. This limit protects the free public Welile tools from spam. Please try again after that, or create a free account at https://welileapp.com for your own personal access.`
      : `Rate limit reached — the free public Welile tools allow ${PER_MINUTE} requests a minute and ${PER_HOUR} an hour per connection. Please try again in ${waitLabel(retry)}, or create a free account at https://welileapp.com for your own personal access.`;

    return publicToolResult({
      tool,
      summary: text,
      next_steps: ["Create a free Welile account for your own personal access, with no shared limit."],
      data: {
        limit_per_minute: PER_MINUTE,
        limit_per_hour: PER_HOUR,
      },
      error: {
        code: "rate_limited",
        message: verdict.reason ?? "rate_limited",
        retry_after_seconds: retry,
        details: { limit_per_minute: PER_MINUTE, limit_per_hour: PER_HOUR },
      },
    });
  } catch {
    return null; // Never take the public tools down over the limiter.
  }
}