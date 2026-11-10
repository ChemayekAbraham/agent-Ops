import { useState, type ReactNode } from 'react';
import type { Stage } from './reviewTypes';
import type { BoardRow } from './boardApi';
import type { TenantHealth } from './paymentHealth';
import { daysHere, landlordOpsChips, phoneLast4, type ChipModel } from './boardRowModel';
import { DeskCallButton, type CallSubjectKind } from './deskCall';
import { Chip, DecisionButton, MenuItem, MoreMenu, moneyCard, moneyFull, splitDecisionLabel, stackLayout, type ButtonVariant } from './ui';
import type { OpenDrawer } from './ReadyBoard';
import { KindChip } from './KindChip';

export type LandlordCardPrimary = {
  label: string;
  onClick: () => void;
  variant: ButtonVariant;
  disabled: boolean;
  title?: string;
};

/**
 * Landlord Ops, phone card. Three short lines and one button, so about three
 * cards fit on a phone screen:
 *   1. tenant · UGX rent · "N days here" (amber > 2 days, red > 5)
 *   2. landlord and the last four digits of their phone
 *   3. one chip row (checks, tenant, LC1, repayment, agent grade)
 * Calls to the tenant and agent, Send back, Hold and Concern live in the ⋯ menu.
 */
export function LandlordOpsCard({
  row,
  stage,
  canAct,
  board,
  primary,
  health,
  onOpen,
  extraMenu,
  waitingLine,
  noteLine,
  needsRoleTitle,
}: {
  row: BoardRow;
  stage: Stage;
  canAct: boolean;
  board: boolean;
  primary: LandlordCardPrimary | null;
  health?: TenantHealth;
  onOpen: OpenDrawer;
  /** Other decisions for this row (Reject…, Call again…), already labelled. */
  extraMenu?: (close: () => void) => ReactNode;
  /** "Waiting on … · 3 h left" for a parked row. */
  waitingLine?: ReactNode;
  noteLine?: ReactNode;
  needsRoleTitle: string;
}) {
  const [calling, setCalling] = useState<CallSubjectKind | null>(null);
  const days = daysHere(row.days_here);
  const last4 = phoneLast4(row.landlord_phone);
  const chips: ChipModel[] = landlordOpsChips(row, health);
  const label = primary ? splitDecisionLabel(primary.label).label : null;
  const mainIsLandlordCall = row.decision === 'call' || row.decision === 'call_again';

  const target = (subject: CallSubjectKind) =>
    subject === 'agent'
      ? { requestId: row.id, desk: stage, subject, calleeId: row.agent_id, name: row.agent, phone: row.agent_phone }
      : subject === 'tenant'
        ? { requestId: row.id, desk: stage, subject, calleeId: row.tenant_id, name: row.tenant, phone: row.tenant_phone }
        : { requestId: row.id, desk: stage, subject, calleeId: null, name: row.landlord, phone: row.landlord_phone };

  const callItem = (subject: CallSubjectKind, who: string | null, phone: string | null, close: () => void) => {
    const word = subject === 'agent' ? 'agent' : subject === 'tenant' ? 'tenant' : 'landlord';
    const off = !canAct || !phone;
    return (
      <MenuItem
        key={`call-${subject}`}
        disabled={off}
        title={!canAct ? needsRoleTitle : !phone ? 'No number on file' : `Call ${who ?? `the ${word}`} from the company line`}
        onClick={() => {
          close();
          setCalling(subject);
        }}
      >
        {`Call ${word}${who ? ` (${who})` : ''}${phone ? '' : ' — no number'}`}
      </MenuItem>
    );
  };

  const menu = (close: () => void) => (
    <>
      {callItem('tenant', row.tenant, row.tenant_phone, close)}
      {callItem('agent', row.agent, row.agent_phone, close)}
      {!mainIsLandlordCall && callItem('landlord', row.landlord, row.landlord_phone, close)}
      <MenuItem disabled={!canAct} title={canAct ? 'Opens the review so you can give a reason' : needsRoleTitle} onClick={() => { close(); onOpen(row.id, 'send_back'); }}>
        Send back to the agent…
      </MenuItem>
      <MenuItem disabled={!canAct} title={canAct ? 'Park it here and say who it waits on' : needsRoleTitle} onClick={() => { close(); onOpen(row.id, 'wait'); }}>
        Hold (wait on someone)…
      </MenuItem>
      <MenuItem onClick={() => { close(); onOpen(row.id, 'concern'); }}>Log a concern…</MenuItem>
      {extraMenu?.(close)}
      <MenuItem onClick={() => { close(); onOpen(row.id); }}>Open the full review</MenuItem>
    </>
  );

  return (
    <li data-row={row.id} data-landlord-card style={{ ...stackLayout(4), listStyle: 'none' }}>
      <article className="desk-tile" style={{ ...stackLayout(6), padding: 12, minWidth: 0 }} data-rowcard>
        {/* One line each: the name gives way (ellipsis); rent and days never wrap. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h3
            className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}
            style={{ margin: 0, flex: '1 1 auto', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={row.tenant ?? undefined}
            data-line="tenant"
          >
            {row.tenant ?? '—'}
          </h3>
          <span className="text-sm font-medium tabular-nums text-foreground" style={{ flex: 'none', whiteSpace: 'nowrap' }} title={moneyFull(row.rent)} data-line="rent">
            {moneyCard(row.rent)}
          </span>
          <span style={{ flex: 'none' }}>
            <Chip tone={days.tone} strong={days.tone === 'bad'} title={`${Number(row.days_here ?? 0).toFixed(1)} days at Landlord Ops`}>
              <span data-days-tone={days.tone} style={{ whiteSpace: 'nowrap' }}>{days.text}</span>
            </Chip>
          </span>
        </div>

        <p className="text-sm text-muted-foreground" style={{ margin: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.landlord ?? undefined} data-line="landlord">
          Landlord {row.landlord ?? '—'}
          {last4 ? <span className="tabular-nums">{`, phone ends ${last4}`}</span> : <span>, no phone on file</span>}
        </p>

        {/* One chip row: it scrolls sideways rather than wrapping onto more lines. */}
        <div className="desk-scroll-row [&>*]:shrink-0" style={{ display: 'flex', flexWrap: 'nowrap', overflowX: 'auto', gap: 6, minWidth: 0 }} data-line="chips">
          <KindChip kind={row.kind} />
          {chips.map((c) => (
            <Chip key={c.key} tone={c.tone} title={c.title} strong={c.strong}>
              {c.text}
            </Chip>
          ))}
        </div>

        {waitingLine && <p className="desk-label" style={{ margin: 0 }}>{waitingLine}</p>}

        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
          {primary && label ? (
            <DecisionButton
              size="md"
              variant={primary.variant}
              disabled={primary.disabled}
              title={primary.title}
              onClick={primary.onClick}
              style={{ flex: '1 1 auto', minWidth: 0 }}
            >
              {label}
            </DecisionButton>
          ) : (
            <span style={{ flex: '1 1 auto' }} />
          )}
          <MoreMenu label={`More for ${row.tenant ?? 'this request'}`}>{menu}</MoreMenu>
        </div>

        {calling && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }} data-line="call">
            <DeskCallButton target={target(calling)} startActive disabled={!canAct} onClosed={() => setCalling(null)} />
          </div>
        )}
      </article>
      {noteLine}
    </li>
  );
}

export default LandlordOpsCard;
