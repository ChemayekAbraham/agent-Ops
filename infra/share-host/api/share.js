/**
 * Welile share host (Vercel Edge Function), served at https://share.welileapp.com.
 *
 *   /s/<code>  rent plans and empty houses  -> og-plan
 *   /m/<code>  merchandise                  -> og-merchandise
 *
 * welileapp.com itself is hosted by Lovable (DNS at name.com), so the Cloudflare
 * Worker in infra/share-proxy/ can never run on it. This host does the same job
 * on a subdomain: it fetches the Supabase Open Graph function server-to-server
 * and re-serves the body as real HTML. Supabase forces function responses to
 * text/plain with a sandbox CSP, which crawlers will not read as a page, so a
 * plain rewrite is not enough.
 */
export const config = { runtime: 'edge' };

const FUNCTIONS = 'https://byrzshwlentqvktcksem.supabase.co/functions/v1';
const SITE = 'https://welileapp.com';
const CODE = /^[A-Za-z0-9_-]{4,64}$/;

function text(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store', ...extra },
  });
}

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Method not allowed', 405, { Allow: 'GET, HEAD' });
  }

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const code = url.searchParams.get('code') || '';
  const src = url.searchParams.get('src');
  if ((kind !== 's' && kind !== 'm') || !CODE.test(code)) return text('Short link not found', 404);

  let upstreamUrl;
  if (kind === 'm') {
    upstreamUrl = new URL(`${FUNCTIONS}/og-merchandise`);
    upstreamUrl.searchParams.set('code', code.toLowerCase());
  } else {
    upstreamUrl = new URL(`${FUNCTIONS}/og-plan/${encodeURIComponent(code)}`);
  }
  if (src) upstreamUrl.searchParams.set('src', src.slice(0, 50));

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        // og-plan uses the user agent to keep crawler fetches out of the click count.
        'User-Agent': request.headers.get('user-agent') || 'Welile-Share-Host/1.0',
        Referer: request.headers.get('referer') || '',
      },
      redirect: 'manual',
    });
  } catch {
    return text('Share preview temporarily unavailable. Please try again.', 503, { 'Retry-After': '30' });
  }

  // Pass redirects through, but only ever to our own site.
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location') || '';
    const safe = loc.startsWith(SITE) ? loc : SITE;
    return new Response(null, { status: 302, headers: { Location: safe, 'Cache-Control': 'no-store' } });
  }

  const body = await upstream.text();
  return new Response(request.method === 'HEAD' ? null : body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.status === 200 ? 'text/html; charset=UTF-8' : 'text/plain; charset=UTF-8',
      'Cache-Control': 'public, max-age=60, s-maxage=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
