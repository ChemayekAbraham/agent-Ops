import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Camera, CheckCircle2, Loader2, X, ImageDown } from 'lucide-react';
import { detectCardBoundary, boundariesAgree, padRect, type DetectedBoundary, type PixelRect } from '@/lib/cardEdgeDetection';

/** Standard ID/bank card ratio (ISO/IEC 7810 ID-1), width:height. */
const CARD_ASPECT = 1.586;
/** Fraction of the frame width the guide box occupies. */
const GUIDE_WIDTH_FRAC = 0.84;
/** How many consecutive agreeing detections before we trust it enough to auto-capture. */
const STABLE_HITS_REQUIRED = 5;
/** How often the (relatively expensive) edge scan runs, in ms. */
const ANALYSIS_INTERVAL_MS = 130;
/** The analysis frame is downscaled to this width before scanning, for speed. */
const ANALYSIS_WIDTH = 320;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line of guidance shown under the title. */
  instruction: string;
  /** Short, filesystem-safe tag used to name the captured file (e.g. "national-id-front"). */
  fileLabel: string;
  onCapture: (file: File) => void;
  /** Used when the camera can't be opened at all (permission denied, no camera, unsupported browser). */
  onFallback: () => void;
}

/**
 * In-page portrait camera for scanning a card. Deliberately does NOT use
 * `<input capture>` — that hands the shot off to the phone's own camera app,
 * which is what was pushing people to rotate the phone to landscape to get a
 * usable frame. Here the phone stays upright; the card (a landscape shape)
 * sits inside a portrait video frame, and the crop — not the phone — is what
 * ends up landscape-shaped.
 */
