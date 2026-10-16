import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommunicationDialog } from './CommunicationDialog';
import type { Communication } from '@/lib/crmCommunications';
const row: Communication = { id: 'virtual', series_id: 'virtual', version: 1, title: 'Platform update', body: '<script>alert(1)</script>\nA plain message.', communication_type: 'important', link_path: null, starts_at: '2026-10-16T00:00:00Z', expires_at: '2099-10-17T00:00:00Z' };
describe('simple communication dialog', () => {
 it('renders plain text, relevant type and explicit acknowledgement', () => { const ack=vi.fn(); render(<CommunicationDialog communication={row} open onClose={vi.fn()} onAcknowledge={ack} />); expect(screen.getByText('Important notice')).toBeInTheDocument(); expect(screen.getByText(/<script>/)).toBeInTheDocument(); expect(document.querySelector('script')).toBeNull(); fireEvent.click(screen.getByRole('button',{name:'Acknowledge'})); expect(ack).toHaveBeenCalledOnce(); });
 it('does not offer a duplicate acknowledgement', () => { render(<CommunicationDialog communication={{...row,acknowledged_at:'2026-10-16T00:00:00Z'}} open onClose={vi.fn()} onAcknowledge={vi.fn()} />); expect(screen.queryByRole('button',{name:'Acknowledge'})).not.toBeInTheDocument(); });
 it('keeps preview non-submitting', () => { const ack=vi.fn(); render(<CommunicationDialog communication={row} open preview onClose={vi.fn()} onAcknowledge={ack} />); expect(screen.queryByRole('button',{name:'Acknowledge'})).not.toBeInTheDocument(); });
 it('provides the selected existing destination and visible server error', () => { const go=vi.fn(); render(<CommunicationDialog communication={{...row,communication_type:'action',link_path:'/dashboard/agent'}} open onClose={vi.fn()} onNavigate={go} error="No longer available" />); fireEvent.click(screen.getByRole('button',{name:'Open'})); expect(go).toHaveBeenCalledOnce(); expect(screen.getByRole('alert')).toHaveTextContent('No longer available'); });
});
