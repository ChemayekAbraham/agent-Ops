/**
 * Welile share host (Cloudflare Pages Functions), served at https://share.welileapp.com.
 *
 *   /s/<code>  rent plans and empty houses  -> og-plan
 *   /m/<code>  merchandise                  -> og-merchandise
 *   /c/<code>  co-support invitations       -> og-co-support
 *
 * welileapp.com is hosted by Lovable, which only ever returns the app shell
 * (Welile logo preview), and its DNS is at name.com, so the Worker route in
 * infra/share-proxy/ can never run there. A Pages project accepts a plain CNAME
 * from name.com (like help.welileapp.com), so this host does the same job on a
 * subdomain: it fetches the Supabase Open Graph function server-to-server and
 * re-serves the body as real HTML. Supabase forces function responses to
 * text/plain with a sandbox CSP, which crawlers do not read as a page.
 */
const FUNCTIONS = 'https://byrzshwlentqvktcksem.supabase.co/functions/v1';
const SITE = 'https://welileapp.com';
const CODE = /^[A-Za-z0-9_-]{4,64}$/;

function text(body, status, extra = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store', ...extra },
  });
}

/** @param {Request} request @param {'s' | 'm' | 'c'} kind @param {string} code */
export async function proxyShare(request, kind, code) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return text('Method not allowed', 405, { Allow: 'GET, HEAD' });
  }
  if (!CODE.test(code || '')) return text('Short link not found', 404);

  const src = new URL(request.url).searchParams.get('src');
  const upstreamUrl =
    kind === 'm'
      ? new URL(`${FUNCTIONS}/og-merchandise`)
      : kind === 'c'
        ? new URL(`${FUNCTIONS}/og-co-support/${encodeURIComponent(code)}`)
        : new URL(`${FUNCTIONS}/og-plan/${encodeURIComponent(code)}`);
  if (kind === 'm') upstreamUrl.searchParams.set('code', code.toLowerCase());
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
    return new Response(null, {
      status: 302,
      headers: { Location: loc.startsWith(SITE) ? loc : SITE, 'Cache-Control': 'no-store' },
    });
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