export default function CardCameraCapture({ open, onOpenChange, title, instruction, fileLabel, onCapture, onFallback }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const analysisCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastDetectedRef = useRef<DetectedBoundary | null>(null);
  const streakRef = useRef(0);
  const capturedRef = useRef(false);

  const [status, setStatus] = useState<'starting' | 'live' | 'error'>('starting');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  const stopCamera = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try {
      (screen.orientation as unknown as { unlock?: () => void })?.unlock?.();
    } catch {
      /* best-effort only */
    }
  }, []);

  /** Crops the live video to `crop` (native video pixel space) and hands back a File. */
  const captureRect = useCallback((crop: PixelRect, sideLabel: string) => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.width));
    canvas.height = Math.max(1, Math.round(crop.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(
      video,
      Math.max(0, crop.x), Math.max(0, crop.y), crop.width, crop.height,
      0, 0, canvas.width, canvas.height,
    );
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `${sideLabel}-scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
      setFlash(true);
      capturedRef.current = true;
      window.setTimeout(() => {
        onCapture(file);
        setFlash(false);
        onOpenChange(false);
      }, 220);
    }, 'image/jpeg', 0.92);
  }, [onCapture, onOpenChange]);

  const guideForVideo = useCallback((videoW: number, videoH: number): PixelRect => {
    const width = videoW * GUIDE_WIDTH_FRAC;
    const height = width / CARD_ASPECT;
    return { x: (videoW - width) / 2, y: (videoH - height) / 2, width, height };
  }, []);

  const manualCapture = useCallback((sideLabel: string) => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const guide = guideForVideo(video.videoWidth, video.videoHeight);
    const base = lastDetectedRef.current ?? guide;
    captureRect(padRect(base, 0.04, video.videoWidth, video.videoHeight), sideLabel);
  }, [captureRect, guideForVideo]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    capturedRef.current = false;
    streakRef.current = 0;
    lastDetectedRef.current = null;
    setStatus('starting');
    setErrorMessage(null);

    (async () => {
      try {
        // Best-effort — only takes effect in a fullscreen/installed context on
        // most browsers, but costs nothing to ask for.
        try {
          await (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('portrait');
        } catch {
          /* ignore — the in-page video is the real fix, this is a bonus */
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 1706 }, // portrait: taller than wide
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

        intervalRef.current = window.setInterval(() => {
          const v = videoRef.current;
          const overlay = overlayRef.current;
          const container = containerRef.current;
          if (!v || !overlay || !container || v.videoWidth === 0 || capturedRef.current) return;

          const videoW = v.videoWidth;
          const videoH = v.videoHeight;
          const guide = guideForVideo(videoW, videoH);

          // Downscaled analysis frame, same aspect as the native stream.
          const analysisScale = ANALYSIS_WIDTH / videoW;
          const analysisW = ANALYSIS_WIDTH;
          const analysisH = Math.round(videoH * analysisScale);
          if (!analysisCanvasRef.current) analysisCanvasRef.current = document.createElement('canvas');
          const aCanvas = analysisCanvasRef.current;
          aCanvas.width = analysisW;
          aCanvas.height = analysisH;
          const aCtx = aCanvas.getContext('2d', { willReadFrequently: true });
          if (!aCtx) return;
          aCtx.drawImage(v, 0, 0, analysisW, analysisH);
          const imageData = aCtx.getImageData(0, 0, analysisW, analysisH);

          const guideAnalysis: PixelRect = {
            x: guide.x * analysisScale, y: guide.y * analysisScale,
            width: guide.width * analysisScale, height: guide.height * analysisScale,
          };
          const detected = detectCardBoundary(imageData, guideAnalysis);
          const detectedNative: DetectedBoundary | null = detected
            ? {
                x: detected.x / analysisScale, y: detected.y / analysisScale,
                width: detected.width / analysisScale, height: detected.height / analysisScale,
                confidence: detected.confidence,
              }
            : null;

          if (detectedNative) {
            const prev = lastDetectedRef.current;
            if (prev && boundariesAgree(prev, detectedNative)) {
              streakRef.current += 1;
            } else {
              streakRef.current = 1;
            }
            lastDetectedRef.current = detectedNative;
          } else {
            streakRef.current = 0;
          }

          // --- draw ---
          const box = container.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          if (overlay.width !== Math.round(box.width * dpr) || overlay.height !== Math.round(box.height * dpr)) {
            overlay.width = Math.round(box.width * dpr);
            overlay.height = Math.round(box.height * dpr);
          }
          const ctx = overlay.getContext('2d');
          if (!ctx) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, box.width, box.height);

          // Map native video pixel space -> displayed (object-fit: contain) CSS box.
          const fitScale = Math.min(box.width / videoW, box.height / videoH);
          const renderedW = videoW * fitScale;
          const renderedH = videoH * fitScale;
          const offsetX = (box.width - renderedW) / 2;
          const offsetY = (box.height - renderedH) / 2;
          const toBox = (r: PixelRect) => ({
            x: offsetX + r.x * fitScale, y: offsetY + r.y * fitScale,
            width: r.width * fitScale, height: r.height * fitScale,
          });

          const stable = streakRef.current >= STABLE_HITS_REQUIRED;
          const shown = detectedNative ? toBox(detectedNative) : toBox(guide);
          const color = detectedNative ? (stable ? '#10b981' : '#f59e0b') : 'rgba(255,255,255,0.65)';

          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = detectedNative ? 3 : 2;
          if (!detectedNative) ctx.setLineDash([10, 8]);
          ctx.strokeRect(shown.x, shown.y, shown.width, shown.height);
          ctx.restore();

          if (detectedNative && stable) {
            capturedRef.current = true;
            captureRect(padRect(detectedNative, 0.04, videoW, videoH), fileLabel);
          }
        }, ANALYSIS_INTERVAL_MS);
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        const err = e as { name?: string; message?: string };
        setErrorMessage(
          err?.name === 'NotAllowedError'
            ? 'Camera access was not allowed. Allow camera access, or use the file picker instead.'
            : err?.name === 'NotFoundError'
              ? 'No camera was found on this device.'
              : 'Could not open the camera. You can still pick a photo instead.',
        );
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      <div className="flex items-center justify-between gap-2 p-3 text-white">
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="text-xs text-white/70">{instruction}</p>
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

      <div ref={containerRef} className="relative min-h-0 flex-1">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-contain"
        />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

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
          Hold the phone upright. Line the card up with the box — it captures on its own once the
          edges are found, or you can tap to capture.
        </p>
        <Button
          size="lg"
          className="h-14 w-14 rounded-full p-0"
          disabled={status !== 'live'}
          onClick={() => manualCapture(fileLabel)}
          aria-label="Capture photo"
        >
          <Camera className="h-6 w-6" />
        </Button>
      </div>
    </div>
  );
}
