import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // Treasury guard: cron deductions must respect maintenance freeze
    const guardBlock = await checkTreasuryGuard(supabaseAdmin, "any");
    if (guardBlock) return guardBlock;

    const today = new Date().toISOString().split('T')[0];

    // Fetch activated notes where next_deduction_date <= today
    const { data: dueNotes, error: fetchError } = await supabaseAdmin
      .from('promissory_notes')
      .select('*')
      .eq('status', 'activated')
      .not('partner_user_id', 'is', null)
      .lte('next_deduction_date', today);

    if (fetchError) throw fetchError;
    if (!dueNotes || dueNotes.length === 0) {
      return new Response(JSON.stringify({ processed: 0, message: 'No due notes' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let processed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const note of dueNotes) {
      try {
        // Check partner wallet balance
        const { data: wallet } = await supabaseAdmin
          .from('wallets')
          .select('balance')
          .eq('user_id', note.partner_user_id)
          .single();

        if (!wallet || Number(wallet.balance) < Number(note.amount)) {
          skipped++;
          continue; // Insufficient balance, skip
        }

        // Set ledger authorization
        await supabaseAdmin.rpc('set_ledger_authorization');

        // Create ledger transaction: deduct from partner wallet → platform receives
        const idempotencyKey = `promissory-${note.id}-${today}`;
        const entries = [
          {
            user_id: note.partner_user_id,
            amount: Number(note.amount),
            direction: 'cash_out',
            category: 'wallet_deduction',
            description: `Promissory note auto-deduction: ${note.partner_name}`,
            ledger_scope: 'wallet',
            source_table: 'promissory_notes',
            source_id: note.id,
          },
          {
            user_id: note.partner_user_id,
            amount: Number(note.amount),
            direction: 'cash_in',
            category: 'partner_funding',
            description: `Investment from promissory note: ${note.partner_name}`,
            ledger_scope: 'platform',
            source_table: 'promissory_notes',
            source_id: note.id,
          },
        ];

        const { error: ledgerError } = await supabaseAdmin.rpc('create_ledger_transaction', {
          entries,
          idempotency_key: idempotencyKey,
          skip_balance_check: false,
        });

        if (ledgerError) {
          errors.push(`Note ${note.id}: ${ledgerError.message}`);
          continue;
        }

        // Update note: advance next_deduction_date or mark fulfilled
        const newCollected = Number(note.total_collected) + Number(note.amount);
        const updatePayload: any = { total_collected: newCollected };

        if (note.contribution_type === 'once_off') {
          updatePayload.status = 'fulfilled';
        } else {
          // Monthly: advance by 1 month
          const nextDate = new Date(note.next_deduction_date);
          nextDate.setMonth(nextDate.getMonth() + 1);
          updatePayload.next_deduction_date = nextDate.toISOString().split('T')[0];
        }

        await supabaseAdmin
          .from('promissory_notes')
          .update(updatePayload)
          .eq('id', note.id);

        // Log event
        await supabaseAdmin.from('system_events').insert({
          event_type: 'promissory_deduction_processed',
          description: `Auto-deducted ${note.amount} from ${note.partner_name}'s wallet`,
          metadata: {
            note_id: note.id,
            amount: note.amount,
            partner_user_id: note.partner_user_id,
            new_total_collected: newCollected,
          },
        });

        processed++;
      } catch (noteErr: any) {
        errors.push(`Note ${note.id}: ${noteErr.message}`);
      }
    }

    return new Response(JSON.stringify({ processed, skipped, errors, total: dueNotes.length }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
