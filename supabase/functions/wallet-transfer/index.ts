import "../_shared/smsFooterInterceptor.ts";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { runShadowAudit } from "../_shared/shadowLogger.ts";
import { shadowValidateWalletTransfer } from "../_shared/shadowValidation.ts";
import { fetchShadowConfig, shouldSample } from "../_shared/shadowConfig.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

const toBareDigits = (p: string) => formatPhoneInternational(p).replace(/^\+/, "");

// === SMS provider chain: Yoola (primary) -> Africa's Talking -> LANA ===
// Mirrors the shared chain used across the platform so a single provider
// running out of credit never blocks delivery.
async function sendViaYoola(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
  if (!apiKey) return false;
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: toBareDigits(phone), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? "").toLowerCase();
    if (res.ok && (status === "success" || status === "ok" || status === "sent" || status === "queued")) return true;
    if (res.ok && !data?.error && status === "") return true;
    return false;
  } catch {
    return false;
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) return false;
  const isSandbox = username.toLowerCase() === "sandbox";
  const url = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const params = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });
    const data = await res.json().catch(() => null);
    const recipients = data?.SMSMessageData?.Recipients;
    if (recipients && recipients.length > 0) {
      const s = recipients[0].statusCode;
      return s === 100 || s === 101 || s === 102;
    }
    return false;
  } catch {
    return false;
  }
}

