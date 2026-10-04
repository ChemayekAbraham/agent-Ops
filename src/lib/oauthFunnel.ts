import { supabase } from '@/integrations/supabase/client';

export type OAuthProvider = 'google' | 'apple';
export type OAuthFunnelStage = 'attempt' | 'redirected' | 'error' | 'success';

const PENDING_KEY = 'welile_oauth_funnel';

interface PendingFunnel {
  funnelId: string;
  provider: OAuthProvider;
  startedAt: number;
}

function detectEnvKind(): string {
  try {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return 'local';
    if (host.includes('id-preview--') || host.includes('preview--') || host.endsWith('.lovableproject.com')) return 'preview';
    if (host.includes('welileapp.com')) return 'custom';
    if (host.endsWith('.lovable.app')) return 'published';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function newFunnelId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Fire-and-forget insert of one funnel event. Never throws — tracking must
 * never block or break the actual sign-in flow.
 */
async function logEvent(
  funnelId: string,
  provider: OAuthProvider,
  stage: OAuthFunnelStage,
  extra?: { errorMessage?: string; userId?: string | null },
): Promise<void> {
  try {
    await (supabase as any).from('oauth_funnel_events').insert({
      funnel_id: funnelId,
      provider,
      stage,
      env: detectEnvKind(),
      domain: window.location.hostname,
      origin: window.location.origin,
      error_message: extra?.errorMessage ?? null,
      user_agent: navigator.userAgent?.slice(0, 400) ?? null,
      user_id: extra?.userId ?? null,
    });
  } catch (err) {
    console.warn('[oauthFunnel] failed to log', stage, err);
  }
}

/**
 * Begin a funnel: generates an id, persists it so the return-trip after the
 * provider redirect can record success, and logs the `attempt` event.
 */
export async function beginOAuthFunnel(provider: OAuthProvider): Promise<string> {
  const funnelId = newFunnelId();
  try {
    const pending: PendingFunnel = { funnelId, provider, startedAt: Date.now() };
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch { /* non-critical */ }
  await logEvent(funnelId, provider, 'attempt');
  return funnelId;
}

export async function trackOAuthRedirected(funnelId: string, provider: OAuthProvider): Promise<void> {
  await logEvent(funnelId, provider, 'redirected');
}

export async function trackOAuthError(
  funnelId: string,
  provider: OAuthProvider,
  errorMessage?: string,
): Promise<void> {
  await logEvent(funnelId, provider, 'error', { errorMessage });
  try { localStorage.removeItem(PENDING_KEY); } catch { /* non-critical */ }
}

/**
 * Called once a session is confirmed after returning from the provider. If a
 * pending funnel exists (set before the redirect), record `success` and clear.
 */
export async function completePendingOAuthFunnel(userId?: string | null): Promise<void> {
  let pending: PendingFunnel | null = null;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (raw) pending = JSON.parse(raw) as PendingFunnel;
  } catch { pending = null; }
  if (!pending?.funnelId) return;
  // Ignore stale markers older than 20 minutes.
  if (Date.now() - (pending.startedAt || 0) > 20 * 60 * 1000) {
    try { localStorage.removeItem(PENDING_KEY); } catch { /* non-critical */ }
    return;
  }
  try { localStorage.removeItem(PENDING_KEY); } catch { /* non-critical */ }
  await logEvent(pending.funnelId, pending.provider, 'success', { userId: userId ?? null });
}
