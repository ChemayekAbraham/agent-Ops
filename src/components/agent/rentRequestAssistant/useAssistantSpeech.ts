import { useCallback, useEffect, useRef, useState } from 'react';

/** Browser voice playback; never sends the agent's answers to a speech service. */
export function useAssistantSpeech(text: string, open: boolean, accountId?: string) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [enabled, setEnabled] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<SpeechSynthesisUtterance | null>(null);
  const lastText = useRef('');

  const stop = useCallback(() => {
    if (active.current && supported) {
      active.current = null;
      window.speechSynthesis.cancel();
    }
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback((message: string) => {
    if (!supported || !open || !message.trim()) return;
    stop();
    const utterance = new SpeechSynthesisUtterance(message.replace(/\bUGX\b/g, 'Ugandan shillings'));
    utterance.lang = 'en-GB';
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => voice.lang === 'en-GB')
      ?? voices.find((voice) => voice.lang.startsWith('en')) ?? null;
    active.current = utterance;
    lastText.current = message;
    setFailed(false);
    setSpeaking(true);
    utterance.onend = () => {
      if (active.current !== utterance) return;
      active.current = null;
      setSpeaking(false);
    };
    utterance.onerror = (event) => {
      if (active.current !== utterance) return;
      active.current = null;
      setSpeaking(false);
      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        setFailed(true);
        setEnabled(false);
      }
    };
    window.speechSynthesis.speak(utterance);
  }, [open, stop, supported]);

  const toggle = useCallback(() => {
    if (enabled) {
      setEnabled(false);
      stop();
    } else if (supported && open) {
      setEnabled(true);
      // Start directly in the tap handler so mobile browsers allow playback.
      speak(text);
    }
  }, [enabled, open, speak, stop, supported, text]);

  useEffect(() => {
    if (enabled && open && text !== lastText.current) speak(text);
  }, [enabled, open, speak, text]);

  useEffect(() => {
    setEnabled(false);
    lastText.current = '';
    stop();
    return stop;
  }, [open, accountId, stop]);

  return { supported, enabled, speaking, failed, toggle, stop, replay: () => speak(text) };
}