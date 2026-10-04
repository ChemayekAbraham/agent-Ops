// Cash deposit — expiry notice. Emails the DEPOSITOR (not the verifier) when
// their 4-digit receipt code expires and the pending deposit is auto-rejected.
//
// Two modes (internal, service-role only):
//   { deposit_request_id }  → notify that single deposit immediately
//   { sweep: true }         → find every cash deposit that was auto-rejected
//                             because its code expired but has NOT yet had an
//                             expiry notice emailed, and email each depositor.
//
// The function is idempotent: it records an `expiry_notice_emailed` event and
// skips any deposit that already has one, so the verify-code path and the cron
// sweep can both call it without double-emailing.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const GMAIL_GATEWAY = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";
const EXPIRY_REASON_MATCH = "%receipt code expired%";

function b64url(input: string): string {
  return btoa(unescape(encodeURIComponent(input)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sendGmail(to: string, subject: string, body: string) {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const GOOGLE_MAIL_API_KEY = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
  if (!GOOGLE_MAIL_API_KEY) throw new Error("GOOGLE_MAIL_API_KEY is not configured (Gmail not connected)");
  const raw = b64url(
    [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n"),
  );
  const res = await fetch(`${GMAIL_GATEWAY}/users/me/messages/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": GOOGLE_MAIL_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gmail send failed [${res.status}]: ${t}`);
  }
}

const fmtUGX = (n: number) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString("en-UG")}`;

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type Admin = ReturnType<typeof createClient>;

// Has an expiry notice already been emailed for this deposit?
async function alreadyNotified(admin: Admin, depositId: string): Promise<boolean> {
  try {
    const { data } = await admin
      .from("cash_deposit_verification_events")
      .select("id")
      .eq("deposit_request_id", depositId)
      .eq("event_type", "expiry_notice_emailed")
      .limit(1);
    return Array.isArray(data) && data.length > 0;
  } catch (_) {
    return false;
  }
}

// Resolve the depositor's login email + display name.
async function resolveDepositor(
  admin: Admin,
  userId: string,
): Promise<{ email: string; name: string }> {
  let email = "";
  let name = "";
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    email = (data?.user?.email ?? "").trim();
    const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
    if (typeof meta?.full_name === "string") name = meta.full_name as string;
  } catch (_) { /* non-fatal */ }
  if (!name) {
    try {
      const { data: profile } = await admin
        .from("profiles").select("full_name").eq("id", userId).maybeSingle();
      name = (profile as any)?.full_name ?? "";
    } catch (_) { /* non-fatal */ }
  }
  return { email, name: name || "there" };
}

// Email one depositor about an expired/auto-rejected cash deposit. Returns a
// short status string. Idempotent — records an event so it never re-sends.
async function notifyOne(
  admin: Admin,
  row: { deposit_request_id: string; user_id: string; amount: number; expires_at?: string | null },
): Promise<string> {
  const depositId = row.deposit_request_id;
  if (await alreadyNotified(admin, depositId)) return "already_notified";

  // In-app notification so the depositor sees the auto-rejection inside the app
  // (the notification bell) even if they have no email on file or the email
  // send fails. Best-effort and fires before the email path for that reason.
  try {
    await admin.from("notifications").insert({
      user_id: row.user_id,
      title: "Cash deposit cancelled — code expired",
      message:
        `Your ${fmtUGX(row.amount)} cash deposit was automatically rejected because the ` +
        `4-digit receipt code expired before it was entered. No money was credited. ` +
        `Start a new cash deposit to get a fresh code.`,
      type: "error",
      metadata: {
        kind: "cash_deposit_expired",
        deposit_request_id: depositId,
        amount: row.amount,
        expires_at: row.expires_at ?? null,
      },
    } as any);
  } catch (e) {
    console.error("[notify-expired] in-app notification insert failed", e);
  }

  // EMAIL DISABLED (per product decision): we no longer email depositors when a
  // cash deposit code expires. The in-app notification above is the sole channel.
  // We still record the idempotency event so the cron sweep never re-inserts the
  // in-app notification every cycle.
  try {
    await admin.from("cash_deposit_verification_events").insert({
      deposit_request_id: depositId,
      user_id: row.user_id,
      event_type: "expiry_notice_emailed",
      amount: row.amount,
      detail: "Expiry/auto-rejection in-app notice delivered; email channel disabled.",
      metadata: { emailed_to: null, in_app: true, email_disabled: true, expires_at: row.expires_at ?? null },
    } as any);
  } catch (e) {
    console.error("[notify-expired] audit insert failed", e);
  }
  return "notified_in_app";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // Internal-only function. Invoked by the verify-code path (service-role key)
    // and by the scheduled sweep (anon key), matching this project's other
    // cron-driven functions which run under verify_jwt=false. It only emails
    // depositors whose cash deposits were already auto-rejected for an expired
    // code, and is idempotent, so there is no sensitive surface to abuse.
    const admin = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const depositId = typeof body?.deposit_request_id === "string" ? body.deposit_request_id : "";
    const sweep = body?.sweep === true;

    // ── Single deposit ──
    if (depositId) {
      const { data: dr } = await admin
        .from("deposit_requests")
        .select("id, user_id, amount")
        .eq("id", depositId)
        .maybeSingle();
      if (!dr) return json(404, { error: "not_found" });
      // Best-effort expiry window for the audit record.
      const { data: ver } = await admin
        .from("cash_deposit_verifications")
        .select("expires_at")
        .eq("deposit_request_id", depositId)
        .maybeSingle();
      const result = await notifyOne(admin, {
        deposit_request_id: (dr as any).id,
        user_id: (dr as any).user_id,
        amount: Number((dr as any).amount),
        expires_at: (ver as any)?.expires_at ?? null,
      });
      return json(200, { ok: true, result });
    }

    // ── Sweep mode: notify every expiry-rejected deposit not yet emailed ──
    if (sweep) {
      const { data: rows, error } = await admin
        .from("deposit_requests")
        .select("id, user_id, amount")
        .eq("provider", "cash_deposit")
        .eq("status", "rejected")
        .ilike("rejection_reason", EXPIRY_REASON_MATCH)
        .order("rejected_at", { ascending: false })
        .limit(200);
      if (error) return json(500, { error: error.message });

      let emailed = 0, skipped = 0, failed = 0;
      for (const r of (rows ?? [])) {
        try {
          const res = await notifyOne(admin, {
            deposit_request_id: (r as any).id,
            user_id: (r as any).user_id,
            amount: Number((r as any).amount),
          });
          if (res === "emailed") emailed++;
          else skipped++;
        } catch (e) {
          failed++;
          console.error("[notify-expired] sweep send failed", (r as any).id, e);
        }
      }
      return json(200, { ok: true, emailed, skipped, failed, scanned: (rows ?? []).length });
    }

    return json(400, { error: "invalid_request", message: "Provide deposit_request_id or sweep:true" });
  } catch (e) {
    console.error("[notify-expired] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});