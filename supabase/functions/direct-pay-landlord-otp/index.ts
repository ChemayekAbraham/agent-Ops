/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * direct-pay-landlord-otp: a Landlord Ops officer, on the phone with the landlord, taps Send OTP.
 *
 * 1. direct_pay_otp_authorize runs WITH THE OFFICER'S TOKEN: Landlord Ops role and staff MFA are checked there.
 * 2. direct_pay_otp_issue (service key only) creates the code, stores its hash and returns the code here.
 * 3. The code goes to the landlord's phone on file through the shared Yoola -> Africa's Talking -> LANA sender,
 *    with delivery confirmation required. The SMS log stores it redacted.
 * 4. direct_pay_otp_mark records whether the send worked.
 * The officer's screen gets only "sent to ***456" and the expiry time, never the code.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { bearerHasSub, noUserResult } from "../_shared/bearerHasSub.ts";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { landlordOtpMessage, maskPhone } from "./otpMessage.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const authHeader = req.headers.get("Authorization");
  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user }, error: authErr } = await (bearerHasSub(authHeader) ? userClient.auth.getUser() : noUserResult());
  if (authErr || !user) return json({ ok: false, code: "not_signed_in" }, 401);

  let paymentId = "";
  try {
    paymentId = String((await req.json())?.payment_id ?? "").trim();
  } catch {
    return json({ ok: false, code: "invalid" }, 400);
  }
  if (!UUID.test(paymentId)) return json({ ok: false, code: "invalid" }, 400);

  // Role + MFA, as the officer.
  const { data: auth, error: authzErr } = await userClient.rpc("direct_pay_otp_authorize", { p_payment_id: paymentId });
  if (authzErr) return json({ ok: false, code: "not_authorized" }, 403);
  if (!auth?.ok) return json(auth ?? { ok: false, code: "not_pending" }, 409);

  const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: issued, error: issueErr } = await admin.rpc("direct_pay_otp_issue", {
    p_staff: user.id, p_payment_id: paymentId,
  });
  if (issueErr || !issued?.ok) return json(issued ?? { ok: false, code: "issue_failed" }, issueErr ? 500 : 409);

  const sent = await sendSMS(issued.recipient_phone, landlordOtpMessage({
    otp: issued.otp, amount: Number(issued.amount), tenantFirstName: issued.tenant_first_name,
  }), {
    admin, source: "direct_pay_landlord_otp", reference_id: issued.challenge_id,
    requireDeliveryConfirmation: true,
  }).catch((e) => {
    console.error("[direct-pay-landlord-otp] send threw:", (e as Error).message);
    return false;
  });
  await admin.rpc("direct_pay_otp_mark", { p_challenge_id: issued.challenge_id, p_sent: sent, p_detail: sent ? null : "sms_not_delivered" });

  return json({
    ok: sent, code: sent ? null : "sms_not_delivered",
    challenge_id: issued.challenge_id, sent_to: maskPhone(issued.recipient_phone), expires_at: issued.expires_at,
  }, sent ? 200 : 502);
});
