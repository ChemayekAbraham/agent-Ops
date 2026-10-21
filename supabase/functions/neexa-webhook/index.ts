import { createClient } from "npm:@supabase/supabase-js@2";
import { conversationRow, ingestMessage, neexaFetch, verifyNeexaSignature } from "../_shared/neexa.ts";

// Neexa webhook receiver for the CMO inbox. Its URL is entered under
// Neexa → Workspace → Developers → Webhooks.
//
// Called by Neexa, not by a signed-in user, so verify_jwt is off and the gate is the
// HMAC signature over the raw body (X-Neexa-Signature, keyed with NEEXA_WEBHOOK_SECRET).
//
//   GET  ?challenge=…        One-off ownership check when the URL is saved. Echo it back.
//   POST messages:<ch>       A customer wrote to us.
//   POST message_echoes:<ch> We replied outside the API (AI auto-reply, Neexa dashboard,
//                            WhatsApp Business App). Our own API sends are not echoed;
//                            neexa-api records those itself.
//
// Neexa retries any non-2xx for 24h+, so storage is idempotent on message_id and only a
// bad signature or a malformed body gets a non-2xx.

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface NeexaEvent {
  event?: string;
  data?: {
    message_id?: string | number;
    platform_message_id?: string;
    platform_id?: string;
    conversation_id?: string | number;
    from?: string;
    to?: string;
    message?: string;
    timestamp?: string;
  };
}

// Echo a challenge only if it looks like one (URL-safe or base64 characters), so this
// endpoint cannot reflect arbitrary content.
const CHALLENGE_RE = /^[A-Za-z0-9._~+/=-]{1,512}$/;

