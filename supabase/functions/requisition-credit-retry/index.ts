import { createClient } from "npm:@supabase/supabase-js@2";
import { creditRequisitionWallet } from "../_shared/requisitionWalletCredit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RetrySource = "director_requisitions" | "employee_requisitions" | "staff_requisitions";

const ALLOWED_ROLES = new Set(["cfo", "super_admin", "manager", "ceo"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const actor = userData.user;

    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", actor.id).eq("enabled", true);
    if (!(roles || []).some((r: { role: string }) => ALLOWED_ROLES.has(r.role))) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => ({}));

    // ── Bulk recovery of stranded requisitions ────────────────────────────
    // Recovers every requisition that is approved/paid but whose wallet credit
    // failed. Fully idempotent: creditRequisitionWallet() reuses the unique
    // requisition_wallet_credits lock row, so an already-credited requisition
    // returns `already_credited` without posting a second ledger transaction.
    if (body?.recover_all === true) {
      const tables: RetrySource[] = [
        "employee_requisitions",
        "director_requisitions",
        "staff_requisitions",
      ];
      const results: unknown[] = [];
      for (const table of tables) {
        // staff_requisitions tracks progress in `stage`, the legacy tables in `status`.
        const approvedColumn = table === "staff_requisitions" ? "stage" : "status";
        const { data: stranded } = await admin
          .from(table)
          .select("*")
          .in(approvedColumn, table === "staff_requisitions" ? ["approved"] : ["approved", "paid"])
          .eq("wallet_credit_status", "failed")
          .limit(50);

        for (const row of stranded || []) {
          const outcome = await recoverOne(admin, table, row, actor.id, req);
          results.push(outcome);
        }
      }
      const recovered = results.filter((r) => (r as { ok?: boolean }).ok).length;
      return json({
        ok: true,
        mode: "recover_all",
        scanned: results.length,
        recovered,
        failed: results.length - recovered,
        message: results.length === 0
          ? "No stranded requisitions found."
          : `Recovered ${recovered} of ${results.length} stranded requisitions.`,
        results,
      }, 200);
    }

    const sourceTable = String(body.source_table || "");
    const requisitionId = String(body.requisition_id || "");
    if (!["director_requisitions", "employee_requisitions", "staff_requisitions"].includes(sourceTable) || !requisitionId) {
      return json({ error: "bad_request" }, 400);
    }

    const { data: row } = await admin.from(sourceTable).select("*").eq("id", requisitionId).maybeSingle();
    if (!row) return json({ error: "Requisition not found" }, 404);

    const result = await recoverOne(
      admin,
      sourceTable as RetrySource,
      row,
      actor.id,
      req,
    );

    return json(result, result.ok ? 200 : 400);
  } catch (e) {
    console.error("requisition-credit-retry error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function recoverOne(
  admin: any,
  sourceTable: RetrySource,
  // deno-lint-ignore no-explicit-any
  row: any,
  actorId: string,
  req: Request,
) {
  let userId = row.requester_id as string | undefined;
  if (sourceTable === "employee_requisitions") {
    const { data: profile } = await admin.from("profiles").select("id").ilike("email", row.employee_email).maybeSingle();
    userId = profile?.id;
  }

  // Guard: if a successful credit already exists, never post a second one.
  const { data: existingCredit } = await admin
    .from("requisition_wallet_credits")
    .select("id, status, wallet_transaction_id")
    .eq("source_table", sourceTable)
    .eq("requisition_id", row.id)
    .maybeSingle();
  if (existingCredit?.status === "credited") {
    return {
      ok: true,
      requisition_id: row.id,
      source_table: sourceTable,
      already_credited: true,
      stage: "already_credited",
      wallet_transaction_id: existingCredit.wallet_transaction_id,
      message: "Already credited — no duplicate credit was posted.",
    };
  }

  const result = await creditRequisitionWallet({
    admin,
    sourceTable,
    requisitionId: row.id,
    requisitionCode: row.requisition_code || String(row.id).slice(0, 8).toUpperCase(),
    userId: userId || "",
    approverId: actorId,
    amount: Number(row.approved_amount ?? row.amount),
    currency: row.currency || "UGX",
    purpose: row.title || row.purpose || "Requisition",
    category: row.category || null,
    status: sourceTable === "staff_requisitions"
      ? (row.stage === "approved" ? "approved" : row.stage)
      : (row.status === "paid" ? "approved" : row.status),
    approvedAt: row.approved_at || row.decided_at,
    ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
    deviceInfo: req.headers.get("user-agent"),

  });

  return { ...result, requisition_id: row.id, source_table: sourceTable };
}
