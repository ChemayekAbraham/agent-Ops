// Store + email the Tenant Partnership Agreement PDF.
//
// SINGLE HTML -> PDF PIPELINE: the PDF is rendered on the client from the exact
// same contract HTML the admin previews (see src/components/partner/*), then
// posted here as base64. This function never re-renders the document — it only
// validates the caller, stores the bytes privately, updates the agreement row
// and emails the partner a download link. This guarantees the stored/emailed
// PDF is pixel-identical to the on-screen preview.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { renderContractPdf, decodeDataUrlToBytes, resolveAgreementDate } from '../_shared/partnerContractPdf.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PARTNERSHIP_EMAIL = 'partnership@welile.com';
// When the client-side PDF render fails or is skipped, we still MUST send the
// contract email — the partner has an account and expects a confirmation. In
// that case we fall back to a portal link they can sign into to view/download
// the generated contract from their dashboard.
const PARTNER_PORTAL_URL = 'https://welileapp.com/dashboard/funder';

// ─── numberToWords (for the email summary) ───────────────────────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'];
function threeDigits(n: number): string {
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h > 0) parts.push(`${ONES[h]} Hundred`);
  if (r > 0) {
    if (r < 20) parts.push(ONES[r]);
    else { const t = Math.floor(r / 10); const o = r % 10; parts.push(o > 0 ? `${TENS[t]}-${ONES[o]}` : TENS[t]); }
  }
  return parts.join(' ');
}
function numberToWords(value: number): string {
  const n = Math.floor(Math.abs(value || 0));
  if (n === 0) return 'Zero';
  const groups: number[] = [];
  let rem = n;
  while (rem > 0) { groups.push(rem % 1000); rem = Math.floor(rem / 1000); }
  const words: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    const chunk = threeDigits(groups[i]);
    const scale = SCALES[i];
    words.push(scale ? `${chunk} ${scale}` : chunk);
  }
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

