/**
 * Neexa inbox proxy for the CMO dashboard.
 *
 * The browser never holds NEEXA_API_KEY. It calls this function with its own JWT; we
 * check an enabled cmo / super_admin / cto role (can_view_neexa_inbox), call Neexa,
 * and mirror what comes back into neexa_conversations / neexa_messages so the inbox can
 * read the mirror directly and stay live over realtime.
 *
 * POST { action, ... }:
 *   list_conversations  { page?, platform? }             → Neexa page, mirrored
 *   sync_conversations  { platform?, max_pages? }        → walks pages (backfill), mirrored
 *   get_conversation    { conversation_id }              → mirrored
 *   get_messages        { conversation_id, page? }       → Neexa page, mirrored
 *   send_message        { conversation_id, message }     → reply in an open conversation
 *   list_templates      { page? }                        → approved WhatsApp templates
 *   send_template       { template, to, variables? }     → first-contact WhatsApp template
 *   list_channels       {}                               → connected WhatsApp numbers, inboxes, pages
 */
// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  ingestMessage,
  messageFromResource,
  NeexaError,
  neexaFetch,
  upsertConversations,
} from "../_shared/neexa.ts";
import { toUgandaE164 } from "../_shared/ugandaPhone.ts";

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const MAX_MESSAGE = 4096; // Neexa's limit
const MAX_SYNC_PAGES = 50;

// Regulatory copy: "Rent Plan" not loan, "Supporter" not lender, "Returns" not ROI.
// "interest" is left out because "thanks for your interest" is ordinary English.
const BANNED_TERMS = /\b(loans?|lenders?|lending|roi)\b/i;

const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const pageOf = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : undefined;
};

/** Conversation ids are Neexa integers; reject anything else before it reaches a URL. */
const convId = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
  return /^\d{1,20}$/.test(s) ? s : null;
};

/** International number as digits only, the format Neexa's template endpoint expects. */
function toNeexaPhone(raw: unknown): string | null {
  const ug = toUgandaE164(raw);
  if (ug) return ug.replace(/^\+/, "");
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("+")) return null; // non-Ugandan numbers must carry their country code
  const digits = t.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

function stringList(v: unknown, maxItems: number, maxLen: number): string[] | null | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > maxItems) return null;
  if (!v.every((x) => typeof x === "string" && x.length <= maxLen)) return null;
  return v as string[];
}

