import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { logView, signedUrl } from '../api';

export type TutorialViewContext = 'review' | 'approval' | 'library' | 'own';

export interface TutorialPlayerVideo {
  id: string;
  video_code: string;
  title: string;
  storage_path: string;
  duration_seconds: number | null;
}

interface Props {
  video: TutorialPlayerVideo | null;
  context: TutorialViewContext;
  requisitionId?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWatched?: (maxContiguousSeconds: number) => void;
}

export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function TutorialPlayerDialog({ video, context, requisitionId, open, onOpenChange, onWatched }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [watched, setWatched] = useState(0);
  const maxRef = useRef(0);
  const startedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const duration = Number(video?.duration_seconds) || 0;

  const send = (position: number) => {
    if (!video) return;
    void logView({ p_video_id: video.id, p_context: context, p_position_seconds: position, p_requisition_id: requisitionId ?? null }).catch(() => {});
  };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  useEffect(() => {
    if (!open || !video) return;
    let cancelled = false;
    maxRef.current = 0; startedRef.current = false;
    setWatched(0); setFailed(false); setUrl(null);
    signedUrl(video.storage_path)
      .then((u) => { if (!cancelled) setUrl(u); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [open, video?.id]);

  useEffect(() => () => stopTimer(), []);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      stopTimer();
      if (startedRef.current) send(maxRef.current);
      onWatched?.(maxRef.current);
    }
    onOpenChange(next);
  };

  const onTimeUpdate = () => {
    const t = videoRef.current?.currentTime ?? 0;
    if (t <= maxRef.current + 2 && t > maxRef.current) {
      maxRef.current = t;
      setWatched(t);
    }
  };
  const onPlay = () => {
    if (!startedRef.current) { startedRef.current = true; send(Math.max(maxRef.current, 0.1)); }
    stopTimer();
    timerRef.current = window.setInterval(() => send(maxRef.current), 10000);
  };
  const onPause = () => { stopTimer(); send(maxRef.current); };
  const onEnded = () => {
    stopTimer();
    if (duration && maxRef.current >= duration - 2) { maxRef.current = duration; setWatched(duration); send(duration); }
    else send(maxRef.current);
  };

  const pct = duration ? Math.min(100, Math.round((watched / duration) * 100)) : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[calc(100%-1rem)] max-w-3xl rounded-lg p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="pr-8 text-base sm:text-lg break-words">
            {video ? `${video.video_code} • ${video.title}` : 'Tutorial video'}
          </DialogTitle>
          <DialogDescription>
            {formatDuration(duration)} • Watched {pct}%
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            This video can't play on this device.
          </p>
        ) : url ? (
          <video
            ref={videoRef}
            src={url}
            controls
            playsInline
            preload="metadata"
            controlsList="nodownload"
            className="w-full rounded-md bg-muted"
            onTimeUpdate={onTimeUpdate}
            onPlay={onPlay}
            onPause={onPause}
            onEnded={onEnded}
            onError={() => { stopTimer(); setFailed(true); }}
            onContextMenu={(e) => e.preventDefault()}
          />
        ) : (
          <p role="status" className="py-10 text-center text-sm text-muted-foreground">Loading video…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
