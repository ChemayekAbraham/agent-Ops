import { act, cleanup, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useAssistantSpeech } from '@/components/agent/rentRequestAssistant/useAssistantSpeech';

const speak = vi.fn();
const cancel = vi.fn();
class Utterance {
  lang = '';
  voice = null;
  rate = 1;
  pitch = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {}
}

const voice = (name: string, lang: string) => ({
  name, lang, voiceURI: name, default: false, localService: true,
}) as SpeechSynthesisVoice;

const setVoices = (...list: SpeechSynthesisVoice[]) =>
  vi.stubGlobal('speechSynthesis', { speak, cancel, getVoices: () => list });

describe('Rent Request Assistant voice playback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    vi.stubGlobal('speechSynthesis', { speak, cancel, getVoices: () => [] });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('starts on a user tap and automatically reads the next reply once', () => {
    const { result, rerender } = renderHook(({ text }) => useAssistantSpeech(text, true, 'agent-1'), { initialProps: { text: 'What is the rent?' } });
    expect(speak).not.toHaveBeenCalled();
    act(() => result.current.toggle());
    expect(speak).toHaveBeenCalledTimes(1);
    rerender({ text: 'Who is the landlord?' });
    expect(speak).toHaveBeenCalledTimes(2);
    expect(speak.mock.calls[1][0].text).toBe('Who is the landlord?');
    rerender({ text: 'Who is the landlord?' });
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('stops immediately and does not restart until the next reply or replay', () => {
    const { result } = renderHook(() => useAssistantSpeech('Current question', true, 'agent-1'));
    act(() => result.current.toggle());
    act(() => result.current.stop());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.current.speaking).toBe(false);
    expect(speak).toHaveBeenCalledTimes(1);
    act(() => result.current.replay());
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('does not read later replies after voice is turned off', () => {
    const { result, rerender } = renderHook(({ text }) => useAssistantSpeech(text, true, 'agent-1'), { initialProps: { text: 'First' } });
    act(() => result.current.toggle());
    act(() => result.current.toggle());
    rerender({ text: 'Second' });
    expect(result.current.enabled).toBe(false);
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it.each(['close', 'account change'])('cancels and resets playback on %s', (reason) => {
    const { result, rerender } = renderHook(({ open, account }) => useAssistantSpeech('Question', open, account), { initialProps: { open: true, account: 'agent-1' } });
    act(() => result.current.toggle());
    rerender({ open: reason !== 'close', account: reason === 'account change' ? 'agent-2' : 'agent-1' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result.current.enabled).toBe(false);
    expect(result.current.speaking).toBe(false);
  });

  it('speaks UGX as Ugandan shillings without altering the amount', () => {
    const { result } = renderHook(() => useAssistantSpeech('UGX 50,000', true, 'agent-1'));
    act(() => result.current.toggle());
    expect(speak.mock.calls[0][0].text).toBe('Ugandan shillings 50,000');
  });

  it('clears playback and turns voice off after a speech failure', () => {
    const { result } = renderHook(() => useAssistantSpeech('Question', true, 'agent-1'));
    act(() => result.current.toggle());
    act(() => speak.mock.calls[0][0].onerror({ error: 'not-allowed' }));
    expect(result.current.failed).toBe(true);
    expect(result.current.speaking).toBe(false);
    expect(result.current.enabled).toBe(false);
  });

  it('handles a browser without speech support', () => {
    vi.stubGlobal('speechSynthesis', undefined);
    // The feature checks API presence; remove it entirely for an unsupported browser.
    Reflect.deleteProperty(window, 'speechSynthesis');
    const { result } = renderHook(() => useAssistantSpeech('Question', true, 'agent-1'));
    expect(result.current.supported).toBe(false);
    act(() => result.current.toggle());
    expect(speak).not.toHaveBeenCalled();
  });

  it('prefers a female natural voice over a male one and over plain desktop voices', () => {
    setVoices(
      voice('Microsoft David Desktop', 'en-US'),
      voice('Microsoft Zira Desktop', 'en-US'),
      voice('Google UK English Male', 'en-GB'),
      voice('Microsoft Aria (Natural)', 'en-US'),
    );
    const { result } = renderHook(() => useAssistantSpeech('Question', true, 'agent-1'));
    act(() => result.current.toggle());
    expect(speak.mock.calls[0][0].voice?.name).toBe('Microsoft Aria (Natural)');
  });

  it('falls back to any female voice when no natural engine exists', () => {
    setVoices(
      voice('Microsoft David Desktop', 'en-US'),
      voice('Microsoft Hazel Desktop', 'en-GB'),
    );
    const { result } = renderHook(() => useAssistantSpeech('Question', true, 'agent-1'));
    act(() => result.current.toggle());
    expect(speak.mock.calls[0][0].voice?.name).toBe('Microsoft Hazel Desktop');
  });

  it('still speaks when only male voices are installed', () => {
    setVoices(voice('Microsoft David Desktop', 'en-US'), voice('Microsoft Mark Desktop', 'en-US'));
    const { result } = renderHook(() => useAssistantSpeech('Question', true, 'agent-1'));
    act(() => result.current.toggle());
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].voice?.name).toBe('Microsoft David Desktop');
  });

  it('reads slower and warmer than the browser default', () => {
    const { result } = renderHook(() => useAssistantSpeech('Question', true, 'agent-1'));
    act(() => result.current.toggle());
    expect(speak.mock.calls[0][0].rate).toBeLessThan(1);
    expect(speak.mock.calls[0][0].pitch).toBeGreaterThan(1);
  });

  it('drops markdown symbols and says percent out loud', () => {
    const { result } = renderHook(() => useAssistantSpeech('- Rent is **UGX 200,000**\n- Fee is 15%', true, 'agent-1'));
    act(() => result.current.toggle());
    expect(speak.mock.calls[0][0].text).toBe('Rent is Ugandan shillings 200,000. Fee is 15 percent');
  });
});
