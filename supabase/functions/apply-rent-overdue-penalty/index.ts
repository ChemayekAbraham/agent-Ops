import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const PENALTY_RATE = 0.33
const GRACE_DAYS = 30

interface RentRow {
  id: string
  tenant_id: string
  rent_amount: number
  total_repayment: number | null
  amount_repaid: number | null
  duration_days: number
  disbursed_at: string | null
  created_at: string
  schedule_status: string | null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey)

    const now = new Date()
    const result = {
      checked: 0,
      overdue: 0,
      penaltiesApplied: 0,
      totalPenaltyUgx: 0,
      errors: [] as string[],
    }

    const { data: requests, error } = await admin
      .from('rent_requests')
      .select(
        'id, tenant_id, rent_amount, total_repayment, amount_repaid, duration_days, disbursed_at, created_at, schedule_status'
      )
      .eq('status', 'disbursed')

    if (error) throw new Error(`Fetch failed: ${error.message}`)

    for (const r of (requests || []) as RentRow[]) {
      result.checked++
      try {
        const total = Number(r.total_repayment ?? 0)
        const paid = Number(r.amount_repaid ?? 0)
        const outstanding = Math.max(0, total - paid)
        if (outstanding <= 0) continue

        const start = new Date(r.disbursed_at || r.created_at)
        const endMs = start.getTime() + r.duration_days * 86400000
        const overdueMs = now.getTime() - endMs
        if (overdueMs <= 0) continue

        result.overdue++

        // expected_cycles_applied = 1 + floor(daysOverdue / GRACE_DAYS)
        const daysOverdue = Math.floor(overdueMs / 86400000)
        const expectedApplied = 1 + Math.floor(daysOverdue / GRACE_DAYS)

        // Count existing penalty entries for this rent request (platform-scope cash_in)
        const { count: appliedCount } = await admin
          .from('general_ledger')
          .select('id', { count: 'exact', head: true })
          .eq('source_id', r.id)
          .eq('category', 'tenant_default_charge')
          .eq('ledger_scope', 'platform')
          .eq('direction', 'cash_in')

        const already = appliedCount ?? 0
        if (already >= expectedApplied) continue

        const cycleIndex = already + 1
        const penalty = Math.ceil(outstanding * PENALTY_RATE)
        const nowIso = now.toISOString()
        const desc = `Overdue penalty 33% (cycle ${cycleIndex}) on outstanding UGX ${outstanding.toLocaleString()}`

        const { error: ledgerErr } = await admin.rpc('create_ledger_transaction', {
          entries: [
            {
              user_id: r.tenant_id,
              amount: penalty,
              direction: 'cash_in',
              category: 'tenant_default_charge',
              ledger_scope: 'platform',
              classification: 'production',
              source_table: 'rent_requests',
              source_id: r.id,
              description: desc,
              currency: 'UGX',
              transaction_date: nowIso,
            },
            {
              user_id: r.tenant_id,
              amount: penalty,
              direction: 'cash_out',
              category: 'tenant_default_charge',
              ledger_scope: 'bridge',
              classification: 'production',
              source_table: 'rent_requests',
              source_id: r.id,
              description: `Tenant receivable increased by penalty (cycle ${cycleIndex})`,
              currency: 'UGX',
              transaction_date: nowIso,
            },
          ],
        })

        if (ledgerErr) {
          result.errors.push(`${r.id}: ${ledgerErr.message}`)
          continue
        }

        const newTotal = total + penalty
        const newOutstanding = newTotal - paid
        const newDaily = Math.ceil(newOutstanding / GRACE_DAYS)

        await admin
          .from('rent_requests')
          .update({
            total_repayment: newTotal,
            daily_repayment: newDaily,
            schedule_status: 'overdue',
            updated_at: nowIso,
          })
          .eq('id', r.id)

        // Best-effort tenant notification
        await admin.from('notifications').insert({
          user_id: r.tenant_id,
          title: '⚠️ Rent Overdue — 33% Penalty Applied',
          message: `Your rent term expired with UGX ${outstanding.toLocaleString()} outstanding. A 33% penalty of UGX ${penalty.toLocaleString()} has been added. New balance: UGX ${newOutstanding.toLocaleString()}.`,
          type: 'rent_overdue_penalty',
          metadata: {
            rent_request_id: r.id,
            cycle_index: cycleIndex,
            penalty_amount: penalty,
            outstanding_before: outstanding,
            outstanding_after: newOutstanding,
          },
        }).then(() => {}, () => {})

        // Fire-and-forget SMS via existing transactional channel
        fetch(`${supabaseUrl}/functions/v1/send-sms`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            user_id: r.tenant_id,
            message: `Welile: Your rent term expired with UGX ${outstanding.toLocaleString()} unpaid. A 33% penalty of UGX ${penalty.toLocaleString()} has been added. New balance: UGX ${newOutstanding.toLocaleString()}.`,
          }),
        }).catch(() => {})

        result.penaltiesApplied++
        result.totalPenaltyUgx += penalty
      } catch (e: any) {
        result.errors.push(`${r.id}: ${e.message}`)
      }
    }

    console.log('[apply-rent-overdue-penalty]', result)

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (e: any) {
    console.error('[apply-rent-overdue-penalty] error', e)
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