async function sendViaLana(phone: string, message: string): Promise<boolean> {
  const apiKey = Deno.env.get("LANA_SMS_API_KEY")?.trim();
  if (!apiKey) return false;
  try {
    const res = await fetch("https://api.lanasms.com/v1/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ phone: toBareDigits(phone), sender_id: "WELILE", message}),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const raw = data?.status;
    const s = String(raw ?? "").toLowerCase();
    return res.ok && (raw === true || s === "success" || s === "true" || s === "ok" || s === "sent" || s === "queued");
  } catch {
    return false;
  }
}

async function sendSMS(phone: string, message: string): Promise<void> {
  const formatted = formatPhoneInternational(phone);
  if (!formatted) return;
  try {
    if (await sendViaYoola(phone, message)) return;
    if (await sendViaAfricasTalking(phone, message)) return;
    await sendViaLana(phone, message);
  } catch (err) {
    console.error("[wallet-transfer] SMS send failed:", err);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const adminClient = createClient(supabaseUrl, supabaseServiceKey);

  // Treasury guard: block any money movement when paused
  // Wallet-to-wallet transfer is a debit from the sender — gate under the
  // same "debit" scope as withdrawals so Wallet Ops Maintenance freezes it.
  const guardBlock = await checkTreasuryGuard(adminClient, "debit", req.headers.get("Authorization"));
  if (guardBlock) return guardBlock;

  const shadowConfig = await fetchShadowConfig(adminClient);

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'No authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { recipient_id, recipient_phone, amount, description, transfer_kind } = body as {
      recipient_id?: string;
      recipient_phone?: string;
      amount?: number;
      description?: string;
      transfer_kind?: string;
    };

    // === Internal (server-to-server) path ===
    // The scheduled auto-payout runner has no end-user JWT. It presents the
    // service-role key and names the wallet owner it is acting for. Every
    // gate below still runs exactly as for an interactive transfer.
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    const internalActorId = (body as { internal_actor_id?: string }).internal_actor_id;
    const isInternal =
      bearer === supabaseServiceKey &&
      typeof internalActorId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(internalActorId);

    let senderId: string;
    if (isInternal) {
      senderId = internalActorId!;
    } else {
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } }
      });

      const { data: { user }, error: userError } = await userClient.auth.getUser();
      if (userError || !user) {
        console.error('Auth error:', userError);
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      senderId = user.id;
    }


    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    
    // Resolve recipient by ID or phone number
    let resolvedRecipientId = recipient_id;
    
    if (!resolvedRecipientId && recipient_phone) {
      const cleaned = recipient_phone.replace(/\D/g, '');
      const last9 = cleaned.slice(-9);
      
      if (last9.length < 9) {
        if (shouldSample(shadowConfig)) {
          runShadowAudit('wallet-transfer', { senderId, amount }, false,
            () => shadowValidateWalletTransfer({ senderId, recipientId: '', amount: amount ?? 0, description: '' }), adminClient);
        }
        return new Response(
          JSON.stringify({ error: 'Invalid phone number' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { data: profiles, error: lookupError } = await adminClient
        .from('profiles')
        .select('id, full_name')
        .ilike('phone', `%${last9}`)
        .limit(1);

      if (lookupError || !profiles || profiles.length === 0) {
        return new Response(
          JSON.stringify({ error: 'Recipient not found. They must have a Welile account.' }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
      resolvedRecipientId = profiles[0].id;
    }

    if (!resolvedRecipientId || !UUID_REGEX.test(resolvedRecipientId)) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('wallet-transfer', { senderId, amount }, false,
          () => shadowValidateWalletTransfer({ senderId, recipientId: resolvedRecipientId ?? '', amount: amount ?? 0, description: '' }), adminClient);
      }
      return new Response(
        JSON.stringify({ error: 'Invalid recipient' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('wallet-transfer', { senderId, resolvedRecipientId, amount }, false,
          () => shadowValidateWalletTransfer({ senderId, recipientId: resolvedRecipientId, amount: amount ?? 0, description: '' }), adminClient);
      }
      return new Response(
        JSON.stringify({ error: 'Amount must be between 1 and 100,000,000' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // === Agent daily-collection performance gate ===
    // Mirrors the withdrawal trigger `enforce_agent_perf_withdrawal`: an agent
    // with active tenants whose today's collection ratio is under 20% may not
    // move money out of their wallet — including wallet-to-wallet transfers.
    // Merchant / proxy / cashout agent debits are exempt (matches withdraw).
    try {
      const { data: gateDisabled } = await adminClient.rpc('is_agent_perf_gate_disabled' as never);
      if (!gateDisabled) {
        const [{ data: rolesRows }, { data: cashoutRow }, { data: proxyRow }] = await Promise.all([
          adminClient.from('user_roles').select('role').eq('user_id', senderId),
          adminClient.from('cashout_agents').select('agent_id').eq('agent_id', senderId).eq('is_active', true).maybeSingle(),
          adminClient.from('proxy_agent_assignments').select('agent_id').eq('agent_id', senderId).eq('is_active', true).maybeSingle(),
        ]);
        const roles = (rolesRows ?? []).map((r: { role: string }) => r.role);
        const isAgent = roles.includes('agent') || roles.includes('senior_agent');
        const isMerchant = !!cashoutRow;
        const isProxy = !!proxyRow;
        if (isAgent && !isMerchant && !isProxy) {
          const { data: perf } = await adminClient
            .from('v_agent_daily_eligibility')
            .select('active_count, expected_daily, today_pct')
            .eq('agent_id', senderId)
            .maybeSingle();
          if (perf && Number(perf.active_count) > 0 && Number(perf.expected_daily) > 0) {
            const pct = Number(perf.today_pct ?? 0) * 100;
            if (pct < 20) {
              return new Response(
                JSON.stringify({
                  error: `Transfers disabled: today's collection performance is ${pct.toFixed(1)}% (min 20%). Collect from your tenants first.`,
                }),
                { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
              );
            }
          }
        }
      }
    } catch (e) {
      console.warn('[wallet-transfer] perf gate check failed (allowing):', e);
    }

    const safeDescription = typeof description === 'string' ? description.trim().slice(0, 500) : 'Wallet transfer';

    // === Canonical descriptions per transfer kind ===
    // For Welile Bread transfers we OVERRIDE the client-supplied description on
    // BOTH legs so that sender and receiver wallet statements stay perfectly
    // consistent regardless of what the client sent.
    const isWelileBread = transfer_kind === 'welile_bread';
    const formattedAmount = `UGX ${Number(amount).toLocaleString('en-US')}`;
    // Optional Welile Bread quantity. Server trusts amount for the actual
    // value moved, but uses qty (when provided & valid) to render the
    // canonical statement description ("4 Welile breads of UGX 26,000").
    const breadQtyRaw = (body as { bread_qty?: number }).bread_qty;
    const breadQty =
      isWelileBread &&
      typeof breadQtyRaw === 'number' &&
      Number.isFinite(breadQtyRaw) &&
      breadQtyRaw >= 1 &&
      breadQtyRaw <= 100
        ? Math.floor(breadQtyRaw)
        : 1;
    const breadNoun = breadQty === 1 ? 'Welile bread' : `Welile breads`;
    const breadPrefix = isWelileBread && breadQty > 1 ? `${breadQty} ` : '';
    // Was a real reason supplied, or just the default placeholder? Used to
    // decide whether to append " — <reason>" to the statement descriptions.
    const trimmedReason = (safeDescription || '').trim();
    const hasReason =
      trimmedReason.length > 0 &&
      trimmedReason.toLowerCase() !== 'wallet transfer';
    // NOTE: senderDescription / recipientDescription are built AFTER the
    // counterparty profiles are resolved (further down) so the receiver sees
    // the SENDER'S NAME + reason and the sender sees the RECIPIENT'S name.

    // === Stable, human-readable transfer reference ===
    // Persisted on BOTH ledger legs (reference_id) and returned to the
    // client so receipts, audits and customer support all share the same
    // identifier. Format:
    //   WB-XXXXXXXX  — Welile Bread
    //   WT-XXXXXXXX  — Generic wallet transfer
    // The 8-char suffix is a base32 crockford-style slice of a random UUID
    // so it's URL-safe and easy to read on a phone screen.
    const refPrefix = isWelileBread ? 'WB' : 'WT';
    const refSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    const transferReference = `${refPrefix}-${refSuffix}`;

    // Debug log removed for cost optimization

    if (senderId === resolvedRecipientId) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('wallet-transfer', { senderId, resolvedRecipientId, amount }, false,
          () => shadowValidateWalletTransfer({ senderId, recipientId: resolvedRecipientId, amount, description: safeDescription }), adminClient);
      }
      return new Response(
        JSON.stringify({ error: 'Cannot transfer to yourself' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Anti-fraud gate: person-to-person wallet transfers require the sender
    // to have at least 7 approved deposits on record. Merchant flows that
    // route through wallet-transfer (e.g. Welile Bread) are exempt.
    const MIN_APPROVED_DEPOSITS = 7;
    if (!isWelileBread) {
      const { count: approvedDeposits, error: depositCountError } = await adminClient
        .from('deposit_requests')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', senderId)
        .eq('status', 'approved');

      if (depositCountError) {
        console.error('deposit count lookup failed', depositCountError);
        return new Response(
          JSON.stringify({ error: 'Could not verify your deposit history. Please try again.' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const depositsSoFar = approvedDeposits ?? 0;
      if (depositsSoFar < MIN_APPROVED_DEPOSITS) {
        return new Response(
          JSON.stringify({
            error:
              `To help prevent fraud, sending money to another user is unlocked after ` +
              `${MIN_APPROVED_DEPOSITS} approved deposits. You currently have ` +
              `${depositsSoFar}/${MIN_APPROVED_DEPOSITS}. Make a few more deposits and try again.`,
            code: 'insufficient_deposit_history',
            deposits_completed: depositsSoFar,
            deposits_required: MIN_APPROVED_DEPOSITS,
          }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Shadow audit on success path — sampled
    if (shouldSample(shadowConfig)) {
      runShadowAudit('wallet-transfer', { senderId, resolvedRecipientId, amount },
        true, () => shadowValidateWalletTransfer({ senderId, recipientId: resolvedRecipientId, amount, description: safeDescription }), adminClient);
    }

    // Look up counterparty names so each leg's `linked_party` shows the
    // OTHER side of the transfer in the wallet statement (matching how
    // every other wallet transfer is presented in the ledger).
    const { data: parties } = await adminClient
      .from('profiles')
      .select('id, full_name, phone')
      .in('id', [senderId, resolvedRecipientId]);
    const senderProfile = parties?.find((p) => p.id === senderId);
    const recipientProfile = parties?.find((p) => p.id === resolvedRecipientId);
    const senderLabel =
      senderProfile?.full_name?.trim() || senderProfile?.phone || 'Welile user';
    const recipientLabel =
      recipientProfile?.full_name?.trim() || recipientProfile?.phone || 'Welile user';

    // === Statement descriptions (now that we know both names) ===
    // Receiver's wallet statement shows WHO sent it + WHY. Sender's shows
    // WHO received it + WHY. Reason is only appended when meaningfully set.
    const senderDescription = isWelileBread
      ? `You have sent ${breadPrefix}${breadNoun} of ${formattedAmount} to ${recipientLabel}`
      : hasReason
        ? `Transfer to ${recipientLabel}: ${trimmedReason}`
        : `Transfer to ${recipientLabel}`;
    const recipientDescription = isWelileBread
      ? `You have received ${breadPrefix}${breadNoun} of ${formattedAmount} from ${senderLabel}`
      : hasReason
        ? `Transfer from ${senderLabel}: ${trimmedReason}`
        : `Transfer from ${senderLabel}`;

    // Pre-check sender balance — STRICT withdrawable only.
    // Wallet transfers move money out of the withdrawable bucket
    // (recipient_type: 'user'). Operational float is company money and is
    // NEVER transferable, so we gate on the canonical strict figure
    // `get_user_available_balance` (cache + ledger + holds, capped) instead
    // of the raw cached total. This prevents a float-only user from passing
    // the pre-check only to hit a cryptic ledger rejection downstream.
    const { data: availableRaw, error: availableError } = await adminClient.rpc(
      'get_user_available_balance',
      { p_user_id: senderId },
    );
    if (availableError) {
      console.error('Available-balance RPC error:', availableError);
      return new Response(
        JSON.stringify({ error: 'Could not verify your balance. Please try again.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const withdrawable = Number(availableRaw ?? 0);

    if (withdrawable < amount) {
      return new Response(
        JSON.stringify({
          error: `Insufficient transferable balance. Available to send: UGX ${withdrawable.toLocaleString('en-US')}. Operational float cannot be transferred.`,
        }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Ensure recipient wallet exists
    await adminClient
      .from('wallets')
      .upsert({ user_id: resolvedRecipientId, balance: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

    // === SINGLE-WRITER: Route through create_ledger_transaction RPC ===
    const { data: txGroupId, error: ledgerError } = await adminClient.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: senderId,
          amount,
          direction: 'cash_out',
          category: 'wallet_transfer',
          ledger_scope: 'wallet',
          source_table: 'wallet_transactions',
          description: senderDescription,
          currency: 'UGX',
          transaction_date: new Date().toISOString(),
          reference_id: transferReference,
          linked_party: recipientLabel,
          recipient_type: 'user',
          wallet_bucket: 'withdrawable',
        },
        {
          user_id: resolvedRecipientId,
          amount,
          direction: 'cash_in',
          category: 'wallet_transfer',
          ledger_scope: 'wallet',
          source_table: 'wallet_transactions',
          description: recipientDescription,
          currency: 'UGX',
          transaction_date: new Date().toISOString(),
          reference_id: transferReference,
          linked_party: senderLabel,
          recipient_type: 'user',
          wallet_bucket: 'withdrawable',
        },
      ],
      idempotency_key: transferReference,
    });

    if (ledgerError) {
      console.error('Ledger RPC error:', ledgerError);
      return new Response(
        JSON.stringify({ error: 'Transfer failed. Please try again.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Post-check: verify sender balance didn't go negative (trigger enforces CHECK >= 0)
    const { data: senderAfter } = await adminClient
      .from('wallets')
      .select('balance')
      .eq('user_id', senderId)
      .single();

    if (senderAfter && senderAfter.balance < 0) {
      // This shouldn't happen due to CHECK constraint, but defensive rollback
      console.error(`Sender balance went negative after transfer: ${senderAfter.balance}`);
      return new Response(
        JSON.stringify({ error: 'Transfer failed due to insufficient balance' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Success logged via system event only

    // Log system event
    logSystemEvent(adminClient, 'wallet_transfer', senderId, 'wallets', txGroupId, {
      amount,
      recipient_id: resolvedRecipientId,
      transfer_reference: transferReference,
      transfer_kind: isWelileBread ? 'welile_bread' : 'wallet_transfer',
    });


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "💳 Wallet Transfer", body: "Activity: wallet transfer", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to sender & recipient (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({
        userIds: [senderId],
        payload: { title: "✅ Transfer Sent", body: `UGX ${amount.toLocaleString()} sent successfully`, url: "/dashboard/tenant", type: "success" },
      }),
    }).catch(() => {});
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({
        userIds: [resolvedRecipientId],
        payload: {
          title: "💰 Transfer Received",
          body: hasReason
            ? `UGX ${amount.toLocaleString()} from ${senderLabel} — ${trimmedReason}`
            : `UGX ${amount.toLocaleString()} received from ${senderLabel}`,
          url: "/dashboard/tenant",
          type: "success",
        },
      }),
    }).catch(() => {});

    // SMS to recipient: amount received + sender + new wallet balance + app link
    // (fire-and-forget). Uses the Yoola -> Africa's Talking -> LANA chain above.
    if (recipientProfile?.phone) {
      // Fetch the recipient's up-to-date wallet balance to show "new balance".
      let recipientBalanceText = '';
      try {
        const { data: recipientWallet } = await adminClient
          .from('wallets')
          .select('balance')
          .eq('user_id', resolvedRecipientId)
          .single();
        if (recipientWallet && Number.isFinite(Number(recipientWallet.balance))) {
          recipientBalanceText =
            ` New balance: UGX ${Number(recipientWallet.balance).toLocaleString('en-US')}.`;
        }
      } catch { /* balance is best-effort */ }

      const appLink = 'https://welileapp.com/dashboard';
      const smsMessage =
        `WELILE: You have received ${formattedAmount} from ${senderLabel}.` +
        ` Reason: ${trimmedReason || 'Wallet transfer'}.` +
        recipientBalanceText +
        ` Ref: ${transferReference}. Open the app: ${appLink}`;
      sendSMS(recipientProfile.phone, smsMessage).catch(() => {});
    }

    // SMS to sender: transfer confirmation + new balance + app link
    if (senderProfile?.phone) {
      let senderBalanceText = '';
      try {
        const { data: senderWallet } = await adminClient
          .from('wallets')
          .select('balance')
          .eq('user_id', senderId)
          .single();
        if (senderWallet && Number.isFinite(Number(senderWallet.balance))) {
          senderBalanceText =
            ` New balance: UGX ${Number(senderWallet.balance).toLocaleString('en-US')}.`;
        }
      } catch { /* balance is best-effort */ }

      const appLink = 'https://welileapp.com/dashboard';
      const senderSmsMessage =
        `WELILE: You have sent ${formattedAmount} to ${recipientLabel}.` +
        ` Reason: ${trimmedReason || 'Wallet transfer'}.` +
        senderBalanceText +
        ` Ref: ${transferReference}. View transaction: ${appLink}`;
      sendSMS(senderProfile.phone, senderSmsMessage).catch(() => {});
    }


    return new Response(
      JSON.stringify({
        success: true,
        message: 'Transfer completed successfully',
        transfer_reference: transferReference,
        reference: transferReference,
        transaction_group_id: txGroupId,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Unexpected error:', error);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