async function mirrorMessages(admin: any, resources: any[], conversationId: string) {
  for (const r of resources) {
    if (r?.id == null) continue;
    await ingestMessage(admin, messageFromResource(r, conversationId, "sync"));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // ---- auth ----
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthenticated" }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const staff = userData?.user;
  if (userErr || !staff) return json({ error: "unauthenticated" }, 401);

  const { data: allowed, error: roleErr } = await admin.rpc("can_view_neexa_inbox", { _uid: staff.id });
  if (roleErr) return json({ error: "role_check_failed" }, 500);
  if (allowed !== true) return json({ error: "not_authorized" }, 403);

  // ---- input ----
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const action = str(body.action, 40);

  try {
    switch (action) {
      case "list_conversations": {
        const res = await neexaFetch("/v1/conversations", {
          query: {
            page: pageOf(body.page),
            "filter[platform]": str(body.platform, 30) ?? undefined,
            include: "latestMessage,businessClient",
          },
        });
        await upsertConversations(admin, res?.data ?? []);
        return json(res);
      }

      case "sync_conversations": {
        const maxPages = Math.min(pageOf(body.max_pages) ?? 10, MAX_SYNC_PAGES);
        const platform = str(body.platform, 30) ?? undefined;
        let page = 1, synced = 0, lastPage: number | null = null;
        for (; page <= maxPages; page++) {
          const res = await neexaFetch("/v1/conversations", { query: { page, "filter[platform]": platform } });
          const rows = res?.data ?? [];
          await upsertConversations(admin, rows);
          synced += rows.length;
          lastPage = res?.meta?.last_page ?? null;
          if (!res?.links?.next || rows.length === 0) break;
        }
        return json({ synced, pages: Math.min(page, maxPages), last_page: lastPage, complete: page <= maxPages });
      }

      case "get_conversation": {
        const id = convId(body.conversation_id);
        if (!id) return json({ error: "conversation_id_required" }, 400);
        const res = await neexaFetch(`/v1/conversations/${id}`);
        if (res?.data) await upsertConversations(admin, [res.data]);
        return json(res);
      }

      case "get_messages": {
        const id = convId(body.conversation_id);
        if (!id) return json({ error: "conversation_id_required" }, 400);
        const res = await neexaFetch(`/v1/conversations/${id}/messages`, {
          query: { page: pageOf(body.page), include: "sender" },
        });
        await mirrorMessages(admin, res?.data ?? [], id);
        return json(res);
      }

      case "send_message": {
        const id = convId(body.conversation_id);
        if (!id) return json({ error: "conversation_id_required" }, 400);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return json({ error: "message_required" }, 400);
        if (message.length > MAX_MESSAGE) return json({ error: "message_too_long", max: MAX_MESSAGE }, 400);
        const banned = message.match(BANNED_TERMS);
        if (banned) return json({ error: "banned_term", term: banned[0] }, 422);

        const res = await neexaFetch(`/v1/conversations/${id}/messages`, { method: "POST", body: { message } });
        // Neexa does not echo API sends to the webhook, so record it here.
        if (res?.data?.id != null) {
          await ingestMessage(admin, { ...messageFromResource(res.data, id, "api"), sent_by: staff.id });
        }
        return json(res, 201);
      }

      case "list_templates": {
        const res = await neexaFetch("/v1/templates", { query: { page: pageOf(body.page) } });
        return json(res);
      }

      case "send_template": {
        const template = str(body.template, 100);
        if (!template || !/^[A-Za-z0-9_-]+$/.test(template)) return json({ error: "template_required" }, 400);
        const to = toNeexaPhone(body.to);
        if (!to) return json({ error: "invalid_phone" }, 400);

        const v = (body.variables ?? {}) as Record<string, unknown>;
        const header = stringList(v.header, 10, 60);
        const bodyVars = stringList(v.body, 30, 120);
        const buttons = stringList(v.buttons, 10, 120);
        if (header === null || bodyVars === null || buttons === null) return json({ error: "invalid_variables" }, 400);
        const filled = [...(header ?? []), ...(bodyVars ?? []), ...(buttons ?? [])].join(" ");
        const banned = filled.match(BANNED_TERMS);
        if (banned) return json({ error: "banned_term", term: banned[0] }, 422);

        const variables: Record<string, string[]> = {};
        if (header) variables.header = header;
        if (bodyVars) variables.body = bodyVars;
        if (buttons) variables.buttons = buttons;

        const res = await neexaFetch(`/v1/templates/${encodeURIComponent(template)}/messages`, {
          method: "POST",
          body: { to, ...(Object.keys(variables).length ? { variables } : {}) },
        });
        const conv = res?.data?.attributes?.ai_human_conversation_id;
        if (res?.data?.id != null && conv != null) {
          await ingestMessage(admin, {
            ...messageFromResource(res.data, String(conv), "api"),
            customer_address: `+${to}`,
            template_public_id: template,
            sent_by: staff.id,
          });
        }
        return json(res, 201);
      }

      case "list_channels": {
        const res = await neexaFetch("/v1/communication-channels");
        return json(res);
      }

      default:
        return json({ error: "unknown_action" }, 400);
    }
  } catch (e) {
    if (e instanceof NeexaError) {
      console.error(`neexa-api ${action}: Neexa ${e.status}`, e.message);
      // Pass Neexa's own 404/422 through (bad id, validation); everything else is upstream trouble.
      const status = e.status === 404 || e.status === 422 ? e.status : 502;
      return json({ error: "neexa_error", neexa_status: e.status, message: e.message, details: e.body }, status);
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`neexa-api ${action}: failed`, msg);
    return json({ error: "internal_error", message: msg }, 500);
  }
});
