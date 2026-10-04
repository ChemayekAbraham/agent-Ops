import "../_shared/smsFooterInterceptor.ts";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type Row = { name: string; phone: string; amount: number; tid: string };

function formatUGX(n: number) {
  return `UGX ${n.toLocaleString('en-US')}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const rows: Row[] = Array.isArray(body?.rows) ? body.rows : [];
    const results: any[] = [];
    for (const r of rows) {
      const firstName = (r.name || '').split(/\s+/)[0] || 'Agent';
      const msg =
        `Hi ${firstName}, your float deposit of ${formatUGX(r.amount)} (TID ${r.tid}) has been recovered and credited to your Welile wallet. ` +
        `Sorry for the delay — it was caused by an SMS-to-email bridge gap. Your float balance is now up to date.`;
      const ok = await sendSMS(r.phone, msg, {
        user_id: null,
        category: 'recovery_notice',
        template: 'float_recovery',
        reference: r.tid,
      } as any);
      results.push({ phone: r.phone, tid: r.tid, ok });
    }
    return new Response(JSON.stringify({ sent: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});