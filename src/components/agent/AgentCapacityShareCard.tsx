import { forwardRef } from 'react';
import { formatUGX } from '@/lib/rentCalculations';
import { type AgentBadge, BADGE_HEX, BADGE_HEX_LIGHT } from '@/lib/agentBadges';

interface ShareCardProps {
  agentName: string;
  paidToday: number;
  expectedDaily: number;
  paidYesterday: number;
  perTenantMax: number;
  headroom: number;
  remainingSlots: number;
  canPost: boolean;
  dateLabel: string;
  badges?: AgentBadge[];
  tenantCount?: number;
  preview?: boolean;
  /** Render on a clean white background instead of the dark green gradient. */
  light?: boolean;
}

/**
 * Off-screen branded card captured to a PNG for WhatsApp sharing.
 * Uses inline styles + absolute hex colors so html-to-image renders it
 * reliably regardless of the live theme / CSS variables.
 */
export const AgentCapacityShareCard = forwardRef<HTMLDivElement, ShareCardProps>(
  (props, ref) => {
    const {
      agentName, paidToday, expectedDaily, paidYesterday,
      perTenantMax, headroom, remainingSlots, canPost, dateLabel,
      badges = [], tenantCount, preview = false, light = false,
    } = props;

    const pct = expectedDaily > 0
      ? Math.min(100, Math.round((paidToday / expectedDaily) * 100))
      : 0;
    const remainingUGX = Math.max(0, expectedDaily - paidToday);
    const diff = paidToday - paidYesterday;
    const barColor = pct >= 50 ? '#10b981' : pct >= 20 ? '#f59e0b' : '#ef4444';

    // Palette swaps between the dark gradient card and the clean white card.
    const c = light
      ? {
          cardBg: '#ffffff',
          tileBg: '#f3f4f6',
          barTrack: '#e5e7eb',
          name: '#111827',
          accent: '#0f3d2e',
          muted: '#6b7280',
          statSub: '#374151',
          dateText: '#6b7280',
          footer: '#6b7280',
          badge: BADGE_HEX_LIGHT,
          okBg: '#ecfdf5', okFg: '#047857',
          lockBg: '#fef2f2', lockFg: '#b91c1c',
          diffUp: '#047857', diffDown: '#dc2626',
          border: '1px solid #e5e7eb',
        }
      : {
          cardBg: 'linear-gradient(160deg, #0f3d2e 0%, #0a2a20 60%, #07201a 100%)',
          tileBg: 'rgba(255,255,255,0.08)',
          barTrack: 'rgba(255,255,255,0.15)',
          name: '#ffffff',
          accent: '#7dd3b0',
          muted: '#9fd8c2',
          statSub: '#cfeee0',
          dateText: '#cfeee0',
          footer: '#7dd3b0',
          badge: BADGE_HEX,
          okBg: 'rgba(16,185,129,0.18)', okFg: '#6ee7b7',
          lockBg: 'rgba(239,68,68,0.18)', lockFg: '#fca5a5',
          diffUp: '#6ee7b7', diffDown: '#fca5a5',
          border: 'none',
        };

    return (
      <div
        ref={ref}
        style={{
          position: preview ? 'relative' : 'fixed',
          left: preview ? 'auto' : '-9999px',
          top: 0,
          width: 540,
          padding: 32,
          fontFamily: 'Inter, system-ui, sans-serif',
          background: c.cardBg,
          color: c.name,
          boxSizing: 'border-box',
        }}
      >
        {/* Header with logo */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
          <img
            src="/welile-logo.png"
            alt="Welile"
            crossOrigin="anonymous"
            style={{ height: 40, width: 'auto', objectFit: 'contain' }}
          />
          <span style={{ fontSize: 13, color: c.dateText, fontWeight: 600 }}>{dateLabel}</span>
        </div>

        <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase', color: c.accent }}>
          Today&apos;s Rent-Request Capacity
        </div>
        <div style={{ fontSize: 20, fontWeight: 800, marginTop: 4, marginBottom: 20 }}>{agentName}</div>

        {/* Honour badges summary */}
        {badges.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
            {badges.map((b) => {
              const bc = c.badge[b.tone];
              return (
                <span
                  key={b.id}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: bc.bg,
                    color: bc.fg,
                    borderRadius: 999,
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 800,
                  }}
                >
                  <span style={{ fontSize: 13 }}>{b.icon}</span>
                  {b.label}
                </span>
              );
            })}
          </div>
        )}

        {/* Collected today vs target */}
        <div style={{ background: c.tileBg, border: c.border, borderRadius: 16, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: c.muted }}>
            Collected today vs target
          </div>
          <div style={{ fontSize: 30, fontWeight: 900, marginTop: 6 }}>
            {formatUGX(paidToday)}
            <span style={{ fontSize: 16, fontWeight: 600, color: c.muted }}> / {formatUGX(expectedDaily)}</span>
          </div>
          <div style={{ height: 12, borderRadius: 999, background: c.barTrack, overflow: 'hidden', marginTop: 12 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 999 }} />
          </div>
          <div style={{ fontSize: 13, color: c.statSub, marginTop: 8 }}>
            {pct}% of today&apos;s target{remainingUGX > 0 ? ` · ${formatUGX(remainingUGX)} still to go` : ''}
          </div>
        </div>

        {/* Two stat tiles */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <div style={{ flex: 1, background: c.tileBg, border: c.border, borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: c.muted }}>
              {typeof tenantCount === 'number' ? 'Active tenants' : 'Vs yesterday'}
            </div>
            {typeof tenantCount === 'number' ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{tenantCount}</div>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: c.statSub }}>houses on book</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{formatUGX(paidYesterday)}</div>
                <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: diff >= 0 ? c.diffUp : c.diffDown }}>
                  {diff > 0 ? `+${formatUGX(diff)}` : diff < 0 ? `-${formatUGX(Math.abs(diff))}` : 'Same'} today
                </div>
              </>
            )}
          </div>
          <div style={{ flex: 1, background: c.tileBg, border: c.border, borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: c.muted }}>Remaining slots</div>
            <div style={{ fontSize: 22, fontWeight: 800, marginTop: 4 }}>{remainingSlots}</div>
            <div style={{ fontSize: 12, fontWeight: 600, marginTop: 4, color: c.statSub }}>
              {canPost ? `${formatUGX(headroom)} headroom` : 'Locked'}
            </div>
          </div>
        </div>

        {/* Verdict */}
        <div style={{
          borderRadius: 14,
          padding: '14px 18px',
          fontSize: 14,
          fontWeight: 700,
          background: canPost ? c.okBg : c.lockBg,
          color: canPost ? c.okFg : c.lockFg,
        }}>
          {canPost
            ? `✓ Can allocate today · up to ${formatUGX(perTenantMax)} per tenant`
            : '✗ Locked — reach your daily target to unlock allocations'}
        </div>

        <div style={{ textAlign: 'center', fontSize: 11, color: c.footer, marginTop: 20, letterSpacing: 0.5 }}>
          Powered by Welile · welileapp.com
        </div>
      </div>
    );
  },
);

AgentCapacityShareCard.displayName = 'AgentCapacityShareCard';

export default AgentCapacityShareCard;