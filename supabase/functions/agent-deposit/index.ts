import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Commission is handled entirely by the credit_agent_rent_commission RPC — no local rate needed

// supabase-js 2.104 collapses untyped tables to `never` for builder calls.
// Use a permissive client alias so .from().insert/update/upsert/.rpc work
// without importing the generated `Database` types in edge functions.
// deno-lint-ignore no-explicit-any
type AdminClient = any;

// Flat 10% commission credit for agent-collection paths that don't go
// through `credit_agent_rent_commission` (no active rent_request, or
// overflow above outstanding balance). Posts an idempotent balanced pair
// using allowlisted ledger categories.
async function creditFlatAgentCommission(
  adminClient: AdminClient,
  agentId: string,
  rentAmount: number,
  contextRef: string,
) {
  const commission = Math.round(rentAmount * 0.10);
  if (commission <= 0) return 0;
  const ref = `agent-collection-comm-${contextRef}`;
  const { error } = await adminClient.rpc('create_ledger_transaction', {
    entries: [
      {
        user_id: agentId,
        amount: commission,
        direction: 'cash_in',
        category: 'agent_commission_earned',
        ledger_scope: 'wallet',
        classification: 'production',
        description: `10% commission on rent collection (${contextRef})`,
        reference_id: ref,
        recipient_type: 'user',
      },
      {
        user_id: agentId,
        amount: commission,
        direction: 'cash_out',
        category: 'marketing_expense',
        ledger_scope: 'platform',
        classification: 'production',
        description: 'Platform marketing expense: 10% rent collection commission',
        reference_id: ref,
      },
    ],
    idempotency_key: ref,
  });
  if (error) {
    // Idempotent retry — duplicate key means we already paid this one
    if (!String(error?.message ?? '').toLowerCase().includes('duplicate')) {
      console.error('[agent-deposit] Flat commission credit failed:', error);
      throw error;
    }
  }
  return commission;
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function ensureWalletExists(adminClient: AdminClient, userId: string) {
  // Only ensures a wallet row exists — balance is managed exclusively by sync_wallet_from_ledger trigger
  const { error } = await adminClient
    .from('wallets')
    .upsert({ user_id: userId, balance: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

  if (error) throw error;
}

async function applyRepaymentForRepayingRequest(
  adminClient: AdminClient,
  tenantId: string,
  rentRequest: { id: string; amount_repaid: number | null; total_repayment: number | null; status: string | null; landlord_id?: string | null; landlords?: { name?: string | null } | null },
  repaymentAmount: number,
) {
  const currentRepaid = toNumber(rentRequest.amount_repaid);
  const totalRepayment = toNumber(rentRequest.total_repayment);
  const appliedAmount = Math.min(repaymentAmount, Math.max(0, totalRepayment - currentRepaid));

  if (appliedAmount <= 0) {
    return {
      appliedAmount: 0,
      updatedAmountRepaid: currentRepaid,
      remainingBalance: Math.max(0, totalRepayment - currentRepaid),
    };
  }

  const updatedAmountRepaid = currentRepaid + appliedAmount;
  const remainingBalance = Math.max(0, totalRepayment - updatedAmountRepaid);
  const nextStatus = updatedAmountRepaid >= totalRepayment ? 'completed' : 'repaying';

  const { error: requestUpdateError } = await adminClient
    .from('rent_requests')
    .update({
      amount_repaid: updatedAmountRepaid,
      status: nextStatus,
      updated_at: new Date().toISOString(),
    })
    .eq('id', rentRequest.id);

  if (requestUpdateError) throw requestUpdateError;

  const { error: repaymentInsertError } = await adminClient
    .from('repayments')
    .insert({
      tenant_id: tenantId,
      rent_request_id: rentRequest.id,
      amount: appliedAmount,
    });

  if (repaymentInsertError) throw repaymentInsertError;

  if (rentRequest.landlord_id) {
    const { error: landlordUpdateError } = await adminClient
      .from('landlords')
      .update({
        rent_balance_due: remainingBalance,
        rent_last_paid_at: new Date().toISOString(),
        rent_last_paid_amount: appliedAmount,
      })
      .eq('id', rentRequest.landlord_id);

    if (landlordUpdateError) throw landlordUpdateError;
  }

  // NOTE: No tenant-wallet ledger leg here. When the agent pays on behalf
  // of the tenant via float, the cash flow is captured by the agent's own
  // ledger entry (`agent_float_used_for_rent`) posted by the caller, plus
  // the landlord credit leg. Posting a tenant cash_out would falsely debit
  // the tenant wallet (and trips the strict insufficient-balance guard
  // when the tenant wallet is empty). Mirrors the non-'repaying' branch
  // which relies on `record_rent_request_repayment` (no ledger insert).

  return { appliedAmount, updatedAmountRepaid, remainingBalance };
}

// Input validation functions
function validateUUID(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned)) return null;
  return cleaned;
}

function validatePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length < 7 || cleaned.length > 20) return null;
  if (!/^[0-9+\-\s()]+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return cleaned;
}

