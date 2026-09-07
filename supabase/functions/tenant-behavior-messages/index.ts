import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isPhoneBlocked } from "../_shared/smsExceptions.ts";
import { attemptYoolaPrimary, formatPhoneInternational } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MESSAGE_TYPE = "tenant_behavior_message";

interface ReliabilityRow {
  tenant_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  missed_days: number;
  outstanding: number;
  band: "excellent" | "good" | "watch" | "risk";
}

interface Template {
  id: string;
  band: string;
  body: string;
  active: boolean;
}

function firstName(fullName: string | null): string {
  return String(fullName || "").trim().split(/\s+/)[0] || "there";
}

function formatUGX(n: number): string {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
}

function render(template: string, row: ReliabilityRow): string {
  return template
    .replace(/\{\{name\}\}/g, firstName(row.tenant_name))
    .replace(/\{\{missed_days\}\}/g, String(row.missed_days ?? 0))
    .replace(/\{\{outstanding\}\}/g, formatUGX(row.outstanding));
}

const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000; // Africa/Kampala is UTC+3, no DST

// Start of "today" in Africa/Kampala, expressed as a UTC instant.
function kampalaDayStartUtc(): Date {
  const shifted = new Date(Date.now() + KAMPALA_OFFSET_MS);
  const dayStartShifted = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(dayStartShifted - KAMPALA_OFFSET_MS);
}

async function sendSmsFallbackAT(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[tenant-behavior-messages] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const formattedPhone = formatPhoneInternational(phone);
  try {
    const body = new URLSearchParams({ username, to: formattedPhone, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { return false; }
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[tenant-behavior-messages] AT error:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const { data: templateRows, error: templateError } = await admin
      .from("tenant_message_templates")
      .select("id, band, body, active")
      .eq("active", true);
    if (templateError) throw templateError;

    const templates = new Map<string, Template>((templateRows ?? []).map((t: Template) => [t.band, t]));
    if (templates.size === 0) {
      return new Response(JSON.stringify({ message: "No active templates configured", sent: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: reliability, error: reliabilityError } = await admin.rpc(
      "get_tenant_repayment_reliability",
      { p_limit: 2000, p_offset: 0, p_band: null },
    );
    if (reliabilityError) throw reliabilityError;

    const rows: ReliabilityRow[] = (reliability?.rows ?? []) as ReliabilityRow[];

    // Idempotency guard: a tenant already successfully messaged today (Kampala
    // calendar day) is skipped, so a cron double-fire, a manual re-invoke, or a
    // redeploy-triggered re-run doesn't duplicate SMS. Failed attempts are not
    // in this set, so a retry can still resend to them the same day.
    const { data: alreadySentRows, error: alreadySentError } = await admin
      .from("tenant_message_log")
      .select("tenant_id")
      .eq("sent", true)
      .gte("created_at", kampalaDayStartUtc().toISOString());
    if (alreadySentError) throw alreadySentError;
    const alreadySentToday = new Set((alreadySentRows ?? []).map((r: { tenant_id: string }) => r.tenant_id));

    let sent = 0;
    let skippedNoPhone = 0;
    let skippedBlocked = 0;
    let skippedDuplicate = 0;
    let failed = 0;

    for (const row of rows) {
      const template = templates.get(row.band);
      if (!template) continue;

      if (!row.tenant_phone) {
        skippedNoPhone++;
        continue;
      }

      if (alreadySentToday.has(row.tenant_id)) {
        skippedDuplicate++;
        continue;
      }

      const blocked = await isPhoneBlocked(admin, row.tenant_phone, MESSAGE_TYPE);
      if (blocked) {
        skippedBlocked++;
        await admin.from("tenant_message_log").insert({
          tenant_id: row.tenant_id,
          band: row.band,
          template_id: template.id,
          phone: row.tenant_phone,
          sent: false,
          provider: null,
          error: "blocked",
        });
        continue;
      }

      const message = render(template.body, row);

      let ok = await attemptYoolaPrimary(row.tenant_phone, message, {
        source: "tenant-behavior-messages",
        recipientUserId: row.tenant_id,
        recipientName: row.tenant_name,
      });
      let provider = "yoola";
      if (!ok) {
        ok = await sendSmsFallbackAT(row.tenant_phone, message);
        provider = "africastalking";
      }

      if (ok) sent++; else failed++;

      await admin.from("tenant_message_log").insert({
        tenant_id: row.tenant_id,
        band: row.band,
        template_id: template.id,
        phone: row.tenant_phone,
        sent: ok,
        provider: ok ? provider : null,
        error: ok ? null : "send failed",
      });
    }

    console.log(
      `[tenant-behavior-messages] sent=${sent} failed=${failed} noPhone=${skippedNoPhone} blocked=${skippedBlocked} duplicate=${skippedDuplicate} totalTenants=${rows.length}`,
    );

    return new Response(
      JSON.stringify({
        success: true,
        sent,
        failed,
        skippedNoPhone,
        skippedBlocked,
        skippedDuplicate,
        totalTenants: rows.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[tenant-behavior-messages] Error:", error);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
