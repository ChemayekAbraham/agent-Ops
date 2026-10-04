/**
 * SMS notice for a withdrawal-number change decision.
 *
 * Called right after Financial Ops approves or rejects a request in
 * `payout_number_change_requests`. It re-reads the decision from the database —
 * the caller cannot dictate the outcome or the wording — and texts the person
 * who asked for the change. No wallet, ledger or request state is touched here.
 */
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DECIDER_ROLES = ["financial_ops", "cfo", "super_admin", "manager"];

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function last4(n: string | null): string {
  const d = (n ?? "").replace(/[^0-9]/g, "");
  return d.length >= 4 ? d.slice(-4) : d || "----";
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-payout-number-change" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[notify-payout-number-change] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const body = new URLSearchParams({
    username,
    from: "WELILE",
    to: formatPhoneInternational(phone),
    message,
  });
  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", apiKey, Accept: "application/json" },
      body: body.toString(),
    });
    const raw = await res.text();
    console.log(`[notify-payout-number-change] AT response (${res.status}):`, raw);
    const data = JSON.parse(raw);
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: { statusCode?: number }) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[notify-payout-number-change] AT error", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id);
    const allowed = (roles ?? []).some((r: { role: string }) => DECIDER_ROLES.includes(r.role));
    if (!allowed) return json({ error: "Forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const requestId = typeof body?.requestId === "string" ? body.requestId : null;
    if (!requestId) return json({ error: "requestId is required" }, 400);

    // The database is the only source of the outcome.
    const { data: reqRow, error: reqErr } = await admin
      .from("payout_number_change_requests")
      .select("id, user_id, requested_number, status, decision_reason")
      .eq("id", requestId)
      .maybeSingle();
    if (reqErr) return json({ error: reqErr.message }, 500);
    if (!reqRow) return json({ error: "Request not found" }, 404);
    if (reqRow.status !== "approved" && reqRow.status !== "rejected") {
      return json({ error: "No decision on this request yet" }, 409);
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("phone, full_name")
      .eq("id", reqRow.user_id)
      .maybeSingle();
    const phone = (profile?.phone ?? "").trim();
    if (!phone) return json({ success: false, message: "No phone number on the account" });

    const tail = last4(reqRow.requested_number);
    const reason = (reqRow.decision_reason ?? "").trim();
    const message =
      reqRow.status === "approved"
        ? `Welile: Your withdrawal number has been changed to the number ending ${tail}. ` +
          `Your payouts will now be sent there. If you did not ask for this, call Welile Support on 0748747134 immediately.`
        : `Welile: Your request to change your withdrawal number to the one ending ${tail} was not approved. ` +
          `${reason ? `Reason: ${reason}. ` : ""}Your current withdrawal number stays the same. ` +
          `For help, call Welile Support on 0748747134.`;

    const sent = await sendSMS(phone, message);
    return json({ success: sent, status: reqRow.status });
  } catch (err) {
    console.error("[notify-payout-number-change] error", err);
    return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
  }
});
