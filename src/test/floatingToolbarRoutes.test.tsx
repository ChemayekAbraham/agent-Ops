import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const mock = vi.hoisted(() => ({ getMyStaff: vi.fn() }));
vi.mock('@/hr/api', () => ({ getMyStaff: mock.getMyStaff }));
// The chat surface needs the full auth provider; the launcher visibility rule
// under test lives in FloatingToolbar + AgentAssistant, so stub the surface out.
vi.mock('@/components/ai-chat/AssistantChatSurface', () => ({ AssistantChatSurface: () => null }));

import FloatingToolbar from '@/components/FloatingToolbar';

const LAUNCHER = 'button[aria-label="Chat with Welile Assistant"]';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FloatingToolbar />
    </MemoryRouter>,
  );
}

describe('FloatingToolbar assistant launcher visibility', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    mock.getMyStaff.mockReset();
  });

  it('shows the launcher on a /dashboard route', () => {
    mock.getMyStaff.mockResolvedValue(null);
    renderAt('/dashboard/agent');
    expect(document.body.querySelector(LAUNCHER)).not.toBeNull();
  });

  it('shows the launcher on a nested /dashboard route', () => {
    mock.getMyStaff.mockResolvedValue(null);
    renderAt('/dashboard/cfo/reporting');
    expect(document.body.querySelector(LAUNCHER)).not.toBeNull();
  });

  it('hides the launcher outside dashboard routes', () => {
    mock.getMyStaff.mockResolvedValue(null);
    for (const path of ['/executive-hub?tab=partners-ops', '/welcome', '/auth', '/support/WSP-1']) {
      renderAt(path);
      expect(document.body.querySelector(LAUNCHER)).toBeNull();
      cleanup();
      document.body.innerHTML = '';
    }
  });

  it('does not confuse a path merely containing "dashboard"', () => {
    mock.getMyStaff.mockResolvedValue(null);
    renderAt('/settings/dashboard-prefs');
    expect(document.body.querySelector(LAUNCHER)).toBeNull();
  });
});
