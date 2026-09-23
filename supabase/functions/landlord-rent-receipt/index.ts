// Landlord rent-payment receipt + SMS.
//
// Single trigger point for "the landlord got the money": called right after a
// landlord float disbursement is CONFIRMED (merchant agent path in
// approve-withdrawal, or the FinOps "Approve with TID" path). It:
//   1. issues the permanent, immutable receipt (idempotent per payout),
//   2. SMSes the landlord the rent-receipt notice with the public short link,
//   3. records delivery bookkeeping.
//
// It never issues a receipt while the payout is pending or failed, and an SMS
// failure never affects the payout itself — staff can resend.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendSMS, formatPhoneInternational, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const RECEIPT_BASE_URL = "https://welileapp.com/r";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function formatUGX(amount: number) {
  return `UGX ${Math.round(Number(amount) || 0).toLocaleString("en-US")}`;
}

function formatDateTime(iso: string | null) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Africa/Kampala",
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const body = await req.json().catch(() => ({}));
    const payoutId: string | undefined = body?.payout_id;
    const resend: boolean = body?.resend === true;
    let processedBy: string | null = body?.processed_by ?? null;

    if (!payoutId || !/^[0-9a-f-]{36}$/i.test(payoutId)) {
      return json({ error: "payout_id (uuid) is required" }, 400);
    }

    // ── Auth: either an internal service-role call, or a signed-in staff user ──
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    const internal = token === SERVICE_ROLE;
    if (!internal) {
      if (!token) return json({ error: "Unauthorized" }, 401);
      const { data: userRes, error: userErr } = await admin.auth.getUser(token);
      const user = userRes?.user;
      if (userErr || !user) return json({ error: "Unauthorized" }, 401);

      const { data: roles } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const allowed = new Set(["operations", "cfo", "manager", "cashout_agent", "agent"]);
      const isStaff = (roles ?? []).some((r: { role: string }) => allowed.has(r.role));
      if (!isStaff) return json({ error: "Forbidden" }, 403);
      processedBy = processedBy ?? user.id;
    }

    // ── 1. Issue (or fetch) the permanent receipt ───────────────────────────
    const { data: issued, error: issueErr } = await admin.rpc("issue_landlord_payout_receipt", {
      p_payout_id: payoutId,
      p_processed_by: processedBy,
    });
    if (issueErr) return json({ error: issueErr.message }, 500);
    const result = issued as Record<string, any> | null;
    if (!result?.ok) {
      return json({ error: result?.error ?? "receipt_not_issued", status: result?.status ?? null }, 409);
    }

    const receiptCode: string = result.receipt_code;
    const receiptUrl = `${RECEIPT_BASE_URL}/${receiptCode}`;
    const snapshot = (result.snapshot ?? {}) as Record<string, any>;
    const landlordPhone: string | null = result.landlord_phone ?? null;
    const alreadySent: string | null = result.sms_sent_at ?? null;

    const payload = {
      receipt_id: result.receipt_id,
      receipt_code: receiptCode,
      receipt_number: result.receipt_number,
      receipt_url: receiptUrl,
      landlord_phone: landlordPhone,
      snapshot,
    };

    // ── 2. SMS the landlord — exactly once unless a staff resend is requested ──
    if (alreadySent && !resend) {
      return json({ ...payload, sms_sent: false, sms_skipped: "already_sent", sms_sent_at: alreadySent });
    }
    if (!landlordPhone || !isUgandanPhone(landlordPhone)) {
      return json({ ...payload, sms_sent: false, sms_skipped: "no_valid_phone" });
    }

    const receiptNo: string = result.receipt_number ?? "";
    const message =
      `Welile: Dear ${snapshot.landlord_name ?? "Landlord"}, you have received ` +
      `${formatUGX(snapshot.amount)} as rent for ${snapshot.tenant_name ?? "your tenant"}. ` +
      `Processed by ${snapshot.processed_by_name ?? "Welile"} on ${formatDateTime(snapshot.paid_at ?? null)}. ` +
      (receiptNo ? `Receipt No: ${receiptNo} (Code: ${receiptCode}). ` : "") +
      `View your receipt: ${receiptUrl}`;

    let sent = false;
    let smsError: string | null = null;
    try {
      sent = await sendSMS(formatPhoneInternational(landlordPhone), message, {
        admin,
        source: "landlord-rent-receipt",
        reference_id: `${result.receipt_id}${resend ? `-resend-${Date.now()}` : ""}`,
        recipient_name: snapshot.landlord_name ?? null,
      } as any);
    } catch (e) {
      smsError = (e as Error)?.message ?? String(e);
    }

    try {
      await admin.rpc("record_landlord_receipt_sms", {
        p_receipt_id: result.receipt_id,
        p_ok: sent,
        p_error: sent ? null : (smsError ?? "Provider chain did not confirm delivery"),
      });
    } catch (e) {
      console.error("[landlord-rent-receipt] sms bookkeeping failed:", e);
    }

    return json({ ...payload, sms_sent: sent, sms_error: sent ? null : smsError });
  } catch (e) {
    console.error("[landlord-rent-receipt] failed:", e);
    return json({ error: (e as Error)?.message ?? "Unexpected error" }, 500);
  }
});
