import { useEffect, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import { KampalaClock } from '../deskPrefs';
import { addressWithoutToken, twinBoardToken } from './twinModel';
import { boardSource } from './twinSource';
import { TwinView } from './TwinView';

/**
 * The twin on a boardroom TV: /desk/twin?board=1#t=<display code> (or the
 * older ?t=<code>). main.tsx boots this on its own, like the boardroom screen:
 * no sign-in, no app shell, no account restore, the public key only. The code
 * is read once, kept for this tab only (sessionStorage, so a TV reload still
 * works) and taken out of the address bar. Every read is checked by the
 * server: revoked, expired and office-only codes are refused there.
 */

const KEY = 'welile.twin.board-code';

export { twinBoardToken };

/** True when this page load is a boardroom display of the twin. */
export function isTwinBoardBoot(path: string, search: string, hash: string): boolean {
  if (!/^\/desk\/twin\/?$/.test(path)) return false;
  if (twinBoardToken(path, search, hash)) return true;
  try {
    return new URLSearchParams(search).get('board') === '1' && !!window.sessionStorage.getItem(KEY);
  } catch {
    return false;
  }
}

/** Read the code, remember it for this tab, and strip it from the address bar. */
export function takeBoardCode(): string {
  const { pathname, search, hash } = window.location;
  const fromUrl = twinBoardToken(pathname, search, hash);
  if (fromUrl) {
    try {
      window.sessionStorage.setItem(KEY, fromUrl);
    } catch {
      /* private mode: the code lives only in memory */
    }
    try {
      window.history.replaceState(null, '', addressWithoutToken(pathname, search, hash));
    } catch {
      /* the address keeps the code; nothing else changes */
    }
    return fromUrl;
  }
  try {
    return window.sessionStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

let client: ReturnType<typeof createClient> | null = null;
function boardClient() {
  client ??= createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return client;
}

export default function TwinBoardDisplay({ token }: { token: string }) {
  const source = useMemo(() => boardSource(boardClient(), token), [token]);

  useEffect(() => {
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex,nofollow';
    document.head.appendChild(robots);
    const title = document.title;
    document.title = 'Welile — Digital twin';
    return () => {
      document.title = title;
      robots.remove();
    };
  }, []);

  return (
    <div className="desk-root min-h-screen" data-desk-theme="dark" data-desk-wall>
      <main className="mx-auto w-full min-w-0 max-w-[1760px] space-y-5 px-4 py-6 sm:px-8">
        <header className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-3xl font-semibold tracking-tight text-foreground">Ops Command Centre</h1>
            <p className="m-0 text-base text-[hsl(var(--desk-lavender))]">Digital twin · the last 24 hours, as the company ran them</p>
          </div>
          <KampalaClock className="text-base font-medium text-foreground" />
        </header>
        {token ? (
          <TwinView source={source} board />
        ) : (
          <p className="desk-panel p-6 text-base text-foreground">This display has no code. Open the boardroom link again.</p>
        )}
      </main>
    </div>
  );
}