function challengeResponse(challenge: string) {
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

function challengeFromQuery(url: URL): string {
  return url.searchParams.get("challenge") ?? url.searchParams.get("hub.challenge") ??
    url.searchParams.get("hub_challenge") ?? "";
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // DIAGNOSTIC (2026-10-21): records the SHAPE of any request that is not a stored
  // message (method, header names, query keys, sizes, a short body preview), so a
  // failed registration in the Neexa dashboard shows what Neexa actually sent. It never
  // stores the secret or a computed MAC. Remove once registration works.
  const diag = async (outcome: string, raw = "") => {
    try {
      await admin.from("neexa_webhook_events").insert({
        event: `_diag:${req.method}:${outcome}`,
        payload: {
          query_keys: [...url.searchParams.keys()],
          challenge_len: challengeFromQuery(url).length,
          headers: [...req.headers.keys()],
          content_type: req.headers.get("content-type"),
          user_agent: req.headers.get("user-agent")?.slice(0, 120) ?? null,
          signature_len: (req.headers.get("x-neexa-signature") ?? "").length,
          body_len: raw.length,
          body_preview: raw.slice(0, 300),
        },
      });
    } catch (e) {
      console.warn("neexa-webhook: diag insert failed", e instanceof Error ? e.message : e);
    }
  };

  if (req.method === "HEAD" || req.method === "OPTIONS") {
    await diag("probe");
    return new Response(null, { status: 200 });
  }

  if (req.method === "GET") {
    const challenge = challengeFromQuery(url);
    if (!challenge) {
      await diag("no_challenge");
      return json({ ok: true });
    }
    if (!CHALLENGE_RE.test(challenge)) {
      await diag("invalid_challenge");
      return json({ error: "invalid_challenge" }, 400);
    }
    await diag("challenge_ok");
    return challengeResponse(challenge);
  }
  if (req.method !== "POST") {
    await diag("method_not_allowed");
    return json({ error: "method_not_allowed" }, 405);
  }

  const raw = await req.text();

  // Some providers verify with a POST carrying only a challenge. Echoing it stores nothing.
  const queryChallenge = challengeFromQuery(url);
  let bodyChallenge = "";
  try {
    const b = JSON.parse(raw);
    if (b && typeof b === "object" && !("event" in b) && typeof b.challenge === "string") bodyChallenge = b.challenge;
  } catch { /* not JSON; handled below */ }
  const postChallenge = bodyChallenge || queryChallenge;
  if (postChallenge && CHALLENGE_RE.test(postChallenge)) {
    await diag("post_challenge", raw);
    return challengeResponse(postChallenge);
  }

  const secret = Deno.env.get("NEEXA_WEBHOOK_SECRET")?.trim();
  if (!secret) {
    console.error("NEEXA_WEBHOOK_SECRET is not set");
    await diag("not_configured", raw);
    return json({ error: "not_configured" }, 500);
  }

  const header = req.headers.get("x-neexa-signature") ?? "";
  if (!(await verifyNeexaSignature(secret, raw, header))) {
    // Log the header's shape (never the secret or a computed MAC) so a format mismatch
    // can be told apart from a forged call.
    console.warn("neexa-webhook: invalid signature", { header_len: header.length, header_prefix: header.slice(0, 8) });
    await diag("invalid_signature", raw);
    return json({ error: "invalid_signature" }, 401);
  }

  let p: NeexaEvent;
  try {
    p = JSON.parse(raw);
  } catch {
    await diag("invalid_json", raw);
    return json({ error: "invalid_json" }, 400);
  }

  const event = typeof p?.event === "string" ? p.event : "";
  const [kind, channel] = event.split(":");
  const d = p?.data ?? {};
  const messageId = d.message_id != null ? String(d.message_id) : "";
  const conversationId = d.conversation_id != null ? String(d.conversation_id) : "";

  const { data: logged, error: logErr } = await admin
    .from("neexa_webhook_events")
    .insert({ event: event || "unknown", message_id: messageId || null, payload: p })
    .select("id")
    .single();
  if (logErr) console.error("neexa-webhook: event log insert failed", logErr.message);

  const finish = async (error: string | null) => {
    if (!logged?.id) return;
    await admin.from("neexa_webhook_events")
      .update({ processed_at: new Date().toISOString(), error })
      .eq("id", logged.id);
  };

  if (kind !== "messages" && kind !== "message_echoes") {
    await finish("ignored_event");
    return json({ received: true, ignored: event }, 202);
  }
  if (!messageId || !conversationId) {
    await finish("missing_ids");
    return json({ error: "missing_ids" }, 400);
  }

  const inbound = kind === "messages";
  try {
    await ingestMessage(admin, {
      message_id: messageId,
      conversation_id: conversationId,
      direction: inbound ? "inbound" : "outbound",
      source: inbound ? "customer" : "echo",
      body: d.message ?? null,
      sent_at: d.timestamp ?? null,
      channel: channel || null,
      platform_message_id: d.platform_message_id ?? null,
      platform_id: d.platform_id ?? null,
      customer_address: (inbound ? d.from : d.to) ?? null,
    });
  } catch (e) {
    // A database failure is ours to fix; a 500 makes Neexa retry, so nothing is lost meanwhile.
    const msg = e instanceof Error ? e.message : String(e);
    console.error("neexa-webhook: ingest failed", msg);
    await finish(msg.slice(0, 500));
    return json({ error: "ingest_failed" }, 500);
  }
  await finish(null);

  // First sight of a conversation: fetch its title (the customer's name), label and
  // sentiment after replying, so Neexa is not kept waiting.
  const fillDetails = async () => {
    const { data: conv } = await admin
      .from("neexa_conversations")
      .select("details_synced_at")
      .eq("id", conversationId)
      .maybeSingle();
    if (conv?.details_synced_at) return;
    try {
      const res = await neexaFetch(`/v1/conversations/${encodeURIComponent(conversationId)}`);
      if (res?.data) await admin.from("neexa_conversations").update(conversationRow(res.data)).eq("id", conversationId);
    } catch (e) {
      console.warn("neexa-webhook: conversation details fetch failed", e instanceof Error ? e.message : e);
    }
  };
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(fillDetails());
  else await fillDetails();

  return json({ received: true });
});
