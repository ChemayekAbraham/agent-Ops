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

Deno.serve(async (req) => {
  if (req.method === "GET") {
    // Echo the challenge only if it looks like one, so this cannot reflect arbitrary content.
    const challenge = new URL(req.url).searchParams.get("challenge") ?? "";
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(challenge)) return json({ error: "invalid_challenge" }, 400);
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("NEEXA_WEBHOOK_SECRET")?.trim();
  if (!secret) {
    console.error("NEEXA_WEBHOOK_SECRET is not set");
    return json({ error: "not_configured" }, 500);
  }

  const raw = await req.text();
  const header = req.headers.get("x-neexa-signature") ?? "";
  if (!(await verifyNeexaSignature(secret, raw, header))) {
    // Log the header's shape (never the secret or a computed MAC) so a format mismatch
    // can be told apart from a forged call.
    console.warn("neexa-webhook: invalid signature", { header_len: header.length, header_prefix: header.slice(0, 8) });
    return json({ error: "invalid_signature" }, 401);
  }

  let p: NeexaEvent;
  try {
    p = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const event = typeof p?.event === "string" ? p.event : "";
  const [kind, channel] = event.split(":");
  const d = p?.data ?? {};
  const messageId = d.message_id != null ? String(d.message_id) : "";
  const conversationId = d.conversation_id != null ? String(d.conversation_id) : "";

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

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
