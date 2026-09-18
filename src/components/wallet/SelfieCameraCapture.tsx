import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, CheckCircle2, ImageDown, Loader2, X } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCapture: (file: File) => void;
  /** Used when the camera can't be opened at all (permission denied, no camera, unsupported browser). */
  onFallback: () => void;
}

/**
 * In-page front-camera capture for the selfie, mirroring `CardCameraCapture`'s
 * approach for the National ID shots. Deliberately does NOT use
 * `<input capture="user">` — that hands the shot off to the phone's own
 * camera app, which can background/discard this page and resume it with a
 * momentarily stale auth token, which is what was signing people out
 * mid-selfie (see HANDOVER 67). Staying in-page via `getUserMedia` means the
 * page never leaves the foreground in the first place.
 *
 * No card-style edge detection here — there's nothing to auto-detect for a
 * face, so capture is a manual tap. The oval guide is a framing aid only.
 */
export default function SelfieCameraCapture({ open, onOpenChange, onCapture, onFallback }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const capturedRef = useRef(false);

  const [status, setStatus] = useState<'starting' | 'live' | 'error'>('starting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0 || capturedRef.current) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The archived original must show the face as the camera actually saw it
    // (never mirrored), even though the live preview is mirrored below for a
    // natural "looking in a mirror" feel.
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `selfie-scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setFlash(true);
      capturedRef.current = true;
      window.setTimeout(() => {
        onCapture(file);
        setFlash(false);
        onOpenChange(false);
      }, 220);
    }, 'image/jpeg', 0.92);
  }, [onCapture, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    capturedRef.current = false;
    setStatus('starting');
    setErrorMessage(null);

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'user' },
            width: { ideal: 960 },
            height: { ideal: 1280 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        if (cancelled) return;
        setStatus('live');
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        const err = e as { name?: string; message?: string };
        setErrorMessage(
          err?.name === 'NotAllowedError'
            ? 'Camera access was not allowed. Allow camera access, or use the file picker instead.'
            : err?.name === 'NotFoundError'
              ? 'No front camera was found on this device.'
              : 'Could not open the camera. You can still pick a photo instead.',
        );
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, stopCamera]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between gap-2 p-3 text-white">
        <div>
          <p className="text-sm font-semibold">Selfie</p>
          <p className="text-xs text-white/70">Face the camera in good light and line your face up with the oval.</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="text-white hover:bg-white/10 hover:text-white"
          onClick={() => { stopCamera(); onOpenChange(false); }}
          aria-label="Close camera"
        >
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover"
          style={{ transform: 'scaleX(-1)' }}
        />

        {status === 'live' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-[62%] w-[46%] rounded-[50%] border-2 border-dashed border-white/70" />
          </div>
        )}

        {status === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-sm">Opening camera…</p>
          </div>
        )}

        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-white">
            <p className="text-sm">{errorMessage}</p>
            <Button
              variant="secondary"
              onClick={() => { stopCamera(); onOpenChange(false); onFallback(); }}
            >
              <ImageDown className="mr-2 h-4 w-4" />
              Use file picker instead
            </Button>
          </div>
        )}

        {flash && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/20">
            <CheckCircle2 className="h-16 w-16 text-emerald-400" />
          </div>
        )}
      </div>

      <div className="flex flex-col items-center gap-3 p-4">
        <p className="text-center text-xs text-white/70">
          Hold the phone upright and keep your face inside the oval, then tap to take the photo.
        </p>
        <Button
          size="lg"
          className="h-14 w-14 rounded-full p-0"
          disabled={status !== 'live'}
          onClick={capture}
          aria-label="Capture selfie"
        >
          <Camera className="h-6 w-6" />
        </Button>
      </div>
    </div>
  );
}
