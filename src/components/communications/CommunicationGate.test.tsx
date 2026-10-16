import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CommunicationGate from './CommunicationGate';
const state = vi.hoisted(() => ({
 rows: [{ id:'virtual',series_id:'virtual',version:1,title:'Agent notice',body:'Virtual message',communication_type:'important',link_path:null,starts_at:'2026-01-01T00:00:00Z',expires_at:'2099-01-01T00:00:00Z',acknowledged_at:null }],
 read:vi.fn(), ack:vi.fn(), refetch:vi.fn(),
}));
vi.mock('@/hooks/useAuth',()=>({useAuth:()=>({user:{id:'virtual-user'},role:'agent',roles:['agent'],loading:false,rolesResolved:true})}));
vi.mock('@/hooks/useCrmCommunications',()=>({
 useCommunicationInbox:()=>({data:state.rows,refetch:state.refetch,isLoading:false,error:null}),
 readCommunication:state.read,
 useCommunicationAcknowledgement:()=>({mutateAsync:state.ack,isPending:false}),
}));
describe('optional communication queue',()=>{
 beforeEach(()=>{state.read.mockReset();state.ack.mockReset();state.read.mockResolvedValue(state.rows[0]);state.ack.mockResolvedValue({});});
 afterEach(()=>{vi.useRealTimers();});
 it('never opens over a mandatory dialog and opens after it is dismissed',async()=>{
  vi.useFakeTimers();
  const mandatory=document.createElement('div');mandatory.setAttribute('role','dialog');mandatory.setAttribute('data-state','open');document.body.append(mandatory);
  render(<MemoryRouter initialEntries={['/dashboard/agent']}><CommunicationGate /></MemoryRouter>);
  await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});expect(state.read).not.toHaveBeenCalled();
  await act(async()=>{mandatory.remove();await Promise.resolve();});
  await act(async()=>{await vi.advanceTimersByTimeAsync(6000);});
  expect(screen.getByRole('dialog')).toHaveTextContent('Agent notice');
  fireEvent.click(screen.getByRole('button',{name:'Acknowledge'}));
  await act(async()=>{await Promise.resolve();});expect(state.ack).toHaveBeenCalledWith('virtual');
 });
 it('opens a freshly fetched message from the inbox',async()=>{
  render(<MemoryRouter initialEntries={['/dashboard/agent']}><CommunicationGate /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button',{name:'Open platform communications'}));
  fireEvent.click(screen.getByRole('button',{name:/Agent notice/}));
  await waitFor(()=>expect(state.read).toHaveBeenCalledWith('agent','virtual'));
  await waitFor(()=>expect(screen.getByRole('dialog')).toHaveTextContent('Virtual message'));
 });
});