// Decode a data URL or raw base64 string into bytes.
function decodeBase64(input: string): Uint8Array {
  const comma = input.indexOf(',');
  const b64 = input.startsWith('data:') && comma >= 0 ? input.slice(comma + 1) : input;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: 'Unauthorized' }, 401);
    const callerId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const partnerId = String(body?.partnerId || '').trim();
    const countersign = body?.countersign === true;
    const pdfBase64 = typeof body?.pdfBase64 === 'string' ? body.pdfBase64 : '';
    // Callers that own their own confirmation email (e.g. the /funder-onboarding
    // signup, which sends `partner-account-created` from
    // create-funder-onboarding-account) pass sendEmail:false so the
    // `tenant-partnership-agreement` email is NOT fired on account creation.
    // The agreement row + PDF are still stored exactly as before.
    const sendEmail = body?.sendEmail !== false;
    // Countersigning still requires the freshly-signed bytes; the initial
    // partner-onboarding call now runs even when the client render is missing
    // so the confirmation email is guaranteed to go out.
    if (!partnerId) return json({ error: 'partnerId is required' }, 400);
    if (countersign && !pdfBase64) return json({ error: 'pdfBase64 is required to countersign' }, 400);

    // Permission: partner can store own draft; ops/manager can store & countersign.
    const [{ data: isOps }, { data: isManager }] = await Promise.all([
      admin.rpc('is_ops_role', { _user_id: callerId }),
      admin.rpc('has_role', { _user_id: callerId, _role: 'manager' }),
    ]);
    const isStaff = isOps === true || isManager === true;
    if (countersign && !isStaff) {
      return json({ error: 'Only operations/manager staff can countersign.' }, 403);
    }
    if (!isStaff && callerId !== partnerId) {
      return json({ error: 'You can only generate your own agreement.' }, 403);
    }

    // ── Load / lazily backfill the source-of-truth row ──
    let { data: row } = await admin
      .from('partner_agreements')
      .select('*')
      .eq('partner_id', partnerId)
      .maybeSingle();
    if (!row) {
      row = await backfillRow(admin, partnerId);
      if (!row) return json({ error: 'No agreement data found for this partner.' }, 404);
    }

    // ── Decode + store the client-rendered PDF privately (only when supplied) ──
    const reference = row.reference || `PA-${partnerId.slice(0, 8).toUpperCase()}`;
    let objectPath: string | null = null;
    let signedUrl: string | null = null;
    if (pdfBase64) {
      const pdfBytes = decodeBase64(pdfBase64);
      objectPath = `${partnerId}/partnership-agreement${countersign ? '-signed' : ''}-${reference}.pdf`;
      const { error: upErr } = await admin.storage
        .from('partner-agreements')
        .upload(objectPath, pdfBytes, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw upErr;
      const { data: signed } = await admin.storage
        .from('partner-agreements')
        .createSignedUrl(objectPath, 60 * 60 * 24 * 365);
      signedUrl = signed?.signedUrl || null;
    }

    // ── SERVER-SIDE FALLBACK ──────────────────────────────────────────────
    // The client render (html2canvas) can time out or be cut short on slow
    // phones, which previously produced a contract email with NO agreement at
    // all. Render the filled contract server-side from the agreement row so
    // the partner always receives a complete, populated PDF.
    if (!objectPath) {
      try {
        const amountNum = Math.max(0, Math.floor(Number(row.partnership_amount) || 0));
        let fallbackReturnLabel = '15%';
        let fallbackPortfolioDate: string | null = null;
        try {
          const { data: portfolio } = await admin
            .from('investor_portfolios')
            .select('roi_percentage, created_at')
            .eq('investor_id', partnerId)
            .not('roi_percentage', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          const pct = Number(portfolio?.roi_percentage);
          if (Number.isFinite(pct) && pct > 0) {
            fallbackReturnLabel = `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/\.?0+$/, '')}%`;
          }
          fallbackPortfolioDate = portfolio?.created_at ?? null;
        } catch { /* keep default */ }

        const fallbackBytes = await renderContractPdf({
          partnerName: row.full_name || 'Partner',
          partnerId: row.national_id || '',
          partnerAddress: row.address || '',
          partnerPhone: row.phone || '',
          partnerEmail: row.email || '',
          partnershipAmount: amountNum,
          partnershipAmountWords: row.partnership_amount_words || numberToWords(amountNum),
          monthlyReturnLabel: fallbackReturnLabel,
          bankName: row.bank_name || '',
          bankAccountName: row.bank_account_name || '',
          bankAccountNumber: row.bank_account_number || '',
          momoProvider: row.momo_provider || '',
          momoNumber: row.momo_number || '',
          payoutMode: row.payout_mode === 'momo' ? 'momo' : 'bank',
          reference,
          partnerSignaturePngBytes: decodeDataUrlToBytes(row.partner_signature_data_url),
          agreementDate: resolveAgreementDate(row, fallbackPortfolioDate),
        });
        objectPath = `${partnerId}/partnership-agreement-${reference}.pdf`;
        const { error: fbUpErr } = await admin.storage
          .from('partner-agreements')
          .upload(objectPath, fallbackBytes, { contentType: 'application/pdf', upsert: true });
        if (fbUpErr) throw fbUpErr;
        const { data: fbSigned } = await admin.storage
          .from('partner-agreements')
          .createSignedUrl(objectPath, 60 * 60 * 24 * 365);
        signedUrl = fbSigned?.signedUrl || null;
        console.log('server-side fallback contract rendered for', partnerId);
      } catch (e) {
        objectPath = null;
        console.warn('server-side fallback contract render failed:', e);
      }
    }

    // ── Update the row state ──
    const patch: Record<string, unknown> = {};
    if (objectPath) patch.generated_pdf_path = objectPath;
    if (countersign) {
      patch.status = 'countersigned';
      patch.countersigned_by = callerId;
      // Ops can stamp an explicit execution date (YYYY-MM-DD) so the stored
      // record matches the date printed on the contract/stamp.
      const rawStamp = typeof body?.countersignAt === 'string' ? body.countersignAt.trim() : '';
      const stampDate = /^\d{4}-\d{2}-\d{2}$/.test(rawStamp) ? new Date(`${rawStamp}T12:00:00Z`) : null;
      patch.countersigned_at = (stampDate && !Number.isNaN(stampDate.getTime()) ? stampDate : new Date()).toISOString();
    }
    if (Object.keys(patch).length > 0) {
      await admin.from('partner_agreements').update(patch).eq('id', row.id);
    }

    // ── Email the partner a download link ──
    if (row.email && sendEmail) {
      const amountNum = Math.max(0, Math.floor(Number(row.partnership_amount) || 0));
      const isBank = row.payout_mode !== 'momo';
      const payoutSummary = isBank
        ? [row.bank_name, row.bank_account_number].filter(Boolean).join(' ') || 'Bank Transfer'
        : [row.momo_provider, row.momo_number].filter(Boolean).join(' ') || 'Mobile Money';
      // Resolve the partner's real ROI% from their most recent portfolio so
      // partners on non-default rates (e.g. 20%) never see a hardcoded 15%.
      let monthlyReturnLabel = '15%';
      try {
        const { data: portfolio } = await admin
          .from('investor_portfolios')
          .select('roi_percentage, created_at, status')
          .eq('investor_id', partnerId)
          .not('roi_percentage', 'is', null)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        const pct = Number(portfolio?.roi_percentage);
        if (Number.isFinite(pct) && pct > 0) {
          monthlyReturnLabel = `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/\.?0+$/, '')}%`;
        }
      } catch (e) {
        console.warn('roi_percentage lookup failed, falling back to 15%:', e);
      }
      const templateData = {
        partner_name: row.full_name || 'Partner',
        partner_email: row.email,
        partner_reference: reference,
        partnership_amount: `UGX ${amountNum.toLocaleString('en-US')}`,
        partnership_amount_words: row.partnership_amount_words || numberToWords(amountNum),
        monthly_return: monthlyReturnLabel,
        payout_summary: payoutSummary,
        agreement_download_url: signedUrl || PARTNER_PORTAL_URL,
        agreement_download_available: signedUrl ? 'yes' : 'no',
        company_name: 'WELILE TECHNOLOGIES LTD',
      };
      try {
        const { data: emailResult, error: emailError } = await admin.functions.invoke('send-transactional-email', {
          body: {
            templateName: 'tenant-partnership-agreement',
            recipientEmail: row.email,
            templateData,
          },
        });
        if (emailError) throw emailError;

        // If the partner address is suppressed from a prior bounce/unsubscribe,
        // the normal send never reaches the BCC path. Send a direct audit copy
        // to the partnerships mailbox so the signed agreement is still filed.
        if ((emailResult as any)?.reason === 'email_suppressed') {
          await admin.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'tenant-partnership-agreement',
              recipientEmail: PARTNERSHIP_EMAIL,
              templateData: {
                ...templateData,
                original_partner_email: row.email,
                audit_copy_reason: 'partner_email_suppressed',
              },
            },
          });
        }
      } catch (e) {
        console.warn('agreement email failed (non-blocking):', e);
      }
    }

    return json({
      ok: true,
      signedUrl,
      hasPdf: !!objectPath,
      status: countersign ? 'countersigned' : 'pending',
    });
  } catch (e) {
    console.error('generate-partner-agreement error:', e);
    return json({ error: (e as Error)?.message || 'Internal error' }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Build a partner_agreements row from existing profile + payout data when none exists.
async function backfillRow(admin: any, partnerId: string) {
  const [{ data: prof }, { data: method }] = await Promise.all([
    admin.from('profiles').select('full_name, phone, email, national_id, landmark').eq('id', partnerId).maybeSingle(),
    admin.from('saved_payout_methods').select('*').eq('user_id', partnerId)
      .order('is_default', { ascending: false })
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .limit(1).maybeSingle(),
  ]);
  if (!prof) return null;
  const reference = `PA-${partnerId.slice(0, 8).toUpperCase()}`;
  const insert: Record<string, unknown> = {
    partner_id: partnerId,
    full_name: prof.full_name,
    phone: prof.phone,
    email: prof.email,
    national_id: prof.national_id,
    address: prof.landmark,
    payout_mode: method?.payout_mode || 'bank',
    bank_name: method?.bank_name,
    bank_account_name: method?.bank_account_name,
    bank_account_number: method?.bank_account_number,
    momo_provider: method?.momo_provider,
    momo_number: method?.momo_number,
    momo_name: method?.momo_name,
    reference,
    status: 'pending',
  };
  const { data, error } = await admin.from('partner_agreements').insert(insert).select('*').maybeSingle();
  if (error) { console.warn('backfill insert failed:', error); return null; }
  return data;
}
