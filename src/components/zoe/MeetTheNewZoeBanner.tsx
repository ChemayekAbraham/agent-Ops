import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageSquare, X } from 'lucide-react';
import zoeAvatar from '@/assets/zoe-avatar.svg';
import {
  ZOE_MANAGER_ADOPTION_NOTE_LINES,
  isZoeManagerOrLeadRole,
} from './zoeConfig';

export const MEET_NEW_ZOE_STORAGE_PREFIX = 'welile.zoe.meet_new_zoe_seen.v1';

export function getMeetNewZoeStorageKey(userId?: string | null): string {
  const cleanId = (userId ?? '').trim();
  return cleanId
    ? `${MEET_NEW_ZOE_STORAGE_PREFIX}:${cleanId}`
    : MEET_NEW_ZOE_STORAGE_PREFIX;
}

export function hasSeenMeetNewZoeNotice(userId?: string | null): boolean {
  try {
    const key = getMeetNewZoeStorageKey(userId);
    if (localStorage.getItem(key) === '1') return true;
    if (localStorage.getItem(MEET_NEW_ZOE_STORAGE_PREFIX) === '1') return true;
    return false;
  } catch {
    return false;
  }
}

export function markMeetNewZoeNoticeSeen(userId?: string | null): void {
  try {
    const key = getMeetNewZoeStorageKey(userId);
    localStorage.setItem(key, '1');
    localStorage.setItem(MEET_NEW_ZOE_STORAGE_PREFIX, '1');
  } catch {
    // ignore storage errors
  }
}

export interface MeetTheNewZoeBannerProps {
  userId?: string | null;
  roles?: readonly string[] | null;
  enabled?: boolean;
}

export const MeetTheNewZoeBanner: React.FC<MeetTheNewZoeBannerProps> = ({
  userId,
  roles = [],
  enabled = true,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [dismissed, setDismissed] = useState<boolean>(() =>
    hasSeenMeetNewZoeNotice(userId),
  );

  useEffect(() => {
    setDismissed(hasSeenMeetNewZoeNotice(userId));
  }, [userId]);

  if (!enabled || dismissed) {
    return null;
  }

  const showManagerNote = isZoeManagerOrLeadRole(roles ?? []);

  const handleDismiss = () => {
    markMeetNewZoeNoticeSeen(userId);
    setDismissed(true);
  };

  const handleOpenZoe = () => {
    markMeetNewZoeNoticeSeen(userId);
    setDismissed(true);
    if (location.pathname !== '/me/zoe') {
      navigate('/me/zoe');
    }
  };

  return (
    <section
      aria-label="Meet the new Zoe notice"
      data-testid="meet-the-new-zoe-banner"
      className="rounded-2xl border border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-background p-4 shadow-sm"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <img
            src={zoeAvatar}
            alt="Zoe"
            data-testid="meet-the-new-zoe-avatar"
            className="h-11 w-11 shrink-0 rounded-full border border-primary/30 object-cover shadow-sm"
          />
          <div className="space-y-1.5 text-xs sm:text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold text-foreground">
                Meet the new Zoe — warmer, plain-spoken, and wired to your live My Space
              </h2>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
                New in My Space
              </span>
            </div>
            <p className="leading-relaxed text-muted-foreground">
              Ask Zoe for your personal wallet balance, payslips, salary advances, live department reports, or plain-English explanations of Welile workflows. Every figure comes straight from a live read-only report, and emails or reminders only send when you click.
            </p>
            {showManagerNote && (
              <div
                data-testid="zoe-manager-two-line-note"
                className="mt-2 rounded-xl border border-border/80 bg-background/85 px-3 py-2 text-xs leading-relaxed text-foreground"
              >
                <p className="font-medium text-foreground">
                  {ZOE_MANAGER_ADOPTION_NOTE_LINES[0]}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {ZOE_MANAGER_ADOPTION_NOTE_LINES[1]}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2 self-end sm:self-start">
          <button
            type="button"
            data-testid="meet-the-new-zoe-open-btn"
            onClick={handleOpenZoe}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Ask Zoe now</span>
          </button>
          <button
            type="button"
            data-testid="meet-the-new-zoe-dismiss-btn"
            onClick={handleDismiss}
            aria-label="Dismiss Meet the new Zoe notice"
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl border border-border bg-background px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
};

export default MeetTheNewZoeBanner;
