import 'https://deno.land/std@0.224.0/dotenv/load.ts';
import { assertEquals, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

// Live end-to-end test: invokes the deployed send-transactional-email function
// with the EXACT payload fund-rent-pool would send when a NEW portfolio is
// created, then asserts the send was logged in email_send_log.
//
// GUARDED: only runs when RUN_LIVE_EMAIL=1 to prevent accidental sends. The
// recipient is hard-coded to pexpert46@gmail.com per test request.
//
// Required env (loaded from project .env via dotenv):
//   VITE_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY  (must be provided in env, not in .env)

const LIVE = Deno.env.get('RUN_LIVE_EMAIL') === '1';

Deno.test({
  name: 'LIVE: partnership-agreement email is enqueued for a new portfolio',
  ignore: !LIVE,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const url = Deno.env.get('VITE_SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    assert(url, 'VITE_SUPABASE_URL must be set');
    assert(serviceKey, 'SUPABASE_SERVICE_ROLE_KEY must be set to run live email test');

    const admin = createClient(url!, serviceKey!);

    const recipient = 'pexpert46@gmail.com';
    const fakePortfolioId = `test-${crypto.randomUUID()}`;
    const fakeUserId = `test-user-${crypto.randomUUID()}`;
    const idempotencyKey = `partnership-agreement-${fakeUserId}-${fakePortfolioId}`;

    const payload = {
      templateName: 'partnership-agreement',
      recipientEmail: recipient,
      idempotencyKey,
      templateData: {
        partner_name: 'Pius Expert (TEST)',
        partnership_amount: 1_000_000,
        contribution_date: '21 April 2026',
        monthly_return_amount: 150_000,
        total_projected_return: 1_800_000,
        first_payment_date: '21 May 2026',
        roi_payment_day: 21,
        currency: 'UGX',
        company_name: 'Welile',
        logo_url: 'https://welileapp.com/welile-logo.png',
        dashboard_url: 'https://welileapp.com/auth',
      },
    };

    const res = await fetch(`${url}/functions/v1/send-transactional-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    assertEquals(
      res.status,
      200,
      `send-transactional-email failed: ${res.status} ${body}`,
    );

    // Poll email_send_log for the recipient + template within last 60s.
    let found: any = null;
    for (let i = 0; i < 10; i++) {
      const { data } = await admin
        .from('email_send_log')
        .select('id, status, template_name, recipient_email, created_at, error_message')
        .eq('template_name', 'partnership-agreement')
        .eq('recipient_email', recipient)
        .gte('created_at', new Date(Date.now() - 60_000).toISOString())
        .order('created_at', { ascending: false })
        .limit(1);
      if (data && data.length > 0) {
        found = data[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    assert(
      found,
      'Expected an email_send_log row for partnership-agreement to pexpert46@gmail.com',
    );
    assert(
      ['pending', 'sent'].includes(found.status),
      `Unexpected status: ${found.status} (${found.error_message ?? 'no error'})`,
    );
  },
});
