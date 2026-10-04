import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RentRequest {
  id: string;
  tenant_id: string;
  rent_amount: number;
  total_repayment: number;
  daily_repayment: number;
  duration_days: number;
  disbursed_at: string | null;
  created_at: string;
  tenant?: {
    full_name: string;
  };
}

interface Repayment {
  amount: number;
  rent_request_id: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date();
    const results = {
      checked: 0,
      behindSchedule: 0,
      notificationsSent: 0,
      errors: [] as string[],
    };

    // Get all active (disbursed) rent requests
    const { data: activeRequests, error: fetchError } = await supabase
      .from('rent_requests')
      .select(`
        id,
        tenant_id,
        rent_amount,
        total_repayment,
        daily_repayment,
        duration_days,
        disbursed_at,
        created_at,
        tenant:profiles!rent_requests_tenant_id_fkey(full_name)
      `)
      .eq('status', 'disbursed');

    if (fetchError) {
      throw new Error(`Failed to fetch active requests: ${fetchError.message}`);
    }

    console.log(`Found ${activeRequests?.length || 0} active rent requests`);

    // Get all repayments for these requests
    const requestIds = (activeRequests as unknown as RentRequest[])?.map(r => r.id) || [];
    
    let repaymentsByRequest: Record<string, number> = {};
    
    if (requestIds.length > 0) {
      const { data: repayments } = await supabase
        .from('repayments')
        .select('amount, rent_request_id')
        .in('rent_request_id', requestIds);

      // Sum repayments by request
      (repayments as Repayment[] || []).forEach(r => {
        repaymentsByRequest[r.rent_request_id] = 
          (repaymentsByRequest[r.rent_request_id] || 0) + Number(r.amount);
      });
    }

    // Check each request for behind schedule status
    for (const request of (activeRequests as unknown as RentRequest[]) || []) {
      try {
        results.checked++;

        const startDate = new Date(request.disbursed_at || request.created_at);
        const daysElapsed = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const expectedPayment = daysElapsed * Number(request.daily_repayment);
        const actualPayment = repaymentsByRequest[request.id] || 0;
        const behindAmount = expectedPayment - actualPayment;

        // Check if behind by more than 1 day's payment
        if (behindAmount > Number(request.daily_repayment)) {
          results.behindSchedule++;
          const daysBehind = Math.floor(behindAmount / Number(request.daily_repayment));

          // Check if we already sent a notification today
          const todayStart = new Date(now);
          todayStart.setHours(0, 0, 0, 0);

          const { data: existingNotif } = await supabase
            .from('notifications')
            .select('id')
            .eq('user_id', request.tenant_id)
            .eq('type', 'payment_behind')
            .gte('created_at', todayStart.toISOString())
            .maybeSingle();

          if (!existingNotif) {
            // Send in-app notification
            await supabase.from('notifications').insert({
              user_id: request.tenant_id,
              title: '⚠️ Payment Behind Schedule',
              message: `You're ${daysBehind} day${daysBehind > 1 ? 's' : ''} behind on your rent repayment. Outstanding: UGX ${behindAmount.toLocaleString()}. Pay now to avoid late fees!`,
              type: 'payment_behind',
              metadata: {
                rent_request_id: request.id,
                days_behind: daysBehind,
                behind_amount: behindAmount,
                daily_repayment: request.daily_repayment,
              },
            });

            // Send push notification
            const pushResponse = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({
                userIds: [request.tenant_id],
                payload: {
                  title: '⚠️ Payment Behind Schedule',
                  body: `You're ${daysBehind} day${daysBehind > 1 ? 's' : ''} behind. Pay UGX ${behindAmount.toLocaleString()} now!`,
                  icon: '/favicon.png',
                  url: '/dashboard',
                  type: 'warning',
                },
              }),
            });

            if (pushResponse.ok) {
              results.notificationsSent++;
              console.log(`Sent behind-schedule notification to tenant ${request.tenant_id}`);
            }
          }
        }
      } catch (err: any) {
        console.error(`Error checking request ${request.id}:`, err);
        results.errors.push(`Request ${request.id}: ${err.message}`);
      }
    }

    console.log(`Check complete: ${results.behindSchedule} tenants behind, ${results.notificationsSent} notifications sent`);


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "⚠️ Repayment Check", body: "Activity: repayment status checked", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(
      JSON.stringify({
        success: true,
        message: `Checked ${results.checked} requests, ${results.behindSchedule} behind schedule`,
        results,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error: any) {
    console.error('Repayment check error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
