import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SITE_NAME = "Welile";
const FROM_DOMAIN = "welile.com";
const SENDER_DOMAIN = "notify.welile.com";

// Generate a cryptographically random 32-byte hex token (mirrors send-transactional-email)
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildAgreementHtml(supporterName: string, acceptDate: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
<tr><td style="background:#1a1a2e;padding:28px 36px;text-align:center;">
  <h1 style="color:#fff;font-size:22px;margin:0 0 6px;">🛡️ Welile</h1>
  <p style="color:#a0a0b0;font-size:13px;margin:0;">Tenant Supporter Agreement — Your Copy</p>
</td></tr>
<tr><td style="padding:28px 36px 12px;">
  <div style="background:#e8f5e9;border-left:4px solid #4caf50;padding:14px 18px;border-radius:6px;margin-bottom:20px;">
    <p style="margin:0;font-size:14px;color:#2e7d32;font-weight:bold;">✅ Agreement Accepted</p>
    <p style="margin:6px 0 0;font-size:13px;color:#388e3c;">Dear ${supporterName}, you accepted the Welile Tenant Supporter Agreement on ${acceptDate}.</p>
  </div>
  <p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 12px;">
    Below is the full copy of the terms and conditions you accepted. Please keep this email for your records.
  </p>
</td></tr>
<tr><td style="padding:0 36px 28px;">
<div style="background:#fafafa;border:1px solid #e0e0e0;border-radius:8px;padding:20px 18px;">
<h2 style="font-size:15px;color:#1a1a2e;margin:0 0 12px;text-align:center;border-bottom:1px solid #e0e0e0;padding-bottom:10px;">
  WELILE TENANT SUPPORTER TERMS & CONDITIONS
</h2>
<p style="font-size:11px;color:#888;text-align:center;margin:0 0 14px;">
  12-Month Agreement • Version v1.0 • Accepted: ${acceptDate}
</p>
<div style="font-size:13px;color:#333;line-height:1.7;">

<p><strong>1. Purpose</strong><br/>
This Agreement governs your participation as a Tenant Supporter on welile.com, where you support verified tenant rent requests by funding rent for verified landlords and houses.</p>

<p><strong>2. Welile's Nature and Role</strong><br/>
Welile Technologies Limited operates welile.com connecting tenants, verified landlords, tenant supporters, and agents/managers. Welile is not a bank, deposit-taking institution, or investment fund.</p>

<p><strong>3. Contract Duration</strong><br/>
This Agreement runs for 12 months from acceptance. Unless renewed, it automatically expires.</p>

<p><strong>4. Supporter Participation</strong><br/>
You may select approved tenant rent requests on your Dashboard. Each includes landlord details, verifications, repayment period, and projected outcomes. Rent is paid upfront for 30, 60, or 90 days.</p>

<p><strong>5. Payment Flow</strong><br/>
Your funds pay rent to verified landlords. Payments may be processed by regulated payment partners. Welile coordinates, monitors, and enforces.</p>

<p><strong>6. Tenant Rights Transfer</strong><br/>
Welile's enforcement is based on contractual Tenant Rights Assignment. When rent is paid, Welile holds tenant rights for the paid period, enabling lawful enforcement and tenant replacement.</p>

<p><strong>7. Repayment Structure</strong><br/>
Tenants repay in small daily instalments through approved channels, including principal, access fees, and registration fees. Monitored by Welile's agent network.</p>

<p><strong>8. Principal Protection & Assurance</strong><br/>
Welile provides a Principal and Outcome Assurance Framework: two-layer verification, structured repayments, field enforcement, and tenant replacement. This is not a deposit, savings product, or regulated security.</p>

<p><strong>9. 90-Day Withdrawal Notice</strong><br/>
To withdraw capital, give 90 days written notice. During this period, Welile coordinates collection. Settlement is arranged at the end based on collected amounts.</p>

<p><strong>10. End of Contract</strong><br/>
At 12-month end, you may renew or request settlement, subject to current repayment cycle completion.</p>

<p><strong>11. Supporter Responsibilities</strong><br/>
Use the platform honestly and lawfully. Avoid direct confrontation with tenants. Follow dispute channels. Comply with KYC procedures.</p>

<p><strong>12. Non-Circumvention</strong><br/>
Do not bypass the platform for direct deals. Circumvention may lead to suspension and loss of protections.</p>

<p><strong>13. Fraud & Suspensions</strong><br/>
Welile may suspend participation for fraud, misrepresentation, abuse, circumvention, or regulatory risk.</p>

<p><strong>14. Dispute Resolution</strong><br/>
Attempt internal resolution first. Unresolved disputes may go to mediation, then Ugandan courts.</p>

<p><strong>15. Limitation of Liability</strong><br/>
Welile is not liable for delays from legal restrictions, court orders, force majeure, or payment partner downtime.</p>

<p><strong>16. Acceptance</strong><br/>
By clicking "I Agree", you confirmed this 12-month Agreement, the 90-day withdrawal notice policy, the Principal and Outcome Assurance Framework, and compliance with these Terms.</p>

</div></div>
</td></tr>
<tr><td style="background:#fafafa;padding:16px 36px;border-top:1px solid #e0e0e0;text-align:center;">
  <p style="font-size:11px;color:#999;margin:0 0 4px;">This is your official record from Welile Technologies Limited.</p>
  <p style="font-size:11px;color:#999;margin:0;">welile.com • Kampala, Uganda</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify caller is authenticated
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const anonClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get profile name
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .single();

    const email = user.email;
    if (!email) {
      return new Response(
        JSON.stringify({ error: "No email on account" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supporterName = profile?.full_name || "Supporter";
    const acceptDate = new Date().toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const html = buildAgreementHtml(supporterName, acceptDate);

    // Build plain text version
    const text = `WELILE TENANT SUPPORTER TERMS & CONDITIONS\n\nDear ${supporterName},\n\nYou accepted the Welile Tenant Supporter Agreement on ${acceptDate}.\n\nThis is your official record. The full terms are available in your Welile dashboard under Settings > Legal.\n\nKey terms:\n- 12-month contract duration\n- 90-day withdrawal notice required\n- Principal & Outcome Assurance Framework\n- Non-circumvention policy\n\nThank you for supporting tenants through Welile.\n\nwelile.com • Kampala, Uganda`;

    const messageId = crypto.randomUUID();

    // Resolve / create unsubscribe token for this recipient (mirrors send-transactional-email).
    // The Lovable email library REQUIRES this on every transactional send.
    const normalizedEmail = email.toLowerCase();
    let unsubscribeToken: string;
    const { data: existingToken } = await supabase
      .from("email_unsubscribe_tokens")
      .select("token, used_at")
      .eq("email", normalizedEmail)
      .maybeSingle();

    if (existingToken && !existingToken.used_at) {
      unsubscribeToken = existingToken.token;
    } else if (!existingToken) {
      unsubscribeToken = generateToken();
      await supabase
        .from("email_unsubscribe_tokens")
        .upsert(
          { token: unsubscribeToken, email: normalizedEmail },
          { onConflict: "email", ignoreDuplicates: true },
        );
      const { data: stored } = await supabase
        .from("email_unsubscribe_tokens")
        .select("token")
        .eq("email", normalizedEmail)
        .maybeSingle();
      unsubscribeToken = stored?.token ?? unsubscribeToken;
    } else {
      // Token exists but already used — recipient has unsubscribed. Skip silently.
      console.log("Supporter agreement skipped — recipient unsubscribed", { email });
      await supabase.from("email_send_log").insert({
        message_id: messageId,
        template_name: "supporter_agreement_copy",
        recipient_email: email,
        status: "suppressed",
      });
      return new Response(
        JSON.stringify({ success: false, reason: "email_suppressed" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Log pending
    await supabase.from("email_send_log").insert({
      message_id: messageId,
      template_name: "supporter_agreement_copy",
      recipient_email: email,
      status: "pending",
      metadata: {
        subject: `✅ Your Supporter Agreement — Accepted ${acceptDate}`,
        from: `Welile Partnerships <partnership@${FROM_DOMAIN}>`,
        reply_to: `partnership@${FROM_DOMAIN}`,
        bcc: `partnership@${FROM_DOMAIN}`,
      },
    });

    // Enqueue via the existing email queue system
    const { error: enqueueError } = await supabase.rpc("enqueue_email", {
      queue_name: "transactional_emails",
      payload: {
        message_id: messageId,
        to: email,
        from: `Welile Partnerships <partnership@${FROM_DOMAIN}>`,
        sender_domain: SENDER_DOMAIN,
        reply_to: `partnership@${FROM_DOMAIN}`,
        // BCC the partnerships mailbox so a filtered copy of every executed
        // agreement lands in the partnership@welile.com folder for records.
        bcc: `partnership@${FROM_DOMAIN}`,
        subject: `✅ Your Supporter Agreement — Accepted ${acceptDate}`,
        html,
        text,
        purpose: "transactional",
        label: "supporter_agreement_copy",
        idempotency_key: `supporter-agreement-${user.id}`,
        unsubscribe_token: unsubscribeToken,
        queued_at: new Date().toISOString(),
      },
    });

    if (enqueueError) {
      console.error("Failed to enqueue agreement email:", enqueueError);
      await supabase.from("email_send_log").insert({
        message_id: messageId,
        template_name: "supporter_agreement_copy",
        recipient_email: email,
        status: "failed",
        error_message: enqueueError.message,
      });
      return new Response(
        JSON.stringify({ error: "Failed to queue email" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Also notify in-app
    await supabase.from("notifications").insert({
      user_id: user.id,
      title: "📧 Agreement Sent to Your Email",
      message: `A copy of your accepted Supporter Agreement (v1.0) has been sent to ${email}. Check your inbox.`,
      type: "agreement_email",
    });

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
