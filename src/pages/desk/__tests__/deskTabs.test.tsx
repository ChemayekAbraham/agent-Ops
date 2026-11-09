import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import { DeskTabs, TAB_LAYOUT, fadeEdges, scrollTargetFor } from '../DeskTabs';
import { DESKS } from '../deskConfig';

const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf8');
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
};

describe('desk tab bar', () => {
  it('every tab carries nowrap and no-shrink, so labels never run together', () => {
    render(
      <MemoryRouter>
        <DeskTabs desks={DESKS} activeId="cfo" board={false} />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(DESKS.length);
    for (const a of links) {
      expect(a.className).toContain('whitespace-nowrap');
      expect(a.className).toContain('shrink-0');
      expect(a.className).toContain('desk-tab');
      // Inline, so it holds before index.css (where the utilities live) has loaded.
      expect(a.style.whiteSpace).toBe('nowrap');
      expect(a.style.flexShrink).toBe('0');
      expect(a.style.paddingLeft).toBe('12px');
    }
    const nav = screen.getByRole('navigation', { name: 'Desks' });
    expect(nav.style.display).toBe('flex');
    expect(nav.style.overflowX).toBe('auto');
    expect(nav.style.gap).toBe('4px');
    expect(TAB_LAYOUT).toMatch(/px-3/);
    expect(screen.getByRole('link', { name: 'Funders Dashboard' }).getAttribute('aria-current')).toBe('page');
  });

  it('the stylesheet backs it up: no shrink, nowrap, 4px gap, scrollable row with a hidden scrollbar', () => {
    const tab = rule('.desk-root .desk-tab');
    expect(tab).toMatch(/flex-shrink:\s*0/);
    expect(tab).toMatch(/white-space:\s*nowrap/);
    const bar = rule('.desk-root .desk-tabs');
    expect(bar).toMatch(/display:\s*flex/);
    expect(bar).toMatch(/gap:\s*4px/);
    expect(bar).toMatch(/overflow-x:\s*auto/);
    expect(bar).toMatch(/scrollbar-width:\s*none/);
  });

  it('fades only the edge that has more tabs', () => {
    expect(fadeEdges(0, 400, 400)).toBe('none');
    expect(fadeEdges(0, 400, 900)).toBe('end');
    expect(fadeEdges(500, 400, 900)).toBe('start');
    expect(fadeEdges(200, 400, 900)).toBe('both');
  });

  it('scrolls the active tab into view only when it is out of view', () => {
    expect(scrollTargetFor(100, 80, 0, 400)).toBeNull();
    expect(scrollTargetFor(700, 100, 0, 400)).toBe(700 + 100 + 44 - 400);
    expect(scrollTargetFor(20, 80, 300, 400)).toBe(0);
  });
});
