import type { ReactNode } from 'react';
import { LABEL } from '../deskTheme';
import { Chip } from './Chip';
import { DecisionButton, type ButtonVariant } from './DecisionButton';
import { MoreMenu } from './DeskPopover';
import { stackLayout } from './layout';

/**
 * The phone card for one decision row:
 *
 *   title      the tenant, 16px semibold
 *   subtitle   agent · grade
 *   chips      at most three; the rest are counted as "+n"
 *   meta       UGX · days
 *   action     one full-width primary button (≤24 characters), the "⋯" menu
 *              beside it, and the button's target on the line under it
 */

export const PRIMARY_LABEL_MAX = 24;
export const CHIP_MAX = 3;

/**
 * "Transfer → Kato James (B, 2.4 km)" → { label: "Transfer", detail: "Kato James (B, 2.4 km)" }.
 * Anything still longer than 24 characters is cut with "…" and kept whole in `detail`.
 */
export function splitDecisionLabel(text: string): { label: string; detail: string | null } {
  const t = text.trim();
  const arrow = t.split(/\s*→\s*/);
  if (arrow.length > 1 && arrow[0]) return { label: arrow[0].slice(0, PRIMARY_LABEL_MAX), detail: arrow.slice(1).join(' → ') || null };
  if (t.length <= PRIMARY_LABEL_MAX) return { label: t, detail: null };
  return { label: `${t.slice(0, PRIMARY_LABEL_MAX - 1).trimEnd()}…`, detail: t };
}

export function RowCard({
  title,
  subtitle,
  chips = [],
  meta,
  primary,
  menu,
  menuLabel,
  why,
  board = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  chips?: ReactNode[];
  meta?: ReactNode;
  primary?: { label: string; onClick: () => void; variant?: ButtonVariant; disabled?: boolean; title?: string; detail?: ReactNode };
  /** The "⋯" menu's items, given a close() for each. */
  menu?: (close: () => void) => ReactNode;
  menuLabel?: string;
  /** The row's reason, in plain words. */
  why?: ReactNode;
  board?: boolean;
}) {
  const shownChips = chips.slice(0, CHIP_MAX);
  const extra = chips.length - shownChips.length;
  const split = primary ? splitDecisionLabel(primary.label) : null;
  const detail = primary?.detail ?? split?.detail ?? null;

  return (
    <article className="desk-tile" style={{ ...stackLayout(8), padding: 12, minWidth: 0 }} data-rowcard>
      <div style={stackLayout(2)}>
        <h3 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`} style={{ margin: 0, overflowWrap: 'anywhere' }}>
          {title}
        </h3>
        {subtitle && <div className="text-sm text-muted-foreground" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>{subtitle}</div>}
      </div>
      {chips.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {shownChips}
          {extra > 0 && <Chip title={`${extra} more`}>+{extra}</Chip>}
        </div>
      )}
      {meta && <div className="text-sm tabular-nums text-foreground" style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px' }}>{meta}</div>}
      {why && <div className={LABEL}>{why}</div>}
      {(primary || menu) && (
        <div style={stackLayout(4)}>
          <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
            {primary && split && (
              <DecisionButton
                size="md"
                variant={primary.variant ?? 'primary'}
                disabled={primary.disabled}
                title={primary.title ?? (detail ? `${split.label} → ${typeof detail === 'string' ? detail : ''}`.trim() : undefined)}
                onClick={primary.onClick}
                style={{ flex: '1 1 auto', minWidth: 0 }}
              >
                {split.label}
              </DecisionButton>
            )}
            {menu && <MoreMenu label={menuLabel ?? 'More for this request'}>{menu}</MoreMenu>}
          </div>
          {detail && <div className={LABEL} style={{ overflowWrap: 'anywhere' }}>{detail}</div>}
        </div>
      )}
    </article>
  );
}
