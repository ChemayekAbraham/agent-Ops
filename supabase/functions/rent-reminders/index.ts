import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log("Starting rent reminder notifications...");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    // Get current day of month
    const today = new Date();
    const dayOfMonth = today.getDate();
    
    // Send reminders on 1st, 25th, 28th of month (common rent due dates)
    const isReminderDay = [1, 25, 28].includes(dayOfMonth);
    
    // Also allow manual trigger
    const body = await req.json().catch(() => ({}));
    const forceRun = body.force === true;

    if (!isReminderDay && !forceRun) {
      console.log(`Not a reminder day (day ${dayOfMonth}), skipping...`);
      return new Response(
        JSON.stringify({ message: "Not a reminder day", dayOfMonth }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Running rent reminders for day ${dayOfMonth}...`);

    // Get all users with registered landlords
    const { data: landlords, error: landlordsError } = await supabase
      .from("landlords")
      .select("tenant_id, name, monthly_rent, property_address")
      .not("tenant_id", "is", null)
      .not("monthly_rent", "is", null);

    if (landlordsError) {
      console.error("Error fetching landlords:", landlordsError);
      throw landlordsError;
    }

    if (!landlords || landlords.length === 0) {
      console.log("No landlords with tenant registrations found");
      return new Response(
        JSON.stringify({ message: "No tenants with registered landlords", sent: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found ${landlords.length} registered landlord(s)`);

    // Get unique tenant IDs
    const tenantIds = [...new Set(landlords.map(l => l.tenant_id))];

    // For each tenant, calculate their available rent discount
    let notificationsSent = 0;

    for (const tenantId of tenantIds) {
      try {
        // Get verified receipts from current month
        const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString();
        const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString();

        const { data: receipts, error: receiptsError } = await supabase
          .from("user_receipts")
          .select("claimed_amount")
          .eq("user_id", tenantId)
          .eq("verified", true)
          .gte("verified_at", startOfMonth)
          .lte("verified_at", endOfMonth);

        if (receiptsError) {
          console.error(`Error fetching receipts for tenant ${tenantId}:`, receiptsError);
          continue;
        }

        // Calculate total verified amount this month
        const totalVerifiedAmount = receipts?.reduce((sum, r) => sum + Number(r.claimed_amount || 0), 0) || 0;
        
        // Calculate 1% discount (max 70% of rent)
        const tenantLandlords = landlords.filter(l => l.tenant_id === tenantId);
        const totalMonthlyRent = tenantLandlords.reduce((sum, l) => sum + Number(l.monthly_rent || 0), 0);
        
        const discountPercent = 1; // 1% of receipts
        const rawDiscount = totalVerifiedAmount * (discountPercent / 100);
        const maxDiscount = totalMonthlyRent * 0.7; // 70% cap
        const availableDiscount = Math.min(rawDiscount, maxDiscount);

        // Build notification message
        let message: string;
        let notificationType: string;

        if (dayOfMonth === 1) {
          // Start of month reminder
          if (availableDiscount > 0) {
            message = `🏠 Rent due soon! You have UGX ${availableDiscount.toLocaleString()} available discount from your ${receipts?.length || 0} verified receipts this month. Pay through Welile to save!`;
            notificationType = "success";
          } else {
            message = `🏠 Rent due soon! Start collecting receipts to earn up to 70% discount on your rent. Every receipt counts!`;
            notificationType = "info";
          }
        } else if (dayOfMonth === 25) {
          // End of month approaching
          if (availableDiscount > 0) {
            message = `⏰ Only a few days left! You have UGX ${availableDiscount.toLocaleString()} rent discount ready to use. Don't miss out - pay before month end!`;
            notificationType = "warning";
          } else {
            message = `⏰ Rent due in a few days! Quick tip: Add receipts before month-end to unlock discounts for next month.`;
            notificationType = "info";
          }
        } else {
          // Day 28 - urgent reminder
          if (availableDiscount > 0) {
            message = `🚨 LAST CHANCE! UGX ${availableDiscount.toLocaleString()} rent discount expires soon. Pay your landlord through Welile NOW to save!`;
            notificationType = "alert";
          } else {
            message = `🚨 Rent due very soon! Pay your landlord through Welile for secure, tracked payments.`;
            notificationType = "warning";
          }
        }

        // Create notification
        const { error: notifError } = await supabase.from("notifications").insert({
          user_id: tenantId,
          title: "💰 Rent Payment Reminder",
          message,
          type: notificationType,
          metadata: {
            available_discount: availableDiscount,
            total_verified_receipts: receipts?.length || 0,
            monthly_rent: totalMonthlyRent,
            landlord_count: tenantLandlords.length,
          },
        });

        if (notifError) {
          console.error(`Error creating notification for ${tenantId}:`, notifError);
        } else {
          notificationsSent++;
          console.log(`Sent rent reminder to tenant ${tenantId} with discount UGX ${availableDiscount}`);
        }
      } catch (err) {
        console.error(`Error processing tenant ${tenantId}:`, err);
      }
    }

    console.log(`Rent reminders complete. Sent ${notificationsSent} notifications.`);

    return new Response(
      JSON.stringify({
        success: true,
        message: `Sent ${notificationsSent} rent reminder notifications`,
        sent: notificationsSent,
        totalTenants: tenantIds.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("Error in rent-reminders function:", error);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
