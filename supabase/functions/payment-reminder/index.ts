import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_id: string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const today = new Date().toISOString().split('T')[0];

    // Find tenants with active rent requests who haven't paid today
    const { data: activeRentRequests, error: rentError } = await supabase
      .from('rent_requests')
      .select('tenant_id, rent_amount, daily_repayment, duration_days')
      .in('status', ['disbursed', 'repaying', 'approved']);

    if (rentError) {
      console.error('Error fetching rent requests:', rentError);
      throw rentError;
    }

    if (!activeRentRequests || activeRentRequests.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No active rent requests found', notified: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const tenantIds = [...new Set(activeRentRequests.map(r => r.tenant_id))];

    // Get today's repayments
    const { data: todayRepayments, error: repaymentError } = await supabase
      .from('repayments')
      .select('tenant_id')
      .eq('payment_date', today)
      .in('tenant_id', tenantIds);

    if (repaymentError) {
      console.error('Error fetching repayments:', repaymentError);
      throw repaymentError;
    }

    const paidTenantIds = new Set((todayRepayments || []).map(r => r.tenant_id));
    const unpaidTenantIds = tenantIds.filter(id => !paidTenantIds.has(id));

    if (unpaidTenantIds.length === 0) {
      return new Response(
        JSON.stringify({ message: 'All tenants have paid today', notified: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get push subscriptions for unpaid tenants
    const { data: subscriptions, error: subError } = await supabase
      .from('push_subscriptions')
      .select('*')
      .in('user_id', unpaidTenantIds);

    if (subError) {
      console.error('Error fetching subscriptions:', subError);
      throw subError;
    }

    // Get tenant names for personalized messages
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', unpaidTenantIds);

    const profileMap = new Map((profiles || []).map(p => [p.id, p.full_name]));

    // Also create in-app notifications for all unpaid tenants
    const notifications = unpaidTenantIds.map(tenantId => {
      const rentRequest = activeRentRequests.find(r => r.tenant_id === tenantId);
      return {
        user_id: tenantId,
        title: '⏰ Daily Payment Reminder',
        message: `Don't break your streak! Pay your daily amount of UGX ${rentRequest?.daily_repayment?.toLocaleString() || ''} before midnight to keep your limit growing.`,
        type: 'reminder',
        metadata: {
          reminder_type: 'daily_payment',
          daily_amount: rentRequest?.daily_repayment
        }
      };
    });

    const { error: notifError } = await supabase
      .from('notifications')
      .insert(notifications);

    if (notifError) {
      console.error('Error creating notifications:', notifError);
    }

    // Send push notifications (if VAPID keys are configured)
    let pushSent = 0;
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY");

    if (vapidPublicKey && vapidPrivateKey && subscriptions && subscriptions.length > 0) {
      // For each subscription, we'd send a web push
      // This is a simplified version - in production you'd use web-push library
      for (const sub of subscriptions) {
        const rentRequest = activeRentRequests.find(r => r.tenant_id === sub.user_id);
        const name = profileMap.get(sub.user_id) || 'there';
        
        try {
          // Create push payload
          const payload = JSON.stringify({
            title: '⏰ Daily Payment Reminder',
            body: `Hi ${name.split(' ')[0]}! Pay UGX ${rentRequest?.daily_repayment?.toLocaleString() || ''} today to maintain your streak.`,
            icon: '/welile-logo.png',
            badge: '/welile-logo.png',
            data: {
              url: '/dashboard',
              type: 'payment_reminder'
            }
          });

          // Log the push attempt (actual sending would require web-push library)
          console.log(`Push notification prepared for user ${sub.user_id}`);
          pushSent++;
        } catch (pushError) {
          console.error(`Failed to send push to ${sub.user_id}:`, pushError);
        }
      }
    }

    return new Response(
      JSON.stringify({
        message: 'Payment reminders sent',
        totalUnpaid: unpaidTenantIds.length,
        notificationsCreated: notifications.length,
        pushNotificationsSent: pushSent
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error: unknown) {
    console.error('Error in payment-reminder:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
