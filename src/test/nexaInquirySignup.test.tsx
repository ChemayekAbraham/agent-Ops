import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWelileAI } from '@/hooks/useWelileAI';

const { getSession, signInWithPassword } = vi.hoisted(() => ({getSession:vi.fn(),signInWithPassword:vi.fn()}));
vi.mock('@/integrations/supabase/client', () => ({supabase:{auth:{getSession,signInWithPassword},from:() => ({select:() => ({eq:() => ({eq:() => ({limit:async () => ({data:[],error:null})})})})})}}));

describe('Nexa inquiry signup session safety', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    getSession.mockResolvedValue({data:{session:null}});
    signInWithPassword.mockClear();
  });
  it('a phone inquiry does not authenticate or disclose an existing account', async () => {
    const fetcher = vi.spyOn(globalThis,'fetch');
    const { result } = renderHook(() => useWelileAI());
    await act(async () => { await result.current.sendMessage('TEST 0700000000'); });
    expect(result.current.signupResult?.status).toBe('signup_required');
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('never signs in using credentials delivered by a chat event', async () => {
    const encoder = new TextEncoder();
    const malicious = {autoSignup:{status:'created',email:'test@example.invalid',tempPassword:'TEST_SECRET'},choices:[{delta:{content:'TEST_REPLY'}}]};
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(new ReadableStream({start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(malicious)}\n\ndata: [DONE]\n\n`)); controller.close();
    }}),{headers:{'Content-Type':'text/event-stream'}}));
    const { result } = renderHook(() => useWelileAI());
    await act(async () => { await result.current.sendMessage('TEST_STREAM_INQUIRY', {leadRole:'landlord'}); });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.signupResult?.role).toBe('landlord');
    expect(result.current.signupResult).not.toHaveProperty('email');
    expect(result.current.signupResult).not.toHaveProperty('tempPassword');
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(result.current.messages.at(-1)?.content).toBe('TEST_REPLY');
  });
  it('does not offer a new signup for an already signed-in session', async () => {
    getSession.mockResolvedValue({data:{session:{access_token:'TEST_TOKEN'}}});
    const { result } = renderHook(() => useWelileAI());
    await act(async () => { await result.current.sendMessage('TEST 0700000000'); });
    expect(result.current.signupResult).toBeNull();
    expect(signInWithPassword).not.toHaveBeenCalled();
  });
});