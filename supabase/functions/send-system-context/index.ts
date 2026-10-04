import { SYSTEM_CONTEXT_MD } from "./doc.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GATEWAY = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";
const SYSTEM_CONTEXT_RECIPIENT = "joshwanda17@gmail.com";

function b64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    if (authError || !authData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roles, error: roleError } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", authData.user.id)
      .eq("enabled", true)
      .in("role", ["manager", "cto", "super_admin"]);
    if (roleError || !roles?.length) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const GOOGLE_MAIL_API_KEY = Deno.env.get("GOOGLE_MAIL_API_KEY");
    if (!LOVABLE_API_KEY || !GOOGLE_MAIL_API_KEY) {
      throw new Error("Gmail connector secrets are not configured");
    }
    const to = SYSTEM_CONTEXT_RECIPIENT;

    const attachment = b64(new TextEncoder().encode(SYSTEM_CONTEXT_MD));
    const boundary = "WELILE_SYSCTX_BOUNDARY";
    const mime = [
      `To: ${to}`,
      "Subject: Welile SYSTEM_CONTEXT.md - canonical system documentation",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Attached is SYSTEM_CONTEXT.md, the canonical Welile platform documentation.",
      "",
      "It covers all 21 sections: system overview, architecture, business processes, financial architecture, wallet engine, advance engine, ROI engine, database documentation, APIs, scheduled jobs, event flow, user roles, UI documentation, administration, security, integrations, monitoring, deployment, known technical debt, roadmap and glossary.",
      "",
      "Welile Reports",
      "",
      `--${boundary}`,
      'Content-Type: text/markdown; charset="UTF-8"; name="SYSTEM_CONTEXT.md"',
      'Content-Disposition: attachment; filename="SYSTEM_CONTEXT.md"',
      "Content-Transfer-Encoding: base64",
      "",
      attachment,
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const raw = b64(new TextEncoder().encode(mime))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

    const res = await fetch(`${GATEWAY}/users/me/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": GOOGLE_MAIL_API_KEY,
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      const details = await res.text();
      console.error(`Gmail send failed [${res.status}]: ${details}`);
      return new Response(JSON.stringify({ error: "Gmail send failed", status: res.status, details }), {
        status: res.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const sent = await res.json();
    return new Response(JSON.stringify({ success: true, to, bytes: SYSTEM_CONTEXT_MD.length, id: sent?.id }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
