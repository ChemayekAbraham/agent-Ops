import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

    const now = new Date();
    const results = {
      maturity_30d: 0,
      maturity_7d: 0,
      stale_approvals: 0,
      errors: [] as string[],
    };

    // ═══ 1. MATURITY ALERTS ═══
    // Get active portfolios with maturity dates
    const { data: portfolios, error: pErr } = await supabase
      .from('investor_portfolios')
      .select('id, portfolio_code, account_name, investment_amount, maturity_date, investor_id, agent_id, maturity_alert_30d, maturity_alert_7d, created_at, total_roi_earned, display_currency, duration_months')
      .eq('status', 'active')
      .not('maturity_date', 'is', null);

    if (pErr) throw new Error(`Failed to fetch portfolios: ${pErr.message}`);

    for (const p of portfolios || []) {
      try {
        const maturity = new Date(p.maturity_date);
        const daysToMaturity = Math.ceil((maturity.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
        const displayName = p.account_name || p.portfolio_code;
        const userId = p.investor_id || p.agent_id;

        // 30-day alert
        if (daysToMaturity <= 30 && daysToMaturity > 7 && !p.maturity_alert_30d) {
          // Create escalation
          await supabase.from('partner_escalations').insert({
            portfolio_id: p.id,
            escalation_type: 'maturity_30d',
            details: { days_remaining: daysToMaturity, portfolio_code: p.portfolio_code, amount: p.investment_amount },
          });

          // Notify partner
          await supabase.from('notifications').insert({
            user_id: userId,
            title: '📅 Portfolio Maturing Soon',
            message: `Your account "${displayName}" matures in ${daysToMaturity} days (${new Date(p.maturity_date).toLocaleDateString()}). Please plan accordingly.`,
            type: 'info',
            metadata: { portfolio_id: p.id, days_remaining: daysToMaturity },
          });

          await supabase.from('investor_portfolios').update({ maturity_alert_30d: true }).eq('id', p.id);
          results.maturity_30d++;
        }

        // 7-day alert
        if (daysToMaturity <= 7 && daysToMaturity > 0 && !p.maturity_alert_7d) {
          await supabase.from('partner_escalations').insert({
            portfolio_id: p.id,
            escalation_type: 'maturity_7d',
            details: { days_remaining: daysToMaturity, portfolio_code: p.portfolio_code, amount: p.investment_amount },
          });

          await supabase.from('notifications').insert({
            user_id: userId,
            title: '⚠️ Portfolio Maturity in ' + daysToMaturity + ' Days!',
            message: `Your account "${displayName}" with ${Number(p.investment_amount).toLocaleString()} matures in ${daysToMaturity} day(s). Contact your manager about renewal or withdrawal.`,
            type: 'warning',
            metadata: { portfolio_id: p.id, days_remaining: daysToMaturity },
          });

          await supabase.from('investor_portfolios').update({ maturity_alert_7d: true }).eq('id', p.id);
          results.maturity_7d++;
        }

        // Expired maturity — auto-update status & close all maturity escalations
        if (daysToMaturity <= 0) {
          await supabase.from('investor_portfolios').update({ status: 'matured' }).eq('id', p.id);
          await supabase.from('partner_escalations').insert({
            portfolio_id: p.id,
            escalation_type: 'maturity_expired',
            details: { portfolio_code: p.portfolio_code, amount: p.investment_amount, matured_at: now.toISOString() },
          });
          // Auto-close prior maturity alerts for this portfolio
          await supabase.from('partner_escalations')
            .update({ status: 'auto_resolved', resolved_at: now.toISOString() })
            .eq('portfolio_id', p.id)
            .eq('status', 'open')
            .in('escalation_type', ['maturity_30d', 'maturity_7d']);
          await supabase.from('notifications').insert({
            user_id: userId,
            title: '🏁 Portfolio Matured',
            message: `Your account "${displayName}" has reached maturity. Your investment of ${Number(p.investment_amount).toLocaleString()} is ready for renewal or withdrawal.`,
            type: 'info',
            metadata: { portfolio_id: p.id },
          });

          // ─── Send Portfolio Maturity Confirmation email to the partner ───
          // Resolve the partner's email + display name from profiles. Falls
          // back to the agent if there is no investor_id (managed account).
          try {
            const recipientUserId = p.investor_id || p.agent_id;
            if (recipientUserId) {
              const { data: partnerProfile } = await supabase
                .from('profiles')
                .select('email, full_name')
                .eq('id', recipientUserId)
                .maybeSingle();

              if (partnerProfile?.email) {
                const currency = p.display_currency || 'UGX';
                const principal = Number(p.investment_amount) || 0;
                const returns = Number(p.total_roi_earned) || 0;
                const total = principal + returns;

                const fmtDate = (iso: string | null) => {
                  if (!iso) return '';
                  const d = new Date(iso);
                  if (isNaN(d.getTime())) return '';
                  return d.toLocaleDateString('en-GB', {
                    day: '2-digit', month: 'long', year: 'numeric',
                  });
                };

                const months = Number(p.duration_months) || 0;
                const duration = months > 0
                  ? `${months} month${months === 1 ? '' : 's'}`
                  : '';

                const portfolioIdLabel = p.portfolio_code || `PF-${String(p.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`;

                const payload = {
                  templateName: 'portfolio-maturity',
                  recipientEmail: partnerProfile.email,
                  // Idempotency: one maturity email per portfolio, ever.
                  idempotencyKey: `portfolio-maturity-${p.id}`,
                  templateData: {
                    partner_name: partnerProfile.full_name || 'Partner',
                    portfolio_name: p.account_name || 'Partnership Portfolio',
                    portfolio_id: portfolioIdLabel,
                    principal_amount: principal,
                    returns_amount: returns,
                    total_matured_value: total,
                    start_date: fmtDate(p.created_at),
                    maturity_date: fmtDate(p.maturity_date),
                    duration,
                    currency,
                    company_name: 'Welile',
                    logo_url: 'https://welileapp.com/welile-logo.png',
                    unsubscribe_url: 'https://welile.com/unsubscribe',
                    terms_url: 'https://welileapp.com/partners-terms',
                    privacy_url: 'https://welileapp.com/privacy',
                  },
                };

                // Fire-and-forget; do not block automation on email enqueue.
                fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${supabaseServiceKey}`,
                  },
                  body: JSON.stringify(payload),
                }).catch((e) => console.warn('[partner-ops-automation] maturity email enqueue failed:', e));
              } else {
                console.warn('[partner-ops-automation] no email on profile for portfolio', p.id);
              }
            }
          } catch (emailErr) {
            const msg = emailErr instanceof Error ? emailErr.message : String(emailErr);
            console.warn(`[partner-ops-automation] maturity email error for ${p.id}: ${msg}`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.errors.push(`maturity ${p.id}: ${msg}`);
      }
    }

    // ═══ 2. STALE APPROVAL ESCALATION ═══
    // First, cleanup: auto-resolve stale escalations for portfolios no longer pending
    const { data: openStaleEscalations } = await supabase.from('partner_escalations')
      .select('id, portfolio_id')
      .eq('escalation_type', 'stale_approval')
      .eq('status', 'open');

    if (openStaleEscalations && openStaleEscalations.length > 0) {
      const escPortfolioIds = [...new Set(openStaleEscalations.map(e => e.portfolio_id))];
      const { data: stillPending } = await supabase.from('investor_portfolios')
        .select('id').eq('status', 'pending_approval').in('id', escPortfolioIds);
      const stillPendingIds = new Set((stillPending || []).map(p => p.id));
      const toResolve = openStaleEscalations.filter(e => !stillPendingIds.has(e.portfolio_id)).map(e => e.id);
      if (toResolve.length > 0) {
        await supabase.from('partner_escalations')
          .update({ status: 'auto_resolved', resolved_at: now.toISOString() })
          .in('id', toResolve);
        console.log(`[partner-ops-automation] Auto-resolved ${toResolve.length} orphaned stale escalations`);
      }
    }

    // Flag portfolios pending approval for > 48 hours
    const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();

    const { data: stalePortfolios, error: sErr } = await supabase
      .from('investor_portfolios')
      .select('id, portfolio_code, account_name, investment_amount, created_at, investor_id, agent_id')
      .eq('status', 'pending_approval')
      .lt('created_at', cutoff48h);

    if (sErr) {
      console.error('Failed to fetch stale portfolios:', sErr.message);
    } else {
      for (const sp of stalePortfolios || []) {
        try {
          // Check if already escalated
          const { data: existing } = await supabase
            .from('partner_escalations')
            .select('id')
            .eq('portfolio_id', sp.id)
            .eq('escalation_type', 'stale_approval')
            .eq('status', 'open')
            .limit(1);

          if (existing && existing.length > 0) continue;

          const hoursStale = Math.round((now.getTime() - new Date(sp.created_at).getTime()) / (60 * 60 * 1000));

          await supabase.from('partner_escalations').insert({
            portfolio_id: sp.id,
            escalation_type: 'stale_approval',
            details: {
              portfolio_code: sp.portfolio_code,
              amount: sp.investment_amount,
              hours_pending: hoursStale,
              created_at: sp.created_at,
            },
          });

          // Notify COO-level users via notifications table
          // Get all COO role users
          const { data: cooUsers } = await supabase
            .from('user_roles')
            .select('user_id')
            .eq('role', 'coo');

          for (const cu of cooUsers || []) {
            await supabase.from('notifications').insert({
              user_id: cu.user_id,
              title: '🚨 Stale Approval Alert',
              message: `Portfolio "${sp.account_name || sp.portfolio_code}" (${Number(sp.investment_amount).toLocaleString()}) has been pending approval for ${hoursStale}+ hours. Please review.`,
              type: 'warning',
              metadata: { portfolio_id: sp.id, hours_pending: hoursStale },
            });
          }

          results.stale_approvals++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          results.errors.push(`stale ${sp.id}: ${msg}`);
        }
      }
    }

    console.log(`[partner-ops-automation] Done: ${results.maturity_30d} 30d alerts, ${results.maturity_7d} 7d alerts, ${results.stale_approvals} escalations`);

    return new Response(
      JSON.stringify({ success: true, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[partner-ops-automation] Fatal:', msg);
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
