// Daily 1% compounding engine for business advances.
// Idempotent per (advance_id, date) via business_advance_daily_accruals UNIQUE.
// No ledger entries — accrual is non-cash; the new outstanding is what tenants must pay.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkTreasuryGuard } from '../_shared/treasuryGuard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DAILY_RATE = 0.01;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const service = createClient(supabaseUrl, serviceKey);

    const guard = await checkTreasuryGuard(service, 'any');
    if (guard) return guard;

    const today = new Date().toISOString().split('T')[0];

    const { data: advances, error } = await service
      .from('business_advances')
      .select('id, outstanding_balance, last_compounded_date, total_interest_accrued')
      .in('status', ['active'])
      .gt('outstanding_balance', 0);

    if (error) throw error;
    if (!advances || advances.length === 0) {
      return new Response(JSON.stringify({ processed: 0, skipped: 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let processed = 0;
    let skipped = 0;
    const errors: any[] = [];

    for (const adv of advances) {
      try {
        if (adv.last_compounded_date === today) { skipped++; continue; }

        // Days since last compounding (cap at 30 to avoid runaway if cron was down)
        const last = adv.last_compounded_date ? new Date(adv.last_compounded_date) : new Date();
        const now = new Date(today);
        const daysDiff = Math.min(30, Math.max(1, Math.floor((now.getTime() - last.getTime()) / 86_400_000)));

        let opening = Number(adv.outstanding_balance);
        let totalInterest = 0;

        for (let i = 0; i < daysDiff; i++) {
          const interest = Math.round(opening * DAILY_RATE);
          const closing = opening + interest;
          const dt = new Date(last);
          dt.setDate(dt.getDate() + i + 1);
          const dateStr = dt.toISOString().split('T')[0];

          // Idempotent insert
          await service.from('business_advance_daily_accruals').upsert({
            advance_id: adv.id,
            accrual_date: dateStr,
            opening_balance: opening,
            interest_accrued: interest,
            closing_balance: closing,
          }, { onConflict: 'advance_id,accrual_date' });

          totalInterest += interest;
          opening = closing;
        }

        await service.from('business_advances').update({
          outstanding_balance: opening,
          total_interest_accrued: Number(adv.total_interest_accrued || 0) + totalInterest,
          last_compounded_date: today,
          updated_at: new Date().toISOString(),
        }).eq('id', adv.id);

        processed++;
      } catch (e: any) {
        console.error(`[business-advance-compounding] failed for ${adv.id}`, e);
        errors.push({ id: adv.id, error: e.message });
      }
    }

    return new Response(JSON.stringify({ processed, skipped, errors }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[process-business-advance-compounding] error', e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
