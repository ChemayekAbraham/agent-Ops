import { useCallback, useEffect, useRef, useState } from "react";

const VOICE_DISCLOSURE_STORAGE_KEY = "welile.zoe.voice_disclosure_ack.v1";

export const ZOE_VOICE_DISCLOSURE_NOTE =
  "Browser voice input uses your browser's outside speech recognition service (such as Google or Apple) to convert your speech into text. The recognized text is placed in the input box for you to review before sending.";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getBrowserSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as new () => SpeechRecognitionLike) : null;
}

export interface UseZoeVoiceOptions {
  onTranscriptReady: (transcript: string) => void;
}

export function useZoeVoice({ onTranscriptReady }: UseZoeVoiceOptions) {
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [showDisclosurePrompt, setShowDisclosurePrompt] = useState(false);
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState<boolean>(() => {
    try {
      return localStorage.getItem(VOICE_DISCLOSURE_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [readAloudEnabled, setReadAloudEnabled] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isSupported = Boolean(getBrowserSpeechRecognitionCtor());

  const stopListening = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
    recognitionRef.current = null;
    setIsListening(false);
  }, []);

  const startRecognitionNow = useCallback(() => {
    const Ctor = getBrowserSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceError("Voice input is not supported in this browser.");
      return;
    }

    setVoiceError(null);
    try {
      const rec = new Ctor();
      rec.lang = "en-UG";
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (event: SpeechRecognitionEventLike) => {
        const parts: string[] = [];
        for (let i = 0; i < event.results.length; i++) {
          const item = event.results[i];
          if (item && item[0]?.transcript) {
            parts.push(item[0].transcript.trim());
          }
        }
        const finalTranscript = parts.join(" ").trim();
        if (finalTranscript) {
          onTranscriptReady(finalTranscript);
        }
      };
      rec.onerror = (ev) => {
        if (ev?.error && ev.error !== "no-speech" && ev.error !== "aborted") {
          setVoiceError(`Voice input error: ${ev.error}`);
        }
        setIsListening(false);
      };
      rec.onend = () => {
        setIsListening(false);
      };
      recognitionRef.current = rec;
      setIsListening(true);
      rec.start();
    } catch {
      setVoiceError("Could not start microphone voice recognition.");
      setIsListening(false);
    }
  }, [onTranscriptReady]);

  /**
   * Section 3.6 Voice disclosure defence:
   * Only request the microphone at the moment the mic button is clicked,
   * and show the one-time outside speech service disclosure before starting.
   */
  const handleMicButtonClick = useCallback(() => {
    if (isListening) {
      stopListening();
      return;
    }
    if (!disclosureAcknowledged) {
      setShowDisclosurePrompt(true);
      return;
    }
    startRecognitionNow();
  }, [disclosureAcknowledged, isListening, startRecognitionNow, stopListening]);

  const confirmDisclosureAndStart = useCallback(() => {
    try {
      localStorage.setItem(VOICE_DISCLOSURE_STORAGE_KEY, "1");
    } catch {
      // ignore storage failure
    }
    setDisclosureAcknowledged(true);
    setShowDisclosurePrompt(false);
    startRecognitionNow();
  }, [startRecognitionNow]);

  const dismissDisclosurePrompt = useCallback(() => {
    setShowDisclosurePrompt(false);
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    setIsSpeaking(false);
  }, []);

  const speakReply = useCallback(
    (text: string) => {
      if (!readAloudEnabled || typeof window === "undefined" || !("speechSynthesis" in window)) {
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const plain = text
          .replace(/[#*_`>|]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1200);
        if (!plain) return;
        const utter = new SpeechSynthesisUtterance(plain);
        utter.lang = "en-GB";
        utter.onend = () => setIsSpeaking(false);
        utter.onerror = () => setIsSpeaking(false);
        setIsSpeaking(true);
        window.speechSynthesis.speak(utter);
      } catch {
        setIsSpeaking(false);
      }
    },
    [readAloudEnabled],
  );

  useEffect(() => {
    return () => {
      stopListening();
      stopSpeaking();
    };
  }, [stopListening, stopSpeaking]);

  return {
    isSupported,
    isListening,
    voiceError,
    showDisclosurePrompt,
    disclosureAcknowledged,
    readAloudEnabled,
    isSpeaking,
    setReadAloudEnabled,
    handleMicButtonClick,
    confirmDisclosureAndStart,
    dismissDisclosurePrompt,
    stopListening,
    speakReply,
    stopSpeaking,
  };
}
