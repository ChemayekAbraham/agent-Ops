import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { logSystemEvent } from "../_shared/eventLogger.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) throw new Error('No authorization header');

    const { data: { user }, error: authError } = await createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    ).auth.getUser();

    if (authError || !user) throw new Error('Unauthorized');

    const { data: roleData, error: roleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'manager')
      .single();

    if (roleError || !roleData) throw new Error('Only managers can approve loan applications');

    const { applicationId, action, rejectedReason } = await req.json();

    if (!applicationId || !action) throw new Error('Missing required fields');
    if (action !== 'approve' && action !== 'reject') throw new Error('Invalid action');

    const { data: application, error: appError } = await supabase
      .from('loan_applications')
      .select('*')
      .eq('id', applicationId)
      .single();

    if (appError || !application) throw new Error('Loan application not found');
    if (application.status !== 'pending') throw new Error('This application has already been processed');

    if (action === 'reject') {
      const { error: updateError } = await supabase
        .from('loan_applications')
        .update({
          status: 'rejected',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          rejected_reason: rejectedReason || 'Application rejected by manager',
        })
        .eq('id', applicationId);

      if (updateError) throw new Error('Failed to reject application');

      await supabase.from('notifications').insert({
        user_id: application.applicant_id,
        title: 'Loan Application Rejected',
        message: `Your loan application for UGX ${application.amount.toLocaleString()} was rejected. ${rejectedReason || ''}`,
        type: 'warning',
        metadata: { application_id: applicationId },
      });

      return new Response(
        JSON.stringify({ success: true, message: 'Application rejected' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // For approval — use ledger RPC instead of direct wallet mutations
    const now = new Date().toISOString();
    const referenceId = `LOAN-${applicationId.slice(0, 8)}`;

    // Ensure borrower wallet exists
    await supabase
      .from('wallets')
      .upsert({ user_id: application.applicant_id, balance: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

    // Atomic double-entry: agent wallet cash_out → borrower wallet cash_in
    const { error: rpcError } = await supabase.rpc('create_ledger_transaction', {
      entries: [
        {
          user_id: application.agent_id,
          amount: application.amount,
          direction: 'cash_out',
          category: 'wallet_transfer',
          ledger_scope: 'wallet',
          source_table: 'loan_applications',
          source_id: applicationId,
          description: `Loan disbursement to ${application.applicant_id}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: application.applicant_id,
          transaction_date: now,
        },
        {
          user_id: application.applicant_id,
          amount: application.amount,
          direction: 'cash_in',
          category: 'wallet_transfer',
          ledger_scope: 'wallet',
          source_table: 'loan_applications',
          source_id: applicationId,
          description: `Loan received from agent ${application.agent_id}`,
          currency: 'UGX',
          reference_id: referenceId,
          linked_party: application.agent_id,
          transaction_date: now,
        },
      ],
    });

    if (rpcError) {
      console.error('Ledger RPC error:', rpcError);
      throw new Error(rpcError.message || 'Failed to process loan disbursement');
    }

    // Create the user_loan record
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + application.duration_days);

    const { error: loanError } = await supabase.from('user_loans').insert({
      borrower_id: application.applicant_id,
      lender_id: application.agent_id,
      amount: application.amount,
      interest_rate: application.interest_rate,
      total_repayment: application.total_repayment,
      due_date: dueDate.toISOString().split('T')[0],
      status: 'active',
    });

    if (loanError) {
      console.error('Loan creation error:', loanError);
    }

    // Update application status
    await supabase
      .from('loan_applications')
      .update({
        status: 'approved',
        approved_by: user.id,
        approved_at: now,
      })
      .eq('id', applicationId);

    // Notifications
    await Promise.all([
      supabase.from('notifications').insert({
        user_id: application.applicant_id,
        title: 'Loan Approved! 🎉',
        message: `Your loan of UGX ${application.amount.toLocaleString()} has been approved and credited to your wallet.`,
        type: 'success',
        metadata: { application_id: applicationId, amount: application.amount },
      }),
      supabase.from('notifications').insert({
        user_id: application.agent_id,
        title: 'Loan Disbursed',
        message: `UGX ${application.amount.toLocaleString()} has been disbursed from your wallet for an approved loan.`,
        type: 'info',
        metadata: { application_id: applicationId, amount: application.amount },
      }),
    ]);

    console.log('Loan application approved successfully:', applicationId);

    logSystemEvent(supabase, 'loan_approved', user.id, 'loan_applications', applicationId, {
      amount: application.amount, borrower_id: application.applicant_id, lender_id: application.agent_id,
    });

    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "📋 Loan Approved", body: "Activity: loan approved", url: "/dashboard/manager" }),
    }).catch(() => {});

    return new Response(
      JSON.stringify({ success: true, message: 'Loan approved and disbursed' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'An error occurred';
    console.error('Error in approve-loan-application:', message);
    return new Response(
      JSON.stringify({ error: message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
