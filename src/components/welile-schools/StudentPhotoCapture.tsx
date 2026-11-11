import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Loader2, RotateCcw, SwitchCamera, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JPEG_QUALITY, OUTPUT_SIZE, cropFaceSquare } from '@/lib/welileSchoolsPhoto';

interface Props {
  open: boolean;
  studentName?: string | null;
  onClose: () => void;
  onCapture: (photo: Blob) => void;
  /** Called when no camera can be opened (permission denied, no camera, old browser). */
  onUnavailable: (reason: string) => void;
}

/**
 * Full-screen in-page camera for a student's face photo. Uses getUserMedia rather
 * than <input capture>, which hands off to the phone's camera app and can unload
 * this page (see SelfieCameraCapture). The back camera is the default because the
 * agent photographs the student; a button flips to the front camera.
 */
export default function StudentPhotoCapture({ open, studentName, onClose, onCapture, onUnavailable }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [status, setStatus] = useState<'starting' | 'live' | 'error'>('starting');
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open || shot) return;
    let cancelled = false;
    setStatus('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      onUnavailable('This phone or browser cannot open the camera here.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false })
      .then((stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          void videoRef.current.play().catch(() => {});
        }
        setStatus('live');
      })
      .catch((err: DOMException) => {
        if (cancelled) return;
        setStatus('error');
        onUnavailable(err?.name === 'NotAllowedError'
          ? 'Camera permission was refused. Allow the camera for this site in the browser settings.'
          : 'The camera could not be opened.');
      });
    return () => { cancelled = true; stop(); };
  }, [open, facing, shot, stop, onUnavailable]);

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);
  useEffect(() => { if (!open) { stop(); setShot(null); } }, [open, stop]);

  const take = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const { sx, sy, side } = cropFaceSquare(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = OUTPUT_SIZE;
    canvas.height = OUTPUT_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Saved as the camera saw it (never mirrored), even when the front preview is mirrored.
    ctx.drawImage(video, sx, sy, side, side, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    canvas.toBlob((blob) => {
      if (!blob) return;
      stop();
      setShot({ blob, url: URL.createObjectURL(blob) });
    }, 'image/jpeg', JPEG_QUALITY);
  };

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Take the student's photo" className="fixed inset-0 z-[200] flex flex-col bg-black text-white">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Student photo</p>
          {studentName ? <p className="truncate text-xs text-white/70">{studentName}</p> : null}
        </div>
        <Button variant="ghost" size="icon" className="h-11 w-11 text-white hover:bg-white/10 hover:text-white" aria-label="Close camera" onClick={onClose}>
          <X className="h-5 w-5" />
        </Button>
      </div>

      <div className="relative flex-1 overflow-hidden">
        {shot ? (
          <img src={shot.url} alt="Captured student photo" className="absolute inset-0 m-auto max-h-full max-w-full object-contain" />
        ) : (
          <>
            <video ref={videoRef} playsInline muted className={`absolute inset-0 h-full w-full object-cover ${facing === 'user' ? '-scale-x-100' : ''}`} />
            {/* Face guide: everything outside the oval is darkened so the face goes inside it. */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="aspect-[3/4] w-[58vmin] max-w-[340px] rounded-[50%] border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.6)]" />
            </div>
            <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center px-6">
              <p className="rounded-full bg-black/60 px-4 py-2 text-center text-sm font-semibold">Fit the student's face inside the oval</p>
            </div>
            {status === 'starting' && (
              <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" aria-label="Starting camera" /></div>
            )}
          </>
        )}
      </div>

      <div className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {shot ? (
          <>
            <p className="text-center text-sm text-white/80">Is the whole face clear and inside the frame?</p>
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="min-h-[52px] gap-2 border-white/40 bg-transparent text-white hover:bg-white/10 hover:text-white" onClick={() => setShot(null)}>
                <RotateCcw className="h-4 w-4" />Retake
              </Button>
              <Button className="min-h-[52px] gap-2" onClick={() => { onCapture(shot.blob); onClose(); }}>Use photo</Button>
            </div>
          </>
        ) : (
          <>
            <ul className="space-y-0.5 text-center text-xs text-white/75">
              <li>Face the student towards good light, not a bright window.</li>
              <li>Whole face inside the oval, looking straight at the camera.</li>
              <li>No caps, hats or sunglasses.</li>
            </ul>
            <div className="flex items-center justify-center gap-8">
              <Button variant="ghost" size="icon" className="h-12 w-12 text-white hover:bg-white/10 hover:text-white" aria-label="Switch camera"
                onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}>
                <SwitchCamera className="h-6 w-6" />
              </Button>
              <button type="button" onClick={take} disabled={status !== 'live'} aria-label="Take photo"
                className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white bg-white/20 transition active:scale-95 disabled:opacity-40">
                <Camera className="h-7 w-7" />
              </button>
              <span className="h-12 w-12" aria-hidden />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