function validateAmount(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    if (isNaN(parsed)) return null;
    value = parsed;
  }
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  if (value > 100000000) return null;
  return Math.round(value);
}

// Normalize phone to match profiles table format
function normalizePhone(phone: string): string[] {
  const digits = phone.replace(/\D/g, '');
  const last9 = digits.slice(-9);
  return [
    `0${last9}`,
    `+256${last9}`,
    `256${last9}`,
  ];
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'No authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } }
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      console.error('[agent-deposit] Auth error:', userError);
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const agentId = user.id;
    
    // Parse and validate request body
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { user_id: rawUserId, amount: rawAmount, user_phone: rawPhone } = body as Record<string, unknown>;

    const userId = rawUserId ? validateUUID(rawUserId) : null;
    const userPhone = rawPhone ? validatePhone(rawPhone) : null;
    const amount = validateAmount(rawAmount);

    if (!userId && !userPhone) {
      return new Response(
        JSON.stringify({ error: 'Either user_id or user_phone is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (amount === null) {
      return new Response(
        JSON.stringify({ error: 'Invalid amount. Must be a positive number up to 100,000,000' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`[agent-deposit] Agent ${agentId} processing deposit for user ${userId || userPhone}, amount: ${amount}`);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Treasury guard: agent deposits credit user wallets — block when paused
    const guardBlock = await checkTreasuryGuard(adminClient, "credit", req.headers.get("Authorization"));
    if (guardBlock) return guardBlock;

    // Verify agent role
    const { data: agentRole } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', agentId)
      .eq('role', 'agent')
      .maybeSingle();

    if (!agentRole) {
      return new Response(
        JSON.stringify({ error: 'Only agents can process deposits' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check agent's FLOAT balance (not total wallet) via split balances RPC
    const { data: splitBalances, error: splitErr } = await adminClient.rpc('get_agent_split_balances', {
      p_agent_id: agentId,
    });

    if (splitErr) {
      console.error('[agent-deposit] Split balance RPC error:', splitErr);
      return new Response(
        JSON.stringify({ error: 'Failed to check agent float balance' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const balRow = Array.isArray(splitBalances) ? splitBalances[0] : splitBalances;
    const agentFloatBalance = Number(balRow?.float_balance ?? 0);
    if (agentFloatBalance < amount) {
      return new Response(
        JSON.stringify({ error: `Insufficient Float Balance. You have UGX ${agentFloatBalance.toLocaleString()} float but need UGX ${amount.toLocaleString()}. Commission cannot be used for rent payments.` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Find user by phone if not provided user_id
    let targetUserId = userId;
    let tenantFullName = '';
    if (!targetUserId && userPhone) {
      // Try multiple phone formats to find the profile
      const phoneVariants = normalizePhone(userPhone);
      let profile = null;
      for (const variant of phoneVariants) {
        const { data } = await adminClient
          .from('profiles')
          .select('id, full_name')
          .eq('phone', variant)
          .maybeSingle();
        if (data) { profile = data; break; }
      }
      
      if (!profile) {
        return new Response(
          JSON.stringify({ error: 'User not found with this phone number' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      targetUserId = profile.id;
      tenantFullName = profile.full_name || '';
    }

    // If we have targetUserId but no name yet, fetch it
    if (targetUserId && !tenantFullName) {
      const { data: tProfile } = await adminClient
        .from('profiles')
        .select('full_name')
        .eq('id', targetUserId)
        .maybeSingle();
      tenantFullName = tProfile?.full_name || '';
    }

    // Get user's wallet
    let { data: userWallet } = await adminClient
      .from('wallets')
      .select('*')
      .eq('user_id', targetUserId)
      .maybeSingle();

    if (!userWallet) {
      const { data: newWallet, error: createError } = await adminClient
        .from('wallets')
        .insert({ user_id: targetUserId, balance: 0 })
        .select()
        .single();

      if (createError) {
        console.error('[agent-deposit] Create wallet error:', createError);
        return new Response(
          JSON.stringify({ error: 'Failed to create wallet' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      userWallet = newWallet;
    }

    // Check if user has active rent request that needs repayment
    // FIX: Check multiple valid statuses, not just 'disbursed'
    const { data: activeRentRequest } = await adminClient
      .from('rent_requests')
      .select('id, total_repayment, amount_repaid, status, landlord_id, created_at, landlords!rent_requests_landlord_id_fkey(id, name, phone, mobile_money_number)')
      .eq('tenant_id', targetUserId)
      .in('status', ['approved', 'funded', 'disbursed', 'repaying'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let depositAmount = amount;
    let repaymentAmount = 0;
    let commission = 0;
    let landlordPayment = 0;
    let actualCommission = 0;

    if (activeRentRequest) {
      const totalRepaid = toNumber(activeRentRequest.amount_repaid);
      const remainingBalance = Math.max(0, toNumber(activeRentRequest.total_repayment) - totalRepaid);

      if (remainingBalance > 0) {
        // Auto-pay towards rent
        repaymentAmount = Math.min(amount, remainingBalance);
        // Commission is credited by the RPC, NOT deducted from the landlord payment
        landlordPayment = repaymentAmount;
        depositAmount = amount - repaymentAmount;

        console.log(`[agent-deposit] Auto-repayment: ${repaymentAmount}, To landlord: ${landlordPayment}`);

        // FIX: Resolve landlord's USER ID via their phone number in profiles
        // landlord_id references the landlords table, not a user profile
        const landlordRecord = activeRentRequest.landlords as any;
        const landlordPhone = landlordRecord?.phone;
        let landlordUserId: string | null = null;

        if (landlordPhone) {
          const landlordPhoneVariants = normalizePhone(landlordPhone);
          for (const variant of landlordPhoneVariants) {
            const { data: landlordProfile } = await adminClient
              .from('profiles')
              .select('id')
              .eq('phone', variant)
              .maybeSingle();
            if (landlordProfile) {
              landlordUserId = landlordProfile.id;
              break;
            }
          }
        }

        if (activeRentRequest.status === 'repaying') {
          await applyRepaymentForRepayingRequest(adminClient, targetUserId!, activeRentRequest as any, repaymentAmount);
        } else {
          // Try the Treasury waterfall first; fall back to legacy repayment so a
          // missing funding-side L7 credit never blocks the tenant's payment.
          try {
            const { error: waterfallError } = await adminClient.rpc('record_rent_request_repayment_v2', {
              p_tenant_id: targetUserId,
              p_amount: repaymentAmount,
              p_source_table: 'agent_deposits',
              p_source_id: crypto.randomUUID(),
            });
            if (waterfallError) throw waterfallError;
            console.log('[agent-deposit] Treasury waterfall recorded for rent request', activeRentRequest.id);
          } catch (waterfallErr: any) {
            console.error('[agent-deposit] Treasury waterfall failed, falling back to legacy repayment:', waterfallErr?.message || waterfallErr);
            const { error: repaymentError } = await adminClient.rpc('record_rent_request_repayment', {
              p_tenant_id: targetUserId,
              p_amount: repaymentAmount,
            });

            if (repaymentError) {
              console.error('[agent-deposit] Repayment RPC error:', repaymentError);
              return new Response(
                JSON.stringify({ error: 'Failed to reduce tenant rent balance' }),
                { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              );
            }
          }

          const { data: verifiedRentRequest, error: verificationError } = await adminClient
            .from('rent_requests')
            .select('amount_repaid')
            .eq('id', activeRentRequest.id)
            .single();

          const expectedAmountRepaid = Math.min(toNumber(activeRentRequest.total_repayment), totalRepaid + repaymentAmount);
          if (verificationError || toNumber(verifiedRentRequest?.amount_repaid) < expectedAmountRepaid) {
            console.error('[agent-deposit] Repayment verification failed:', verificationError, verifiedRentRequest);
            return new Response(
              JSON.stringify({ error: 'Tenant rent balance was not updated correctly' }),
              { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
        }

        // Agent wallet deduction is handled by sync_wallet_from_ledger trigger on ledger insert below
        const { error: agentLedgerError } = await adminClient.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: agentId,
              amount: amount,
              direction: 'cash_out',
              category: 'agent_float_used_for_rent',
              ledger_scope: 'wallet',
              description: `Agent paid UGX ${amount.toLocaleString()} for tenant: ${tenantFullName || 'Unknown'}`,
              currency: 'UGX',
              source_table: 'wallet_deposits',
              linked_party: targetUserId,
              transaction_date: new Date().toISOString(),
            },
            {
              user_id: agentId,
              direction: 'cash_in',
              amount: amount,
              category: 'agent_float_used_for_rent',
              ledger_scope: 'platform',
              description: `Platform receives agent float used for rent`,
              currency: 'UGX',
              source_table: 'wallet_deposits',
              transaction_date: new Date().toISOString(),
            },
          ],
        });

        if (agentLedgerError) {
          console.error('[agent-deposit] Agent ledger insert failed:', agentLedgerError);
          return new Response(
            JSON.stringify({ error: 'Failed to record agent payment audit trail' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Credit agent commission via the single-writer RPC (handles ledger, wallet trigger, sub-agent splits, idempotency)
        const commissionEventRef = `agent-deposit-${activeRentRequest.id}-${Date.now()}`;
        const { data: commissionResult, error: commissionError } = await adminClient.rpc('credit_agent_rent_commission', {
          p_rent_request_id: activeRentRequest.id,
          p_repayment_amount: repaymentAmount,
          p_tenant_id: targetUserId,
          p_event_reference_id: commissionEventRef,
        });

        if (commissionError) {
          console.error('[agent-deposit] Commission RPC error:', commissionError);
          return new Response(
            JSON.stringify({ error: 'Rent balance reduced, but commission credit failed. Please contact support.' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Use actual credited commission from RPC result
        actualCommission = commissionResult?.credited_commission || 0;

        // Path A overflow: if the agent paid MORE than the outstanding rent
        // (e.g. amount=100K but only 60K was owed), the overflow lands in
        // the tenant's wallet but the agent's float was still debited for
        // the full amount. Pay 10% on the overflow too — every shilling the
        // agent moves out of float earns commission.
        if (depositAmount > 0) {
          try {
            const overflowCommission = await creditFlatAgentCommission(
              adminClient,
              agentId,
              depositAmount,
              `${activeRentRequest.id}-overflow-${Date.now()}`,
            );
            actualCommission = (actualCommission || 0) + overflowCommission;
          } catch (e) {
            console.error('[agent-deposit] Path A overflow commission failed:', e);
          }
        }

        // Credit landlord wallet (using resolved user ID)
        if (landlordUserId && landlordPayment > 0) {
          await ensureWalletExists(adminClient, landlordUserId);

          const { error: landlordLedgerError } = await adminClient.rpc('create_ledger_transaction', {
            entries: [
              {
                direction: 'cash_out',
                amount: landlordPayment,
                category: 'wallet_deposit',
                ledger_scope: 'platform',
                description: `Platform pays landlord rent`,
                currency: 'UGX',
                source_table: 'rent_requests',
                source_id: activeRentRequest.id,
                transaction_date: new Date().toISOString(),
              },
              {
                user_id: landlordUserId,
                amount: landlordPayment,
                direction: 'cash_in',
                category: 'wallet_deposit',
                ledger_scope: 'wallet',
                description: `Landlord credit from agent rent payment for UGX ${repaymentAmount.toLocaleString()}`,
                currency: 'UGX',
                source_table: 'rent_requests',
                source_id: activeRentRequest.id,
                linked_party: targetUserId,
                reference_id: activeRentRequest.id,
                transaction_date: new Date().toISOString(),
              },
            ],
          });

          if (landlordLedgerError) {
            console.error('[agent-deposit] Landlord ledger insert failed:', landlordLedgerError);
            return new Response(
              JSON.stringify({ error: 'Failed to record landlord payment audit trail' }),
              { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
        }

        // Notify tenant
        await adminClient
          .from('notifications')
          .insert({
            user_id: targetUserId!,
            title: 'Rent Payment Received! 🏠',
            message: `Your agent paid UGX ${repaymentAmount.toLocaleString()} towards your rent. Remaining: UGX ${Math.max(0, remainingBalance - repaymentAmount).toLocaleString()}.`,
            type: 'success',
            metadata: { amount: repaymentAmount, agent_id: agentId, rent_request_id: activeRentRequest.id },
          });
      }
    }

    if (repaymentAmount === 0) {
      // Agent wallet deduction is handled by sync_wallet_from_ledger trigger on ledger insert below
      const { error: agentLedgerError } = await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: agentId,
            amount: amount,
            direction: 'cash_out',
            category: 'agent_float_used_for_rent',
            ledger_scope: 'wallet',
            description: `Agent paid UGX ${amount.toLocaleString()} for tenant: ${tenantFullName || 'Unknown'}`,
            currency: 'UGX',
            source_table: 'wallet_deposits',
            linked_party: targetUserId,
            transaction_date: new Date().toISOString(),
          },
          {
            user_id: agentId,
            direction: 'cash_in',
            amount: amount,
            category: 'agent_float_used_for_rent',
            ledger_scope: 'platform',
            description: `Platform receives agent float used for rent`,
            currency: 'UGX',
            source_table: 'wallet_deposits',
            transaction_date: new Date().toISOString(),
          },
        ],
      });

      if (agentLedgerError) {
        console.error('[agent-deposit] Agent ledger insert failed:', agentLedgerError);
        return new Response(
          JSON.stringify({ error: 'Failed to record agent payment audit trail' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Path B (no active rent_request): the agent still moved float to a
      // tenant on behalf of rent collection. Credit the same flat 10%
      // commission so we don't silently lose it.
      try {
        actualCommission = await creditFlatAgentCommission(
          adminClient,
          agentId,
          amount,
          `pathB-${targetUserId}-${Date.now()}`,
        );
      } catch (e) {
        console.error('[agent-deposit] Path B commission failed:', e);
      }
    }

    // Add remaining amount to user's wallet
    if (depositAmount > 0) {
      await ensureWalletExists(adminClient, targetUserId!);

      const { error: tenantLedgerError } = await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: agentId,
            direction: 'cash_out',
            amount: depositAmount,
            category: 'wallet_deposit',
            ledger_scope: 'platform',
            description: `Platform credits tenant wallet`,
            currency: 'UGX',
            source_table: 'wallet_deposits',
            source_id: activeRentRequest?.id,
            transaction_date: new Date().toISOString(),
          },
          {
            user_id: targetUserId,
            amount: depositAmount,
            direction: 'cash_in',
            category: 'wallet_deposit',
            ledger_scope: 'wallet',
            description: `Agent deposited UGX ${depositAmount.toLocaleString()} to tenant wallet`,
            currency: 'UGX',
            source_table: 'wallet_deposits',
            source_id: activeRentRequest?.id,
            linked_party: agentId,
            transaction_date: new Date().toISOString(),
          },
        ],
      });

      if (tenantLedgerError) {
        console.error('[agent-deposit] Tenant wallet ledger insert failed:', tenantLedgerError);
        return new Response(
          JSON.stringify({ error: 'Failed to record tenant wallet deposit audit trail' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Record deposit
    const { error: depositRecordError } = await adminClient
      .from('wallet_deposits')
      .insert({
        user_id: targetUserId,
        agent_id: agentId,
        amount: amount,
        deposit_type: 'cash_deposit',
      });

    if (depositRecordError) {
      console.error('[agent-deposit] Deposit record insert failed:', depositRecordError);
      return new Response(
        JSON.stringify({ error: 'Failed to save the agent payment record' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get user profile for response
    const { data: userProfile } = await adminClient
      .from('profiles')
      .select('full_name')
      .eq('id', targetUserId)
      .single();

    console.log(`[agent-deposit] Deposit completed: User ${targetUserId}, Amount: ${amount}, Repayment: ${repaymentAmount}, Commission: ${commission}`);

    // Log system event
    logSystemEvent(adminClient, 'agent_collection', agentId, 'wallet_deposits', targetUserId!, { amount, repayment: repaymentAmount, commission });


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "💰 Agent Deposit", body: "Activity: deposit", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to agent & tenant (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({
        userIds: [agentId],
        payload: { title: "✅ Deposit Recorded", body: `UGX ${amount.toLocaleString()} deposit processed successfully`, url: "/dashboard/agent", type: "success" },
      }),
    }).catch(() => {});
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({
        userIds: [targetUserId],
        payload: { title: "💰 Deposit Received", body: `UGX ${amount.toLocaleString()} deposited to your account`, url: "/dashboard/agent", type: "success" },
      }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        message: 'Deposit completed successfully',
        details: {
          total_deposited: amount,
          auto_repayment: repaymentAmount,
          agent_commission: actualCommission || commission,
          to_landlord: landlordPayment,
          to_wallet: depositAmount,
          user_name: userProfile?.full_name,
        }
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[agent-deposit] Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
