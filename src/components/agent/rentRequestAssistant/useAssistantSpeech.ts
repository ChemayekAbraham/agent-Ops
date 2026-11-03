import { useCallback, useEffect, useRef, useState } from 'react';

/** Engines that sound human. Plain "Desktop" voices are the robotic ones. */
const HUMAN_ENGINES = ['natural', 'neural', 'online', 'personal', 'premium', 'enhanced', 'siri'];

/** Known female voices, warmest first. Matched against the lower-cased voice name. */
const FEMALE_NAMES = [
  'google uk english female', 'google us english',
  'aria', 'jenny', 'sonia', 'libby', 'poppy', 'ava', 'samantha', 'karen', 'moira', 'tessa',
  'fiona', 'victoria', 'serena', 'kathy', 'allison', 'susan', 'zira', 'hazel', 'natasha',
  'felicity', 'catherine', 'linda', 'vega', 'ivy', 'ella', 'serra', 'amira', 'hannah', 'lucy',
  'ruby', 'nora', 'zoe', 'megan', 'clara', 'emma', 'sara', 'salma', 'laila', 'hoda', 'michelle',
  'heather', 'katie', 'carla', 'joanna', 'kendra', 'amy', 'britt', 'leah', 'tara', 'gilda',
  'zosia', 'kanisha', 'swara', 'audrey', 'amelie', 'milica', 'pavlina', 'zosia',
];

/** Known male voices, used only to push them out of the way. */
const MALE_NAMES = [
  'google uk english male',
  'david', 'mark', 'george', 'fred', 'alex', 'daniel', 'james', 'andrew', 'thomas', 'oliver',
  'arthur', 'guy', 'ryan', 'liam', 'aaron', 'adam', 'roger', 'rishi', 'diego', 'jorge', 'paul',
  'brian', 'christopher', 'patrick', 'richard', 'stephen', 'william', 'zane', 'calum', 'conor',
  'dennis', 'eiji', 'fahmid', 'floyd', 'gareth', 'hamid', 'hiroyuki', 'ichiro', 'jasper', 'joel',
  'kangkang', 'kenneth', 'kokoro', 'kosuke', 'lukas', 'manuel', 'mikhail', 'mohit', 'nate',
  'nishkanth', 'nurru', 'orpheus', 'peter', 'ravi', 'steffen', 'tomas', 'yao', 'yohei',
];

/** English accents that read naturally to Ugandan ears. */
const PREFERRED_LANGS = ['en-ug', 'en-gb', 'en-us', 'en-ie', 'en-za', 'en-au', 'en-nz'];

/** Slightly slower and warmer than the browser default, which reads fast and flat. */
const SPEECH_RATE = 0.94;
const SPEECH_PITCH = 1.08;

function scoreVoice(voice: SpeechSynthesisVoice) {
  const name = (voice.name || '').toLowerCase();
  const lang = (voice.lang || '').toLowerCase();
  let score = 0;
  if (name.includes('female')) score += 140;
  else if (name.includes('male')) score -= 140;
  else if (FEMALE_NAMES.some((f) => name.includes(f))) score += 100;
  else if (MALE_NAMES.some((m) => name.includes(m))) score -= 100;
  if (HUMAN_ENGINES.some((h) => name.includes(h))) score += 70;
  if (lang.startsWith('en')) score += 30;
  if (PREFERRED_LANGS.includes(lang)) score += 8;
  if (voice.default) score += 2;
  return score;
}

/** The best female-sounding human voice this browser offers; null when it has none yet. */
function pickVoice(voices: SpeechSynthesisVoice[]) {
  if (!voices.length) return null;
  return voices.reduce((best, voice) => (scoreVoice(voice) > scoreVoice(best) ? voice : best), voices[0]);
}

/** Turns assistant markdown into something that reads like a person talking. */
function toSpokenText(message: string) {
  return message
    .replace(/\bUGX\b/g, 'Ugandan shillings')
    .replace(/%/g, ' percent')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/^\s*[-•●▪◦]\s+/gm, ' ')
    .replace(/([^\s.!?])\s*\n+\s*/g, '$1. ')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Browser voice playback; never sends the agent's answers to a speech service. */
export function useAssistantSpeech(text: string, open: boolean, accountId?: string) {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  const [enabled, setEnabled] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<SpeechSynthesisUtterance | null>(null);
  const lastText = useRef('');
  const voices = useRef<SpeechSynthesisVoice[]>([]);

  // Browsers fill the voice list a beat after the page loads, so keep it refreshed.
  useEffect(() => {
    if (!supported) return;
    const synth = window.speechSynthesis;
    const load = () => {
      const list = synth.getVoices();
      if (list.length) voices.current = list;
    };
    load();
    if (typeof synth.addEventListener !== 'function') return;
    synth.addEventListener('voiceschanged', load);
    return () => {
      if (typeof synth.removeEventListener === 'function') synth.removeEventListener('voiceschanged', load);
    };
  }, [supported]);

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
    const utterance = new SpeechSynthesisUtterance(toSpokenText(message));
    utterance.lang = 'en-GB';
    utterance.voice = pickVoice(voices.current);
    utterance.rate = SPEECH_RATE;
    utterance.pitch = SPEECH_PITCH;
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
