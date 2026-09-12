// Cash deposit — Step 1: generate a one-time receipt code and email it to the
// cash verifier (weliletenants@gmail.com). The verifier reads the code back to
// the depositor (after receiving the cash); the depositor enters it in the app
// to auto-credit their wallet (see cash-deposit-verify-code).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { sha256Hex } from "../_shared/cash-verification-core.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const VERIFIER_EMAIL = "weliletenants@gmail.com";
const GMAIL_GATEWAY = "https://connector-gateway.lovable.dev/google_mail/gmail/v1";

// 4-digit numeric receipt code (0000–9999).
function generateReceiptCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += (b % 10).toString();
  return s;
}

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
  `UGX ${Math.round(n).toLocaleString("en-UG")}`;

// Append an audit-trail event. Never throws — auditing must not break the flow.
async function logEvent(
  admin: ReturnType<typeof createClient>,
  row: {
    verification_id?: string | null;
    deposit_request_id?: string | null;
    user_id?: string | null;
    event_type: string;
    amount?: number | null;
    detail?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  try {
    await admin.from("cash_deposit_verification_events").insert({
      verification_id: row.verification_id ?? null,
      deposit_request_id: row.deposit_request_id ?? null,
      user_id: row.user_id ?? null,
      event_type: row.event_type,
      amount: row.amount ?? null,
      detail: row.detail ?? null,
      metadata: row.metadata ?? {},
    } as any);
  } catch (e) {
    console.error("[cash-request-code] audit log failed", row.event_type, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = authData.user;

    const body = await req.json().catch(() => ({}));
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: "invalid_amount", message: "Enter a valid amount" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // No upper cash deposit limit — deposits of any size are accepted.
    const allowedPurposes = ["personal_deposit", "operational_float", "other"];
    const depositPurpose = allowedPurposes.includes(String(body?.deposit_purpose))
      ? String(body.deposit_purpose) : "personal_deposit";
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 300) : "";

    // Depositor identity for the verifier email.
    const { data: profile } = await admin
      .from("profiles").select("full_name, phone").eq("id", user.id).maybeSingle();
    const depositorName = profile?.full_name || user.email || "Welile user";
    const depositorPhone = (profile as any)?.phone || "—";

    // 1) Create the pending deposit row. transaction_id is a unique, non-secret
    //    placeholder until the code is verified (then it becomes the RCT code).
    const placeholderRef = `CASHREQ-${crypto.randomUUID().slice(0, 18)}`;
    const purposeLabel =
      depositPurpose === "operational_float" ? "Operational Float"
      : depositPurpose === "other" ? "Other" : "Personal Deposit";
    const notes = [`Purpose: ${purposeLabel}`, "Channel: Cash (code verified)", reason]
      .filter(Boolean).join(" | ");

    const { data: inserted, error: insErr } = await admin
      .from("deposit_requests")
      .insert({
        user_id: user.id,
        amount,
        status: "pending",
        provider: "cash_deposit",
        transaction_id: placeholderRef,
        transaction_date: new Date().toISOString(),
        notes,
        deposit_purpose: depositPurpose,
        purpose_audit: {
          chosen_purpose: depositPurpose,
          chosen_at: new Date().toISOString(),
          chosen_by: user.id,
          entry_point: "cash_code_flow",
          // Pre-confirm personal cash deposits so the agent confirmation
          // guard never blocks a self-service cash deposit.
          agent_personal_confirmed_at: new Date().toISOString(),
        },
      } as any)
      .select("id").single();
    if (insErr || !inserted) {
      console.error("[cash-request-code] insert failed", insErr);
      return new Response(JSON.stringify({ error: "create_failed", message: insErr?.message || "Could not start the deposit" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const depositId = (inserted as any).id as string;

    // 2) Generate + hash the receipt code, store the hash.
    const code = generateReceiptCode();
    const codeHash = await sha256Hex(code);
    const { data: verRow, error: vErr } = await admin.from("cash_deposit_verifications").insert({
      deposit_request_id: depositId,
      user_id: user.id,
      amount,
      // Only the hash is stored: the code is never kept in readable form.
      code_hash: codeHash,
      emailed_to: VERIFIER_EMAIL,
      status: "awaiting_code",
    } as any).select("id, max_attempts, expires_at").single();
    if (vErr) {
      console.error("[cash-request-code] verification insert failed", vErr);
      await admin.from("deposit_requests").delete().eq("id", depositId);
      return new Response(JSON.stringify({ error: "create_failed", message: vErr.message }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await logEvent(admin, {
      verification_id: (verRow as any)?.id ?? null,
      deposit_request_id: depositId,
      user_id: user.id,
      event_type: "code_issued",
      amount,
      detail: "Receipt code generated for the Financial Ops Cash Deposit Codes panel (10-minute expiry).",
      metadata: {
        delivery: "fin_ops_panel",
        max_attempts: (verRow as any)?.max_attempts ?? null,
        expires_at: (verRow as any)?.expires_at ?? null,
        deposit_purpose: depositPurpose,
      },
    });

    // 3) No email is sent. The receipt code is surfaced ONLY in the role-gated
    //    Financial Ops "Cash Deposit Codes" panel (fin_ops_recent_cash_codes RPC),
    //    which also removes the self-sent-code ingestion risk entirely.
    return new Response(JSON.stringify({ ok: true, deposit_request_id: depositId, emailed: false }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[cash-request-code] error", e);
    return new Response(JSON.stringify({ error: "server_error", message: String((e as Error)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
