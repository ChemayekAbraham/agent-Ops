import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import {
  Chip,
  CountChip,
  DECISION_WORDS,
  DecisionButton,
  DeskPopover,
  EmptyState,
  ErrorLine,
  Fold,
  GradeBadge,
  LoadingRows,
  MenuItem,
  MoreMenu,
  Segmented,
  Tile,
  TileRow,
  decisionVariant,
  gradeStyle,
} from '..';
import { badgeFor } from '../../agentGrade';

const UI_DIR = resolve(__dirname, '..');
const kitSources = readdirSync(UI_DIR)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => ({ f, src: readFileSync(resolve(UI_DIR, f), 'utf8') }));

/* ───────────── snapshots: one of each piece ───────────── */

describe('kit snapshots', () => {
  it('GradeBadge, every grade', () => {
    const { container } = render(
      <div>
        {['A', 'B', 'C', 'D', 'N', 'X', null].map((g) => (
          <GradeBadge key={String(g)} grade={g} />
        ))}
      </div>,
    );
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('Chip and CountChip, every tone', () => {
    const { container } = render(
      <div>
        <Chip>idle</Chip>
        <Chip tone="ok">ok</Chip>
        <Chip tone="warn" size="sm">
          warn
        </Chip>
        <Chip tone="bad" strong>
          Time up
        </Chip>
        <CountChip n={12} />
        <CountChip n={null} />
      </div>,
    );
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('DecisionButton, every variant and size', () => {
    const { container } = render(
      <div>
        <DecisionButton variant="primary">Pass</DecisionButton>
        <DecisionButton>Open the review</DecisionButton>
        <DecisionButton variant="danger">Reject</DecisionButton>
        <DecisionButton variant="warn">Retry the move only</DecisionButton>
        <DecisionButton variant="ok" size="md">
          Push all 3
        </DecisionButton>
        <MenuItem>Send back…</MenuItem>
      </div>,
    );
    expect(container.innerHTML).toMatchSnapshot();
  });

  it('Segmented, Tile, Fold, states', () => {
    const { container } = render(
      <div>
        <Segmented ariaLabel="Period" options={[{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }]} value="today" onChange={() => {}} />
        <TileRow max={4}>
          <Tile label="Fund today" value="UGX 1,200,000" sub="3 on the board, not held" board={false} />
          <Tile label="Untouched 48 h" value="2" tone="warn" board />
        </TileRow>
        <Fold title="Rules for this desk" count={4} changed board={false}>
          <p>inside</p>
        </Fold>
        <EmptyState>Nothing is waiting at this desk.</EmptyState>
        <ErrorLine>The board could not load: offline</ErrorLine>
        <LoadingRows rows={2} height={20} />
      </div>,
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
});

/* ───────────── behaviour ───────────── */

describe('GradeBadge', () => {
  it('labels and colours each grade from the desk tokens', () => {
    expect(['A', 'B', 'C', 'D', 'N', 'X', null, 'Q'].map((g) => gradeStyle(g).text)).toEqual([
      'A', 'B', 'C', 'D', 'New', 'Blocked', 'Not graded', 'Not graded',
    ]);
    expect(gradeStyle('A').cls).toContain('--desk-emerald');
    expect(gradeStyle('B').cls).toContain('--desk-teal');
    expect(gradeStyle('C').cls).toContain('--desk-amber');
    expect(gradeStyle('D').cls).toContain('--desk-red');
    expect(gradeStyle('X').cls).toContain('--desk-blocked');
    expect(gradeStyle('a').text).toBe('A');
  });
  it('is the same badge the agent grade uses', () => {
    expect(badgeFor('C')).toEqual(gradeStyle('C'));
  });
});

describe('DecisionButton', () => {
  it('rejects get the red button, everything else the violet one', () => {
    expect(decisionVariant('reject')).toBe('danger');
    expect(decisionVariant('pass')).toBe('primary');
    expect(decisionVariant('send_back')).toBe('primary');
  });
  it('documents the main-button words', () => {
    expect(DECISION_WORDS).toEqual(['Pass', 'Send back', 'Reject', 'Transfer → …', 'Call …', 'Finish checks', 'Wait …']);
  });
  it('is a real button that stays disabled', () => {
    const onClick = vi.fn();
    render(
      <DecisionButton disabled onClick={onClick}>
        Pass
      </DecisionButton>,
    );
    const b = screen.getByRole('button', { name: 'Pass' });
    expect(b.getAttribute('type')).toBe('button');
    fireEvent.click(b);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Segmented', () => {
  it('presses one option and can clear it when deselectable', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Segmented ariaLabel="Show only" deselectable options={[{ value: 'pass', label: 'Pass', count: 3, tone: 'ok' }, { value: 'reject', label: 'Reject' }]} value={null} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Pass/ }));
    expect(onChange).toHaveBeenLastCalledWith('pass');
    rerender(
      <Segmented ariaLabel="Show only" deselectable options={[{ value: 'pass', label: 'Pass', count: 3, tone: 'ok' }, { value: 'reject', label: 'Reject' }]} value="pass" onChange={onChange} />,
    );
    const pass = screen.getByRole('button', { name: /Pass/ });
    expect(pass.getAttribute('aria-pressed')).toBe('true');
    expect(pass.className).toContain('--desk-ok');
    expect(pass.textContent).toBe('Pass3');
    fireEvent.click(pass);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe('Fold', () => {
  it('shows the count and the changed dot, and mounts children only when open', () => {
    render(
      <Fold title="Rules for this desk" count={4} changed board={false}>
        <p>inside</p>
      </Fold>,
    );
    expect(screen.getByText('4')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Changed this week' })).not.toBeNull();
    expect(screen.queryByText('inside')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Rules for this desk/ }));
    expect(screen.getByText('inside')).not.toBeNull();
  });
  it('shows a dash while the count is loading', () => {
    render(<Fold title="Waiting on…" count={null} board={false}>x</Fold>);
    expect(screen.getByText('—')).not.toBeNull();
  });
});

describe('DeskPopover', () => {
  it('opens on a press, closes on Escape, and renders in place (no portal)', () => {
    const { container } = render(
      <div className="desk-root">
        <MoreMenu label="More for Amina">{(close) => <MenuItem onClick={close}>Open the review</MenuItem>}</MoreMenu>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More for Amina' }));
    const dialog = screen.getByRole('dialog', { name: 'More for Amina' });
    expect(container.querySelector('.desk-root')?.contains(dialog)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('is the popover the old Pop import gives', async () => {
    const { Pop } = await import('../../Pop');
    expect(Pop).toBe(DeskPopover);
  });
});

/* ───────────── late-CSS safety and tokens ───────────── */

describe('late-CSS safety', () => {
  it('pills hold their layout inline', () => {
    render(
      <div>
        <GradeBadge grade="A" />
        <Chip>Held until 14:05</Chip>
        <DecisionButton>Pass</DecisionButton>
      </div>,
    );
    for (const el of [screen.getByText('A'), screen.getByText('Held until 14:05'), screen.getByRole('button', { name: 'Pass' })]) {
      expect(el.style.whiteSpace).toBe('nowrap');
      expect(el.style.display).toBe('inline-flex');
      expect(el.style.paddingLeft).not.toBe('');
    }
  });
  it('rows, stacks and tiles hold their layout inline', () => {
    render(
      <div>
        <Segmented ariaLabel="Period" options={[{ value: 'a', label: 'A' }]} value="a" onChange={() => {}} />
        <Tile label="Fund today" value="1" board={false} />
      </div>,
    );
    const group = screen.getByRole('group', { name: 'Period' });
    expect(group.style.display).toBe('flex');
    expect(group.style.gap).toBe('6px');
    const tile = screen.getByText('Fund today').parentElement as HTMLElement;
    expect(tile.style.display).toBe('flex');
    expect(tile.style.padding).toBe('16px');
  });
});

describe('colours come from tokens', () => {
  it('no kit file names a Tailwind palette colour or a raw hex', () => {
    const palette = /\b(?:bg|text|border|ring|from|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\d{2,3})?\b/;
    for (const { f, src } of kitSources) {
      expect(src, f).not.toMatch(palette);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    }
  });
  it('every grade token is defined on .desk-root', () => {
    const css = readFileSync(resolve(__dirname, '../../../../index.css'), 'utf8');
    for (const t of ['--desk-emerald', '--desk-teal', '--desk-amber', '--desk-red', '--desk-slate', '--desk-blocked', '--desk-blocked-line', '--desk-on-fill', '--desk-on-amber']) {
      expect(css, t).toContain(`${t}:`);
    }
  });
});
