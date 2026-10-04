import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fmtUGX(n: number) {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Africa/Kampala",
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !userData?.user) return json({ error: "Not authenticated" }, 401);
    const requester = userData.user;

    // Entitlement lives in the database, not in the client.
    const { data: beneficiary } = await admin
      .from("growth_commission_beneficiaries")
      .select("user_id, rate_per_user, active")
      .eq("user_id", requester.id)
      .eq("active", true)
      .maybeSingle();
    if (!beneficiary) {
      return json({ error: "not_entitled", message: "This commission is not available on your account." }, 403);
    }

    // Always compute the window server-side from live data.
    const { data: windowRows, error: winErr } = await admin
      .rpc("growth_commission_next_window", { _user_id: requester.id });
    if (winErr) throw winErr;
    const win = Array.isArray(windowRows) ? windowRows[0] : windowRows;
    if (!win?.eligible) return json({ error: "not_entitled" }, 403);

    const userCount = Number(win.user_count ?? 0);
    const rate = Number(win.rate_per_user ?? beneficiary.rate_per_user);
    const amount = Math.round(userCount * rate);
    if (userCount <= 0 || amount <= 0) {
      return json({
        error: "nothing_to_claim",
        message: "No new platform users have signed up since your last claim.",
      }, 409);
    }

    const { data: profile } = await admin
      .from("profiles").select("full_name, phone").eq("id", requester.id).maybeSingle();
    const requesterName = profile?.full_name || requester.email || "Staff";

    const windowStart = String(win.window_start);
    const windowEnd = String(win.window_end);
    const report = [
      `New platform users: ${userCount.toLocaleString("en-US")}`,
      `Window: ${fmtDate(windowStart)} to ${fmtDate(windowEnd)}`,
      `Rate: ${fmtUGX(rate)} per new platform user`,
      `Total claimed: ${fmtUGX(amount)}`,
    ].join("\n");

    const { data: requisition, error: reqErr } = await admin
      .from("staff_requisitions")
      .insert({
        requester_id: requester.id,
        requester_name: requesterName,
        title: `Growth commission — ${userCount.toLocaleString("en-US")} new platform users`,
        amount,
        reason: report,
        category: "growth_commission",
        // Six eyes: COO -> CEO -> CFO like every other requisition.
        stage: "coo",
        current_approver_role: "coo",
        final_stage: "cfo",
      })
      .select("*")
      .single();
    if (reqErr || !requisition) throw new Error(reqErr?.message || "Failed to raise requisition");

    const { data: claim, error: claimErr } = await admin
      .from("growth_commission_claims")
      .insert({
        user_id: requester.id,
        window_start: windowStart,
        window_end: windowEnd,
        user_count: userCount,
        rate_per_user: rate,
        amount,
        status: "pending",
        requisition_id: requisition.id,
      })
      .select("*")
      .single();
    if (claimErr || !claim) {
      // No orphan requisition without its claim window.
      await admin.from("staff_requisitions").delete().eq("id", requisition.id);
      throw new Error(claimErr?.message || "Failed to record the claim window");
    }

    await admin.from("staff_requisition_events").insert({
      requisition_id: requisition.id,
      actor_id: requester.id,
      actor_name: requesterName,
      action: "created",
      stage: "coo",
      comment: report.slice(0, 2000),
      metadata: {
        source: "growth_commission",
        claim_id: claim.id,
        claim_code: claim.claim_code,
        user_count: userCount,
        rate_per_user: rate,
        window_start: windowStart,
        window_end: windowEnd,
        amount,
      },
    });

    await admin.from("audit_logs").insert({
      user_id: requester.id,
      action_type: "growth_commission_claimed",
      table_name: "growth_commission_claims",
      record_id: claim.id,
      reason: `Claimed ${fmtUGX(amount)} for ${userCount} new platform users`,
    });

    // Notify the COO stage holders (first of the three six-eyes sign-offs).
    try {
      const { data: holders } = await admin
        .from("user_roles").select("user_id").eq("role", "coo").eq("enabled", true).limit(20);
      const ids = (holders || []).map((r: { user_id: string }) => r.user_id);
      if (ids.length) {
        await admin.from("notifications").insert(ids.map((id: string) => ({
          user_id: id,
          type: "staff_requisition",
          title: `Requisition ${requisition.requisition_code} needs your review`,
          message: `${requesterName} • ${fmtUGX(amount)} — growth commission for ${userCount.toLocaleString("en-US")} new platform users`,
          metadata: { requisition_id: requisition.id, stage: "coo", claim_id: claim.id },
        })));
        const { data: phones } = await admin
          .from("profiles").select("id, phone, full_name").in("id", ids);
        for (const p of phones || []) {
          if (!p.phone) continue;
          await sendSMS(
            p.phone,
            `Welile: Requisition ${requisition.requisition_code} — ${fmtUGX(amount)} growth commission (${userCount} new users) awaits your review.`,
            {
              admin,
              source: "growth-commission-claim",
              reference_id: requisition.id,
              recipient_user_id: p.id,
              recipient_name: p.full_name,
              idempotencyKey: `growth-commission-${claim.id}-${p.id}`,
            },
          );
        }
      }
    } catch (e) {
      console.error("CEO notification failed (non-fatal)", e);
    }

    try {
      await admin.from("system_events").insert({
        event_type: "requisition.created",
        payload: {
          source: "growth_commission",
          claim_id: claim.id,
          requisition_id: requisition.id,
          code: requisition.requisition_code,
          amount,
          user_count: userCount,
          window_start: windowStart,
          window_end: windowEnd,
        },
      });
    } catch (_) { /* non-fatal */ }

    return json({ ok: true, claim, requisition }, 200);
  } catch (e) {
    console.error("growth-commission-claim error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
