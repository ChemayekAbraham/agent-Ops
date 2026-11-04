import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bytesToBase64, renderZoeReportPdf } from "../_shared/zoeReportPdf.ts";
import { kampalaToday } from "../staff-assistant/dates.ts";
import { DEFAULT_MAX_EMAILS_PER_DAY } from "../staff-assistant-send-email/handler.ts";
import {
  DueScheduleRecord,
  runStaffAssistantSchedules,
} from "./handler.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(500, { error: "Server configuration error" });
  }

  // Require either the service role bearer token or CRON_SECRET header
  const authHeader = req.headers.get("Authorization") ?? "";
  const cronSecretHeader = req.headers.get("x-cron-secret") ?? "";
  const configuredCronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const bearerToken = authHeader.toLowerCase().startsWith("bearer ")
    ? authHeader.slice(7).trim()
    : "";

  const isServiceRoleCaller = bearerToken === serviceKey;
  const isCronSecretCaller =
    Boolean(configuredCronSecret) && cronSecretHeader === configuredCronSecret;

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Also allow an authenticated staff caller who passes staff_assistant_has_access()
  // to trigger a manual schedule check for their own due schedules if needed.
  let manualOwnerId: string | null = null;
  if (!isServiceRoleCaller && !isCronSecretCaller) {
    if (!bearerToken) {
      return json(401, { error: "Unauthorized" });
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearerToken}` } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser(bearerToken);
    if (!user) {
      return json(401, { error: "Unauthorized" });
    }
    const { data: hasAccess } = await userClient.rpc("staff_assistant_has_access");
    if (hasAccess !== true) {
      return json(403, { error: "Forbidden" });
    }
    manualOwnerId = user.id;
  }

  const result = await runStaffAssistantSchedules({
    dispatchDueReminders: async () => {
      const { data, error } = await adminClient.rpc(
        "staff_assistant_dispatch_due_reminders",
      );
      if (error || typeof data !== "number") return 0;
      return data;
    },
    loadDueSchedules: async (): Promise<DueScheduleRecord[]> => {
      let query = adminClient
        .from("staff_assistant_schedules")
        .select(
          "id, user_id, title, report_tool, report_rpc, report_args, frequency, day_of_week, send_time_kampala, recipient_emails, recipient_names, custom_message, run_count, mfa_confirmed_at",
        )
        .eq("status", "active")
        .lte("next_run_at", new Date().toISOString())
        .order("next_run_at", { ascending: true })
        .limit(50);

      if (manualOwnerId) {
        query = query.eq("user_id", manualOwnerId);
      }

      const { data } = await query;
      return (data ?? []).map((row) => ({
        id: String(row.id),
        user_id: String(row.user_id),
        title: String(row.title ?? ""),
        report_tool: String(row.report_tool ?? ""),
        report_rpc: String(row.report_rpc ?? ""),
        report_args:
          row.report_args &&
          typeof row.report_args === "object" &&
          !Array.isArray(row.report_args)
            ? (row.report_args as Record<string, unknown>)
            : {},
        frequency: row.frequency === "weekly" ? "weekly" : "daily",
        day_of_week: typeof row.day_of_week === "number" ? row.day_of_week : null,
        send_time_kampala: String(row.send_time_kampala ?? "07:30"),
        recipient_emails: Array.isArray(row.recipient_emails)
          ? row.recipient_emails.map((e: unknown) => String(e))
          : [],
        recipient_names: Array.isArray(row.recipient_names)
          ? row.recipient_names.map((n: unknown) => String(n))
          : [],
        custom_message:
          typeof row.custom_message === "string" ? row.custom_message : null,
        run_count: typeof row.run_count === "number" ? row.run_count : 0,
        mfa_confirmed_at:
          typeof row.mfa_confirmed_at === "string" ? row.mfa_confirmed_at : null,
      }));
    },
    checkOwnerHasAccess: async (ownerId) => {
      const { data, error } = await adminClient.rpc(
        "staff_assistant_check_owner_access",
        { p_owner_id: ownerId },
      );
      return !error && data === true;
    },
    getOwnerProfileAndRoles: async (ownerId) => {
      const [{ data: profile }, { data: roleRows }] = await Promise.all([
        adminClient
          .from("profiles")
          .select("full_name, email")
          .eq("id", ownerId)
          .maybeSingle(),
        adminClient
          .from("user_roles")
          .select("role")
          .eq("user_id", ownerId)
          .eq("enabled", true),
      ]);

      const roles = (roleRows ?? [])
        .map((r) => (typeof r?.role === "string" ? r.role.trim().toLowerCase() : ""))
        .filter(Boolean);

      return {
        fullName:
          (typeof profile?.full_name === "string" && profile.full_name.trim()) ||
          (typeof profile?.email === "string" && profile.email.trim()) ||
          "Welile Staff Member",
        email: (typeof profile?.email === "string" && profile.email.trim()) || "",
        roles,
      };
    },
    checkRecipientIsStaffEmail: async (email) => {
      const { data, error } = await adminClient.rpc("staff_assistant_is_staff_email", {
        p_email: email,
      });
      return !error && data === true;
    },
    checkRecipientCanReadReport: async (recipientEmail, reportRpc, ownerId) => {
      const { data: recProfile } = await adminClient
        .from("profiles")
        .select("id")
        .ilike("email", recipientEmail.trim().toLowerCase())
        .maybeSingle();
      if (!recProfile?.id) return false;
      const { data, error } = await adminClient.rpc("staff_assistant_can_user_read_report", {
        p_user_id: recProfile.id,
        p_report_rpc: reportRpc,
        p_owner_id: ownerId,
      });
      return !error && data === true;
    },
    getDailyEmailUsage: async (ownerId) => {
      const { data: budgetRow, error: budgetErr } = await adminClient.rpc(
        "staff_assistant_check_email_budget",
        {
          p_user_id: ownerId,
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
        .eq("user_id", ownerId)
        .eq("action_type", "staff_assistant_report_email_sent")
        .gte("created_at", todayStart);

      return {
        sentToday: count ?? 0,
        maxEmailsPerDay,
      };
    },
    runReportAsOwner: async (ownerId, rpcName, rpcArgs) => {
      const { data, error } = await adminClient.rpc(
        "staff_assistant_run_scheduled_report_as_owner",
        {
          p_owner_id: ownerId,
          p_report_rpc: rpcName,
          p_report_args: rpcArgs,
        },
      );
      return {
        data: (data as Record<string, unknown> | null) ?? null,
        error: error ? { code: error.code, message: error.message } : null,
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
    computeNextRunAt: async (params) => {
      const { data } = await adminClient.rpc("staff_assistant_compute_next_run", {
        p_frequency: params.frequency,
        p_send_time_kampala: params.sendTimeKampala,
        p_day_of_week: params.dayOfWeek,
        p_from: new Date().toISOString(),
      });
      if (typeof data === "string" && data) return data;
      const fallback = new Date(
        Date.now() + (params.frequency === "weekly" ? 7 : 1) * 86_400_000,
      );
      return fallback.toISOString();
    },
    updateScheduleState: async (scheduleId, patch) => {
      await adminClient
        .from("staff_assistant_schedules")
        .update({
          ...(patch.status ? { status: patch.status } : {}),
          last_run_at: patch.last_run_at,
          last_run_status: patch.last_run_status,
          ...(patch.next_run_at ? { next_run_at: patch.next_run_at } : {}),
          ...(typeof patch.run_count === "number" ? { run_count: patch.run_count } : {}),
        })
        .eq("id", scheduleId);
    },
    writeScheduleAudit: async (entry) => {
      await adminClient.from("audit_logs").insert({
        user_id: entry.ownerId,
        action_type: entry.actionType,
        table_name: "staff_assistant_schedules",
        record_id: entry.scheduleId,
        reason: entry.reason,
        metadata: entry.metadata,
      });
      await adminClient.from("system_events").insert({
        event_type: entry.eventType,
        actor_id: entry.ownerId,
        user_id: entry.ownerId,
        source: "staff-assistant-schedule-runner",
        description: entry.reason,
        metadata: entry.metadata,
      });
    },
  });

  return json(result.status, result.body);
});
