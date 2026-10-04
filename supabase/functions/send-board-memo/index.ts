// Send Board Memo
//
// Sends a board technology memo that a human has already reviewed, with the
// reviewed PDF attached verbatim. This exists because `daily-cto-report`
// always regenerates its own body and attachment from live data — there is no
// way to put a *reviewed and corrected* memo in front of the board with it.
//
// The recipient is hard-locked to the board distribution address below. The
// caller supplies only the subject, body and attachment, never the recipient,
// so this endpoint cannot be used to mail arbitrary third parties.
//
// Invocation:
//   POST /send-board-memo
//   { "subject": "...", "html": "...", "text": "...",
//     "filename": "memo.pdf", "pdf_base64": "JVBERi0..." }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile CTO Office <reports@welile.com>';
const REPLY_TO = 'reports@welile.com';
// Hard-locked. Matches BOARD_RECIPIENTS in daily-cto-report.
const BOARD_MEMO_RECIPIENT = 'joshwanda17@gmail.com';

const MAX_PDF_BYTES = 20 * 1024 * 1024;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const mgKey = Deno.env.get('MAILGUN_API_KEY');
    const mgDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mgBase = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    if (!mgKey || !mgDomain) return json({ error: 'mailgun_not_configured' }, 500);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'invalid_json_body' }, 400);

    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const html = typeof body.html === 'string' ? body.html : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const filename = typeof body.filename === 'string' && body.filename.trim()
      ? body.filename.trim().replace(/[^A-Za-z0-9._-]/g, '_')
      : 'board-memo.pdf';
    const pdfBase64 = typeof body.pdf_base64 === 'string' ? body.pdf_base64 : '';

    if (!subject) return json({ error: 'subject is required' }, 400);
    if (!html && !text) return json({ error: 'html or text is required' }, 400);

    const form = new FormData();
    form.append('from', FROM);
    form.append('to', BOARD_MEMO_RECIPIENT);
    form.append('h:Reply-To', REPLY_TO);
    form.append('subject', subject);
    if (text) form.append('text', text);
    if (html) form.append('html', html);

    let pdfBytes = 0;
    if (pdfBase64) {
      let bytes: Uint8Array;
      try {
        bytes = decodeBase64(pdfBase64);
      } catch {
        return json({ error: 'pdf_base64 is not valid base64' }, 400);
      }
      if (bytes.length > MAX_PDF_BYTES) return json({ error: 'attachment_too_large', bytes: bytes.length }, 413);
      pdfBytes = bytes.length;
      form.append('attachment', new Blob([bytes], { type: 'application/pdf' }), filename);
    }

    const mgRes = await fetch(`${mgBase}/v3/${mgDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`api:${mgKey}`)}` },
      body: form,
    });
    if (!mgRes.ok) {
      const errBody = await mgRes.text();
      console.error(`[send-board-memo] Mailgun ${mgRes.status}: ${errBody}`);
      return json({ error: 'mailgun_failed', status: mgRes.status, details: errBody }, 502);
    }

    const mgBody = await mgRes.json().catch(() => ({}));
    return json({
      ok: true,
      recipient: BOARD_MEMO_RECIPIENT,
      subject,
      attachment: pdfBase64 ? filename : null,
      pdf_bytes: pdfBytes,
      mailgun_id: (mgBody as Record<string, unknown>)?.id ?? null,
    }, 200);
  } catch (e) {
    console.error('[send-board-memo] error', e);
    return json({ error: (e as Error).message }, 500);
  }
});
