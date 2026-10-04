import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const APP_URL = "https://welileapp.com";

async function sendEmail(
  to: string,
  subject: string,
  title: string,
  bodyHtml: string,
): Promise<{ ok: boolean; status: number; raw?: string }> {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const gmailKey = Deno.env.get("GOOGLE_MAIL_API_KEY");
  if (!lovableKey || !gmailKey) {
    console.warn("[notify-tenant-inactive] Gmail creds missing — skipping email");
    return { ok: false, status: 0 };
  }

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#ffffff;padding:24px;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">
    <div style="background:#b91c1c;color:#fff;padding:18px 22px;font-weight:600;font-size:14px;letter-spacing:.3px">WELILE · Tenant Ops Alert</div>
    <div style="padding:22px">
      <h1 style="margin:0 0 12px;font-size:20px;color:#0f172a">${title}</h1>
      ${bodyHtml}
      <a href="${APP_URL}" style="display:inline-block;margin-top:8px;background:#0f172a;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;font-size:14px">Open Tenant Ops</a>
      <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">You're receiving this because you're on the Welile Tenant Ops team.</p>
    </div>
  </div></body></html>`;

  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
  ].join("\r\n");
  const b64 = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const res = await fetch(
    "https://connector-gateway.lovable.dev/google_mail/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": gmailKey,
      },
      body: JSON.stringify({ raw: b64 }),
    },
  );
  const text = await res.text();
  return { ok: res.ok, status: res.status, raw: text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Authenticate caller ---
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const callerId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const rentRequestId: string | undefined = body?.rentRequestId;
    if (!rentRequestId || typeof rentRequestId !== "string") {
      return new Response(JSON.stringify({ error: "rentRequestId is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Load rent request ---
    const { data: rr, error: rrErr } = await admin
      .from("rent_requests")
      .select("id, tenant_id, agent_id, agent_payment_status, agent_payment_status_reason, agent_payment_status_set_by, agent_payment_status_set_at")
      .eq("id", rentRequestId)
      .maybeSingle();
    if (rrErr || !rr) {
      return new Response(JSON.stringify({ error: "RENT_REQUEST_NOT_FOUND" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Only the assigned agent (who set it) should trigger this; ops-set flags are skipped.
    if (rr.agent_payment_status !== "not_paying") {
      return new Response(JSON.stringify({ skipped: "not_inactive" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (rr.agent_payment_status_set_by !== callerId || rr.agent_id !== callerId) {
      return new Response(JSON.stringify({ skipped: "not_agent_initiated" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Dedup: skip if we already alerted for this flag in the last 6h ---
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("type", "tenant_inactive")
      .gte("created_at", sixHoursAgo)
      .contains("metadata", { rent_request_id: rentRequestId })
      .limit(1);
    if (existing && existing.length > 0) {
      return new Response(JSON.stringify({ skipped: "already_alerted" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Names ---
    const { data: tenant } = await admin
      .from("profiles").select("full_name, phone, city").eq("id", rr.tenant_id).maybeSingle();
    const { data: agent } = await admin
      .from("profiles").select("full_name").eq("id", rr.agent_id).maybeSingle();

    const tenantName = tenant?.full_name || "A tenant";
    const agentName = agent?.full_name || "An agent";
    const reason = rr.agent_payment_status_reason || "No reason provided";

    const title = `${tenantName} flagged inactive`;
    const message = `${agentName} marked ${tenantName} as not paying. Reason: ${reason}`;

    // --- Recipients (in-app: all tenant ops; email: dedicated operations team) ---
    const { data: recipients } = await admin.rpc("get_tenant_ops_recipients", { p_email_only: false });
    const list = (recipients ?? []) as Array<{ user_id: string; full_name: string | null; email: string | null; roles: string[] }>;

    // 1) In-app notifications (durable, per-user)
    if (list.length > 0) {
      const rows = list.map((r) => ({
        user_id: r.user_id,
        title,
        message,
        type: "tenant_inactive",
        is_read: false,
        metadata: {
          rent_request_id: rr.id,
          tenant_id: rr.tenant_id,
          tenant_name: tenantName,
          tenant_phone: tenant?.phone ?? null,
          tenant_city: tenant?.city ?? null,
          agent_id: rr.agent_id,
          agent_name: agentName,
          reason,
          url: "/executive",
        },
      }));
      const { error: notifErr } = await admin.from("notifications").insert(rows);
      if (notifErr) console.warn("[notify-tenant-inactive] notif insert failed", notifErr.message);
    }

    // 2) Realtime ops inbox ping (drives the dashboard banner)
    await admin.from("ops_inbox_events").insert({
      scope: "tenant", bucket: "at_risk", delta: 1,
      reason: "agent_marked_inactive", related_id: rr.tenant_id,
    }).then(() => {}, () => {});

    // 3) Push notification (best-effort, cross-page)
    try {
      await admin.functions.invoke("send-push-notification", {
        body: {
          userIds: list.map((r) => r.user_id),
          payload: { title, body: message, url: "/executive", type: "tenant_inactive" },
        },
      });
    } catch (e) {
      console.warn("[notify-tenant-inactive] push failed", (e as Error)?.message);
    }

    // 4) Email — dedicated operations team only (keeps volume sane)
    const emailBody = `
      <p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#334155">
        <strong>${agentName}</strong> has flagged a tenant as <strong>not paying</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px;color:#0f172a">
        <tr><td style="padding:6px 0;color:#64748b;width:120px">Tenant</td><td style="padding:6px 0">${tenantName}</td></tr>
        ${tenant?.phone ? `<tr><td style="padding:6px 0;color:#64748b">Phone</td><td style="padding:6px 0">${tenant.phone}</td></tr>` : ""}
        ${tenant?.city ? `<tr><td style="padding:6px 0;color:#64748b">City</td><td style="padding:6px 0">${tenant.city}</td></tr>` : ""}
        <tr><td style="padding:6px 0;color:#64748b">Flagged by</td><td style="padding:6px 0">${agentName}</td></tr>
      </table>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 14px;margin:0 0 18px">
        <p style="margin:0;font-size:13px;color:#7f1d1d"><strong>Reason:</strong> ${reason}</p>
      </div>`;

    const emailTargets = list.filter(
      (r) => r.roles?.includes("operations") && r.email && /.+@.+\..+/.test(r.email),
    );
    let emailsSent = 0;
    for (const r of emailTargets) {
      try {
        const res = await sendEmail(r.email!, `Tenant flagged inactive: ${tenantName}`, title, emailBody);
        if (res.ok) emailsSent++;
        else console.warn("[notify-tenant-inactive] email failed", r.email, res.status);
      } catch (e) {
        console.warn("[notify-tenant-inactive] email error", r.email, (e as Error)?.message);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, in_app: list.length, emails_sent: emailsSent }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[notify-tenant-inactive] error", (e as Error)?.message);
    return new Response(JSON.stringify({ error: (e as Error)?.message || "unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});