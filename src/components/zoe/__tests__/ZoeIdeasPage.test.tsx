import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import IdeasPage from '@/pages/me/IdeasPage';
import type { ZoeIdeasListResponse } from '@/lib/zoe';

vi.mock('@/components/layout/PersonalLayout', () => ({
  default: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div data-testid="mock-personal-layout">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-coo', email: 'coo@welile.com' },
    roles: ['coo'],
  }),
}));

vi.mock('@/components/zoe/useZoeAssistant', () => ({
  useZoeAccess: () => ({ data: true, isLoading: false }),
}));

const SAMPLE_IDEAS_RESPONSE: ZoeIdeasListResponse = {
  can_manage_ideas: true,
  counts: {
    total: 2,
    new: 1,
    being_looked_at: 1,
    done: 0,
    not_now: 0,
  },
  ideas: [
    {
      id: 'idea-1',
      created_by: 'u-1',
      created_by_name: 'Jane Gimono',
      created_by_roles: ['tenant_ops'],
      title: 'Add 10:00 EAT Landlord Ops verification cut-off',
      suggestion: 'Review the Landlord Ops verification queue twice daily at 10:00 and 15:00 EAT.',
      evidence_summary: 'Landlord Ops desk wait averaged 18.5 hours across 64 requests in the last 4 weeks.',
      figures: { avg_wait_hours: 18.5, requests_count: 64 },
      source_label: 'rent_request_timing',
      period_label: 'Last 4 weeks',
      category: 'desk_wait',
      screen_path: '/coo-dashboard',
      status: 'new',
      status_updated_by: null,
      status_updated_by_name: null,
      status_updated_at: null,
      status_note: null,
      created_at: '2026-10-26T08:00:00Z',
    },
    {
      id: 'idea-2',
      created_by: 'u-2',
      created_by_name: 'Winnie Asiimwe',
      created_by_roles: ['operations'],
      title: 'Prioritize Wakiso morning collection check-ins',
      suggestion: 'Run a 09:00 EAT collector check-in for Wakiso agents with due Rent Plans.',
      evidence_summary: 'Wakiso collection coverage is 14% below its 4-week average.',
      figures: { coverage_drop_pct: 14 },
      source_label: 'assistant_staff_insight_collection_coverage_trends',
      period_label: 'Last 4 weeks',
      category: 'collections',
      screen_path: '/tenant-ops/workspace',
      status: 'being_looked_at',
      status_updated_by: 'u-coo',
      status_updated_by_name: 'COO Office',
      status_updated_at: '2026-10-26T09:00:00Z',
      status_note: null,
      created_at: '2026-10-25T10:00:00Z',
    },
  ],
};

describe('/me/ideas Review Page (Ideas for Welile)', () => {
  it('lists saved ideas with evidence, figures, source, person, date, and lets managers change status as a screen action', async () => {
    const onUpdateStatus = vi.fn().mockResolvedValue({ ok: true });

    render(
      <MemoryRouter>
        <IdeasPage
          initialData={SAMPLE_IDEAS_RESPONSE}
          onUpdateStatus={onUpdateStatus}
          forceAccessGranted={true}
          overrideRoles={['coo']}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-ideas-page')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-idea-card-idea-1')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-idea-card-idea-2')).toBeInTheDocument();

    // Check status dropdown is rendered for manager/COO
    const select1 = screen.getByTestId('zoe-idea-status-select-idea-1') as HTMLSelectElement;
    expect(select1.value).toBe('new');

    // Change status to "being_looked_at"
    fireEvent.change(select1, { target: { value: 'being_looked_at' } });

    await waitFor(() => {
      expect(onUpdateStatus).toHaveBeenCalledWith({
        idea_id: 'idea-1',
        status: 'being_looked_at',
      });
    });

    expect(await screen.findByTestId('zoe-ideas-success')).toHaveTextContent(
      'Updated "Add 10:00 EAT Landlord Ops verification cut-off" to "Being looked at".',
    );
    expect(screen.getByTestId('zoe-idea-status-badge-idea-1')).toHaveTextContent(
      'Being looked at',
    );
  });

  it('shows read-only status for non-manager staff on /me/ideas', () => {
    const nonManagerData: ZoeIdeasListResponse = {
      ...SAMPLE_IDEAS_RESPONSE,
      can_manage_ideas: false,
    };

    render(
      <MemoryRouter>
        <IdeasPage
          initialData={nonManagerData}
          forceAccessGranted={true}
          overrideRoles={['employee']}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-idea-status-readonly-idea-1')).toHaveTextContent(
      'Status updated by managers only',
    );
    expect(screen.queryByTestId('zoe-idea-status-select-idea-1')).not.toBeInTheDocument();
  });
});
