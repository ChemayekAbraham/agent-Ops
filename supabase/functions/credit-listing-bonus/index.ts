import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { notifyAgentBonus } from "../_shared/notifyAgentBonus.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Milestone-only policy (2026-07-23, corrected 2026-07-31): the instant
// UGX 1,000 listed-reward stays retired — there is NO instant bonus. The
// house-verification bonus is UGX 2,000, paid once when Landlord Ops verifies
// the house, matching the DB trigger pay_agent_house_verified_bonus.
const LISTING_BONUS = 2000;

// Idempotently marks a listing (and its landlord) verified. Safe to call when
// the bonus was already paid but the listing's `verified` flag was never set —
// which otherwise leaves the listing stuck in the Verification Queue forever.
// Returns true if it actually changed the listing from unverified → verified.
async function ensureVerified(
  adminClient: any,
  listing: { id: string; verified: boolean | null; landlord_id: string | null },
  managerId: string,
): Promise<boolean> {
  if (listing.verified) return false;
  const now = new Date().toISOString();
  await adminClient
    .from("house_listings")
    .update({ verified: true, verified_at: now, verified_by: managerId })
    .eq("id", listing.id);
  if (listing.landlord_id) {
    const { error: llErr } = await adminClient.rpc("service_mark_landlord_verified", {
      p_landlord_id: listing.landlord_id,
      p_manager_id: managerId,
      p_source: "house_verification",
    });
    if (llErr) console.error("[credit-listing-bonus] landlord verify failed:", llErr.message);
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("[credit-listing-bonus] Function invoked");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("authorization") || "";
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !caller) {
      console.error("[credit-listing-bonus] Auth failed:", userErr?.message);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const managerId = caller.id;
    console.log("[credit-listing-bonus] Caller:", managerId);

    const body = await req.json();
    const { listing_id, notes } = body;
    console.log("[credit-listing-bonus] listing_id:", listing_id);

    if (!listing_id || typeof listing_id !== "string") {
      return new Response(JSON.stringify({ error: "listing_id is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // ─── ROLE CHECK FIRST (before any treasury / business logic) ───
    // Accept either:
    //   1. base role in (manager, coo, super_admin, operations, employee, ceo, cfo), OR
    //   2. staff_permissions row with permitted_dashboard='landlord_ops'
    const [roleRes, permRes] = await Promise.all([
      adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", managerId)
        .in("role", ["manager", "coo", "super_admin", "operations", "employee", "ceo", "cfo"])
        .limit(1),
      adminClient
        .from("staff_permissions")
        .select("permitted_dashboard")
        .eq("user_id", managerId)
        .eq("permitted_dashboard", "landlord_ops")
        .limit(1),
    ]);

    console.log(
      "[credit-listing-bonus] Role rows:", JSON.stringify(roleRes.data),
      "Perm rows:", JSON.stringify(permRes.data),
      "RoleErr:", roleRes.error?.message, "PermErr:", permRes.error?.message,
    );

    const hasBaseRole = (roleRes.data?.length ?? 0) > 0;
    const hasLandlordOpsPerm = (permRes.data?.length ?? 0) > 0;

    if (!hasBaseRole && !hasLandlordOpsPerm) {
      return new Response(JSON.stringify({
        error: `Only internal staff can verify listings (user ${managerId} has no operations role or landlord_ops permission)`,
      }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get the listing
    const { data: listing, error: listingErr } = await adminClient
      .from("house_listings")
      .select("id, agent_id, title, listing_bonus_paid, verified, landlord_id")
      .eq("id", listing_id)
      .single();

    if (listingErr || !listing) {
      return new Response(JSON.stringify({ error: "Listing not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotent self-heal: if the bonus was already paid but the listing was
    // never flagged verified (a stuck state that keeps it stuck in the
    // Verification Queue forever), mark it verified now and return success.
    if (listing.listing_bonus_paid) {
      const healed = await ensureVerified(adminClient, listing, managerId);
      return new Response(JSON.stringify({
        success: true,
        message: healed ? "Bonus already paid — listing marked verified" : "Bonus already paid",
        already_paid: true,
        verified_now: healed,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const agentId = listing.agent_id;
    if (!agentId) {
      return new Response(JSON.stringify({ error: "No agent linked to this listing" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if approval already exists
    const { data: existingApproval } = await adminClient
      .from("listing_bonus_approvals")
      .select("id, status")
      .eq("listing_id", listing_id)
      .maybeSingle();

    if (existingApproval) {
      // Already paid → idempotent success (also self-heal verified flag)
      if (existingApproval.status === "paid") {
        await ensureVerified(adminClient, listing, managerId);
        return new Response(JSON.stringify({
          success: true,
          message: "Bonus already paid (idempotent)",
          already_paid: true,
          approval_id: existingApproval.id,
          status: existingApproval.status,
        }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Failed earlier → surface clearly so an admin can clear it via the CFO override
      if (existingApproval.status === "failed") {
        return new Response(JSON.stringify({
          error: "A previous auto-pay attempt failed for this listing. Please review and retry from the CFO bonus queue.",
          approval_id: existingApproval.id,
          status: existingApproval.status,
        }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // pending_credit → STUCK STATE SELF-HEAL.
      // A prior invocation claimed the approval slot but never completed the
      // ledger credit + verification (crash/timeout after the insert). Every
      // retry used to short-circuit here and return "already pending_credit"
      // WITHOUT ever setting verified=true — leaving the listing permanently
      // stuck in the Verification Queue while the UI shows a success toast.
      // Resume the flow: post the ledger (only if it never wrote), promote the
      // approval to paid, and mark the listing + landlord verified.
      if (existingApproval.status === "pending_credit") {
        const now = new Date().toISOString();
        const agentId = listing.agent_id;
        if (!agentId) {
          return new Response(JSON.stringify({ error: "No agent linked to this listing" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Has the ledger already written for this approval? (avoid double-credit)
        const { data: existingLedger } = await adminClient
          .from("general_ledger")
          .select("transaction_group_id")
          .eq("source_table", "listing_bonus_approvals")
          .eq("source_id", existingApproval.id)
          .limit(1);

        let txGroupId: string | null = existingLedger?.[0]?.transaction_group_id ?? null;

        if (!txGroupId) {
          const { data: newTxGroupId, error: ledgerErr } = await adminClient.rpc("create_ledger_transaction", {
            entries: [
              {
                user_id: agentId,
                amount: LISTING_BONUS,
                direction: "cash_in",
                category: "agent_commission_earned",
                ledger_scope: "wallet",
                source_table: "listing_bonus_approvals",
                source_id: existingApproval.id,
                description: `UGX ${LISTING_BONUS.toLocaleString()} house listing bonus — resumed on re-verification`,
                currency: "UGX",
                transaction_date: now,
              },
              {
                direction: "cash_out",
                amount: LISTING_BONUS,
                category: "agent_commission_earned",
                ledger_scope: "platform",
                source_table: "listing_bonus_approvals",
                source_id: existingApproval.id,
                description: "Platform expense: agent listing bonus (resumed on re-verification)",
                currency: "UGX",
                transaction_date: now,
              },
            ],
          });
          if (ledgerErr) {
            await adminClient
              .from("listing_bonus_approvals")
              .update({ status: "failed", rejection_reason: `Ledger write failed on resume: ${ledgerErr.message}` })
              .eq("id", existingApproval.id);
            return new Response(JSON.stringify({
              error: `Ledger credit failed on resume — bonus rolled back: ${ledgerErr.message}`,
              approval_id: existingApproval.id,
              rolled_back: true,
            }), {
              status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          txGroupId = newTxGroupId as string;
        }

        // Promote to paid + apply verification flags (all idempotent).
        await adminClient
          .from("listing_bonus_approvals")
          .update({
            status: "paid",
            cfo_approved_by: managerId,
            cfo_approved_at: now,
            cfo_notes: "Auto-approved on Landlord Ops verification (resumed stuck pending_credit)",
            paid_at: now,
            ledger_entry_id: txGroupId,
          })
          .eq("id", existingApproval.id);

        await ensureVerified(adminClient, listing, managerId);

        await adminClient
          .from("house_listings")
          .update({ listing_bonus_paid: true, listing_bonus_paid_at: now })
          .eq("id", listing_id);

        return new Response(JSON.stringify({
          success: true,
          message: "Stuck verification resumed — listing verified & bonus credited",
          approval_id: existingApproval.id,
          resumed: true,
          tx_group_id: txGroupId,
        }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // pending_cfo / pending_landlord_ops / approved / rejected
      return new Response(JSON.stringify({
        message: `Bonus approval already ${existingApproval.status}`,
        approval_id: existingApproval.id,
        status: existingApproval.status,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();

    // ─── Step 1: Claim the slot (status=pending_credit) BEFORE any side effects ───
    // The unique constraint on (listing_id) makes this our serialization point and
    // also our idempotency key. We do NOT mark anything paid or verified yet.
    const { data: approval, error: approvalErr } = await adminClient
      .from("listing_bonus_approvals")
      .insert({
        listing_id: listing_id,
        agent_id: agentId,
        amount: LISTING_BONUS,
        status: "pending_credit",
        landlord_ops_approved_by: managerId,
        landlord_ops_approved_at: now,
        landlord_ops_notes: notes || `Verified by Landlord Ops`,
      })
      .select("id")
      .single();

    if (approvalErr) {
      // Idempotency: unique-violation on (listing_id) means another concurrent
      // invocation already created the approval row. Treat as already-paid and
      // return the existing record instead of double-crediting the ledger.
      const isUniqueViolation =
        (approvalErr as any).code === "23505" ||
        /duplicate key|unique constraint/i.test(approvalErr.message || "");

      if (isUniqueViolation) {
        const { data: existing } = await adminClient
          .from("listing_bonus_approvals")
          .select("id, status")
          .eq("listing_id", listing_id)
          .maybeSingle();
        console.log(
          `[credit-listing-bonus] Idempotent hit — approval already exists for listing ${listing_id}:`,
          JSON.stringify(existing),
        );
        return new Response(JSON.stringify({
          success: true,
          message: "Bonus already paid (idempotent)",
          already_paid: true,
          approval_id: existing?.id,
          status: existing?.status,
        }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw approvalErr;
    }

    const approvalId = approval!.id;

    // ─── Step 2: Post balanced ledger entries (same legs as approve-listing-bonus) ───
    // If this fails, we mark the approval row as 'failed' and DO NOT touch the
    // listing/landlord verified flags or paid_at — nothing about money or
    // verification appears successful to anyone.
    const { data: txGroupId, error: ledgerErr } = await adminClient.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: agentId,
          amount: LISTING_BONUS,
          direction: "cash_in",
          category: "agent_commission_earned",
          ledger_scope: "wallet",
          source_table: "listing_bonus_approvals",
          source_id: approvalId,
          description: `UGX ${LISTING_BONUS.toLocaleString()} house listing bonus — auto-paid on verification`,
          currency: "UGX",
          transaction_date: now,
        },
        {
          direction: "cash_out",
          amount: LISTING_BONUS,
          category: "agent_commission_earned",
          ledger_scope: "platform",
          source_table: "listing_bonus_approvals",
          source_id: approvalId,
          description: "Platform expense: agent listing bonus (auto-paid on Landlord Ops verification)",
          currency: "UGX",
          transaction_date: now,
        },
      ],
    });

    if (ledgerErr) {
      console.error("[credit-listing-bonus] Ledger write failed:", ledgerErr.message);

      // ─── ROLLBACK: park the approval row as 'failed' so it isn't paid and isn't
      // re-triable via the unique-constraint short-circuit. An admin can clear
      // it manually via approve-listing-bonus or by deleting the failed row.
      const { error: rollbackErr } = await adminClient
        .from("listing_bonus_approvals")
        .update({
          status: "failed",
          rejection_reason: `Ledger write failed: ${ledgerErr.message}`,
        })
        .eq("id", approvalId);

      if (rollbackErr) {
        console.error("[credit-listing-bonus] CRITICAL: rollback marking failed:", rollbackErr.message);
      }

      // Audit the failure for CFO review
      await adminClient.from("audit_logs").insert({
        user_id: managerId,
        action_type: "listing_bonus_auto_pay_failed",
        table_name: "listing_bonus_approvals",
        record_id: approvalId,
        metadata: {
          agent_id: agentId,
          listing_id,
          listing_title: listing.title,
          ledger_error: ledgerErr.message,
          reason: "Ledger write failed; approval rolled back to status=failed; verification flags NOT set",
        },
      });

      return new Response(JSON.stringify({
        error: `Ledger credit failed — bonus rolled back: ${ledgerErr.message}`,
        approval_id: approvalId,
        rolled_back: true,
      }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── Step 3: Ledger succeeded — promote approval to PAID and apply verifications ───
    const { error: promoteErr } = await adminClient
      .from("listing_bonus_approvals")
      .update({
        status: "paid",
        cfo_approved_by: managerId,
        cfo_approved_at: now,
        cfo_notes: "Auto-approved on Landlord Ops verification",
        paid_at: now,
        ledger_entry_id: txGroupId,
      })
      .eq("id", approvalId);

    if (promoteErr) {
      // Ledger already wrote; surface clearly but DO NOT roll back ledger
      // (would require a compensating reversal RPC we don't have). The row
      // stays in pending_credit with a warning log for CFO reconciliation.
      console.error("[credit-listing-bonus] CRITICAL: ledger written but approval not promoted to paid:", promoteErr.message);
      await adminClient.from("audit_logs").insert({
        user_id: managerId,
        action_type: "listing_bonus_promote_to_paid_failed",
        table_name: "listing_bonus_approvals",
        record_id: approvalId,
        metadata: {
          agent_id: agentId,
          tx_group_id: txGroupId,
          promote_error: promoteErr.message,
          reason: "Ledger written; approval row left in pending_credit — needs CFO reconciliation",
        },
      });
    }

    // Mark the listing as verified now that money has actually moved
    await adminClient
      .from("house_listings")
      .update({
        verified: true,
        verified_at: now,
        verified_by: managerId,
      })
      .eq("id", listing_id);

    if (listing.landlord_id) {
      const { error: llErr2 } = await adminClient.rpc("service_mark_landlord_verified", {
        p_landlord_id: listing.landlord_id,
        p_manager_id: managerId,
        p_source: "house_verification",
      });
      if (llErr2) console.error("[credit-listing-bonus] landlord verify failed:", llErr2.message);
    }

    // Step 4: Mark listing as bonus paid
    await adminClient
      .from("house_listings")
      .update({ listing_bonus_paid: true, listing_bonus_paid_at: now })
      .eq("id", listing_id);

    // Step 5: Record in agent_earnings
    await adminClient.from("agent_earnings").insert({
      agent_id: agentId,
      amount: LISTING_BONUS,
      earning_type: "listing_bonus",
      source_user_id: managerId,
      description: "House listing bonus (auto-paid on Landlord Ops verification)",
      currency: "UGX",
    });

    // Step 6: Credit event bonus to commission accrual ledger (best-effort)
    adminClient.rpc("credit_agent_event_bonus", {
      p_agent_id: agentId,
      p_tenant_id: null,
      p_event_type: "house_listed",
      p_source_id: approvalId,
    }).then(({ error: bonusErr }: any) => {
      if (bonusErr) console.error("[credit-listing-bonus] Event bonus ledger error:", bonusErr.message);
    });

    // Step 7: Notify agent — bonus already in wallet (in-app + SMS/WhatsApp)
    await notifyAgentBonus(adminClient, {
      agentId,
      stage: "verified",
      listingTitle: listing.title,
      listingId: listing_id,
      metadata: { approval_id: approvalId, tx_group_id: txGroupId },
    }).catch((e) => console.error("[credit-listing-bonus] notify failed:", e));

    // Audit log
    await adminClient.from("audit_logs").insert({
      user_id: managerId,
      action_type: "listing_bonus_auto_paid",
      table_name: "listing_bonus_approvals",
      record_id: approvalId,
      metadata: {
        agent_id: agentId,
        bonus_amount: LISTING_BONUS,
        listing_title: listing.title,
        tx_group_id: txGroupId,
        reason: "Landlord Ops verified listing — UGX 4,000 auto-credited to agent withdrawable wallet",
      },
    });

    console.log(`[credit-listing-bonus] Listing ${listing.title} verified — UGX ${LISTING_BONUS} auto-credited to agent ${agentId}`);


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "🏡 Listing Bonus Auto-Paid", body: `UGX ${LISTING_BONUS.toLocaleString()} credited to agent`, url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({
      success: true,
      message: "Listing verified — UGX 4,000 credited to agent withdrawable wallet",
      approval_id: approvalId,
      bonus: LISTING_BONUS,
      agent_id: agentId,
      listing_title: listing.title,
      auto_paid: true,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[credit-listing-bonus] Error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
