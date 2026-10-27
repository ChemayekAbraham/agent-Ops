import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireStaffAal2 } from "../_shared/staffMfa.ts";
import { bytesToBase64, renderZoeReportPdf } from "../_shared/zoeReportPdf.ts";
import { kampalaToday } from "../staff-assistant/dates.ts";
import {
  DEFAULT_MAX_EMAILS_PER_DAY,
  handleStaffAssistantSendEmail,
} from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function resolveSenderRoles(
  userClient: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const roles = new Set<string>();
  const { data: rows } = await userClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("enabled", true);

  for (const r of rows ?? []) {
    if (typeof r?.role === "string" && r.role.trim()) {
      roles.add(r.role.trim().toLowerCase());
    }
  }

  if (roles.size === 0) {
    const { data: profileData } = await userClient.rpc("assistant_staff_my_profile");
    const enabledRoles = (profileData as Record<string, unknown> | null)?.data as
      | Record<string, unknown>
      | undefined;
    const roleList = enabledRoles?.enabled_roles;
    if (Array.isArray(roleList)) {
      for (const item of roleList) {
        if (typeof item === "string" && item.trim()) {
          roles.add(item.trim().toLowerCase());
        }
      }
    }
  }

  return [...roles];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json(401, { error: "Please sign in again." });
  }
  const token = authHeader.slice(7).trim();
  if (!token) {
    return json(401, { error: "Please sign in again." });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(500, { error: "Server configuration error" });
  }

  // Sender-scoped client (carries the sender's own JWT — used for access checks,
  // staff_assistant_is_staff_email, staff_assistant_email_recipients, and re-running the report!)
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  // Admin client used ONLY for reading staff_assistant_config / daily email count
  // and writing audit_logs + system_events after send-transactional-email succeeds.
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }

  const result = await handleStaffAssistantSendEmail(rawBody, {
    getSender: async () => {
      const {
        data: { user },
        error,
      } = await userClient.auth.getUser(token);
      if (error || !user) return null;
      // Take sender name and email strictly from public.profiles — NEVER from user.user_metadata
      const { data: profile } = await userClient
        .from("profiles")
        .select("full_name, email")
        .eq("id", user.id)
        .maybeSingle();
      const profileName =
        typeof profile?.full_name === "string" && profile.full_name.trim()
          ? profile.full_name.trim()
          : "";
      const profileEmail =
        typeof profile?.email === "string" && profile.email.trim()
          ? profile.email.trim()
          : user.email ?? "";
      return {
        id: user.id,
        email: profileEmail,
        fullName: profileName || profileEmail || "Welile Staff Member",
      };
    },
    getSenderRoles: (userId) => resolveSenderRoles(userClient, userId),
    checkHasAccess: async () => {
      const { data, error } = await userClient.rpc("staff_assistant_has_access");
      return !error && data === true;
    },
    checkIsStaffEmail: async (email) => {
      const { data, error } = await userClient.rpc("staff_assistant_is_staff_email", {
        p_email: email,
      });
      return !error && data === true;
    },
    lookupStaffRecipients: async (search) => {
      const { data, error } = await userClient.rpc("staff_assistant_email_recipients", {
        p_search: search,
      });
      if (error) return [];
      return data ?? [];
    },
    checkRecipientCanReadReport: async (recipientUserId, reportRpc, ownerId) => {
      const { data, error } = await userClient.rpc("staff_assistant_can_user_read_report", {
        p_user_id: recipientUserId,
        p_report_rpc: reportRpc,
        p_owner_id: ownerId,
      });
      return !error && data === true;
    },
    consumeDraft: async (draftId, payload) => {
      const { data, error } = await userClient.rpc("staff_assistant_consume_draft", {
        p_draft_id: draftId,
        p_kind: "email",
        p_payload: payload,
      });
      if (error || !data) {
        return {
          ok: false,
          error: error?.message || "Draft validation failed",
        };
      }
      return { ok: true };
    },
    checkSenderMfa: async (userId) => {
      const mfa = await requireStaffAal2(adminClient, token, userId);
      return { ok: mfa.ok };
    },
    runReportRpcAsSender: async (rpcName, rpcArgs) => {
      const { data, error } = await userClient.rpc(rpcName, rpcArgs);
      return {
        data: (data as Record<string, unknown> | null) ?? null,
        error: error ? { code: error.code, message: error.message } : null,
      };
    },
    getDailyEmailUsage: async (userId) => {
      const { data: budgetRow, error: budgetErr } = await adminClient.rpc(
        "staff_assistant_check_email_budget",
        {
          p_user_id: userId,
          p_recipient_count: 1,
        },
      );
      if (!budgetErr && budgetRow && typeof budgetRow === "object") {
        const rec = budgetRow as Record<string, unknown>;
        return {
          sentToday: typeof rec.sent_today === "number" ? rec.sent_today : 0,
          maxEmailsPerDay:
            typeof rec.max_emails_per_day === "number"
              ? rec.max_emails_per_day
              : DEFAULT_MAX_EMAILS_PER_DAY,
        };
      }

      const { data: cfg } = await adminClient
        .from("staff_assistant_config")
        .select("max_emails_per_day")
        .eq("id", true)
        .maybeSingle();
      const maxEmailsPerDay =
        typeof cfg?.max_emails_per_day === "number"
          ? cfg.max_emails_per_day
          : DEFAULT_MAX_EMAILS_PER_DAY;

      const todayStart = `${kampalaToday()}T00:00:00+03:00`;
      const { count } = await adminClient
        .from("audit_logs")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("action_type", "staff_assistant_report_email_sent")
        .gte("created_at", todayStart);

      return {
        sentToday: count ?? 0,
        maxEmailsPerDay,
      };
    },
    renderPdfBase64: async (pdfData) => {
      const pdfBytes = await renderZoeReportPdf(pdfData);
      return bytesToBase64(pdfBytes);
    },
    sendTransactionalEmail: async (payload) => {
      const res = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${serviceKey}`,
          apikey: anonKey,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `send-transactional-email failed (${res.status}): ${text}` };
      }
      return { ok: true };
    },
    writeAuditAndSystemEvent: async (entry) => {
      await adminClient.from("audit_logs").insert({
        user_id: entry.senderId,
        action_type: "staff_assistant_report_email_sent",
        table_name: "staff_assistant_messages",
        record_id: entry.messageId ?? null,
        reason: `Shared Zoe report (${entry.toolName}) with active staff recipient ${entry.recipientEmail}`,
        metadata: {
          conversation_id: entry.conversationId ?? null,
          tool: entry.toolName,
          rpc: entry.rpcName,
          source: entry.source,
          period: entry.periodLabel,
          row_count: entry.rowCount,
          recipient_count: 1,
          recipient_user_id: entry.recipientUserId,
          recipient_name: entry.recipientName,
          recipient_email: entry.recipientEmail,
          subject: entry.subject,
          template_name: "zoe-report-shared",
          template_display_name: "Report shared from Zoe",
          attachment_filename: entry.attachmentFilename,
        },
      });

      await adminClient.from("system_events").insert({
        event_type: "staff_assistant.report_email_sent",
        actor_id: entry.senderId,
        user_id: entry.senderId,
        source: "staff-assistant-send-email",
        description: `Report shared from Zoe (${entry.toolName}) by ${entry.senderName} to ${entry.recipientEmail}`,
        metadata: {
          conversation_id: entry.conversationId ?? null,
          message_id: entry.messageId ?? null,
          tool: entry.toolName,
          rpc: entry.rpcName,
          source: entry.source,
          period: entry.periodLabel,
          row_count: entry.rowCount,
          recipient_count: 1,
          recipient_user_id: entry.recipientUserId,
          recipient_name: entry.recipientName,
          recipient_email: entry.recipientEmail,
          subject: entry.subject,
          template_name: "zoe-report-shared",
          attachment_filename: entry.attachmentFilename,
        },
      });
    },
  });

  return json(result.status, result.body);
});
