import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useVerificationHistory, type VerificationHistoryFile } from '@/hooks/useIdentityPhotos';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChevronLeft, Download, ExternalLink, ImageOff, Maximize2, Minimize2, ShieldCheck } from 'lucide-react';

/** One photo opened in the full-resolution viewer. */
interface ViewerPhoto {
  url: string;
  label: string;
  takenAt: string;
  fileName: string;
}

function when(iso: string | null) {
  if (!iso) return 'Date not recorded';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Thumb({
  file,
  label,
  caption,
  round,
  onOpen,
}: {
  file: VerificationHistoryFile | null;
  label: string;
  caption: string;
  round?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="flex-1 min-w-[130px] space-y-2">
      <p className="text-xs font-medium">{label}</p>
      {file?.url ? (
        <button
          type="button"
          onClick={onOpen}
          className="block w-full"
          aria-label={`Open ${label} in full resolution`}
        >
          <img
            src={file.url}
            alt={label}
            loading="lazy"
            className={`h-32 w-full border bg-muted object-cover ${round ? 'rounded-full' : 'rounded-lg'}`}
          />
        </button>
      ) : (
        <div className="flex h-32 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground">
          <ImageOff className="h-5 w-5" />
          <span className="text-[11px]">Not saved</span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{caption}</p>
      {file?.url && <p className="text-[11px] text-primary">Tap to view full size</p>}
    </div>
  );
}


export default function VerificationHistoryPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { profile } = useProfile();
  const [params] = useSearchParams();
  const viewUserId = params.get('userId') || user?.id || null;
  const isSelf = !params.get('userId') || params.get('userId') === user?.id;

  const history = useVerificationHistory(viewUserId);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [actualSize, setActualSize] = useState(false);


  const entries = useMemo(() => history.data ?? [], [history.data]);

  // Flat list of every viewable photo, in the order the thumbnails appear,
  // so the keyboard can move between them without clicking.
  const flatPhotos = useMemo<ViewerPhoto[]>(() => {
    const list: ViewerPhoto[] = [];
    for (const e of entries) {
      const takenAt = when(e.submittedAt);
      const push = (file: VerificationHistoryFile | null, label: string) => {
        if (!file?.url) return;
        list.push({
          url: file.url,
          label,
          takenAt,
          fileName: file.path.split('/').pop() || 'verification-photo.jpg',
        });
      };
      push(e.original, 'Selfie sent for verification');
      push(e.cropped, 'Cropped profile picture');
      push(e.nationalId, 'National ID photo');
    }
    return list;
  }, [entries]);

  // Maps "<entryId>:<kind>" to that photo's index in flatPhotos.
  const photoIndexOf = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    for (const e of entries) {
      for (const [kind, file] of [
        ['original', e.original],
        ['cropped', e.cropped],
        ['nationalId', e.nationalId],
      ] as const) {
        if (file?.url) map.set(`${e.id}:${kind}`, i++);
      }
    }
    return map;
  }, [entries]);

  const preview = previewIndex !== null ? flatPhotos[previewIndex] ?? null : null;

  const openPhoto = (index: number) => {
    setActualSize(false);
    setPreviewIndex(index);
  };
  const stepPhoto = (delta: number) => {
    setPreviewIndex((cur) => {
      if (cur === null || flatPhotos.length === 0) return cur;
      return (cur + delta + flatPhotos.length) % flatPhotos.length;
    });
    setActualSize(false);
  };

  // Keyboard controls: ←/→ move between thumbnails, F toggles resolution,
  // O opens in a new tab, D downloads, Escape closes (handled by the dialog).
  useEffect(() => {
    if (previewIndex === null) return;
    const onKey = (ev: KeyboardEvent) => {
      switch (ev.key) {
        case 'ArrowLeft':
          ev.preventDefault();
          stepPhoto(-1);
          break;
        case 'ArrowRight':
          ev.preventDefault();
          stepPhoto(1);
          break;
        case 'f':
        case 'F':
          ev.preventDefault();
          setActualSize((v) => !v);
          break;
        case 'o':
        case 'O': {
          ev.preventDefault();
          const url = flatPhotos[previewIndex]?.url;
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
          break;
        }
        case 'd':
        case 'D': {
          ev.preventDefault();
          const p = flatPhotos[previewIndex];
          if (p) {
            const a = document.createElement('a');
            a.href = p.url;
            a.download = p.fileName;
            a.click();
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewIndex, flatPhotos]);

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={() => navigate(-1)}>
        <ChevronLeft className="mr-1 h-4 w-4" />
        Back
      </Button>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Verification history
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Every photo you sent for verification is kept here with the date it was sent. The full
            photo is what Financial Ops checks; the round one is the picture you cropped and now use
            as your profile picture.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {isSelf && profile?.avatar_url && (
            <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-3">
              <img
                src={profile.avatar_url}
                alt="Current profile picture"
                className="h-14 w-14 rounded-full border object-cover"
              />
              <div>
                <p className="text-sm font-medium">Profile picture in use now</p>
                <p className="text-xs text-muted-foreground">Shown to everyone across the app</p>
              </div>
            </div>
          )}

          {history.isLoading ? (
            <div className="space-y-3">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-48 w-full" />
              ))}
            </div>
          ) : history.error ? (
            <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
              Could not load the verification photos.
            </p>
          ) : entries.length === 0 ? (
            <p className="rounded-lg border p-4 text-center text-sm text-muted-foreground">
              No verification photos yet. They appear here once you send your National ID photo and
              selfie.
            </p>
          ) : (
            entries.map((e, i) => (
              <div key={e.id} className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">{when(e.submittedAt)}</p>
                  {i === 0 && <Badge variant="secondary">Latest</Badge>}
                </div>
                <div className="flex flex-wrap gap-3">
                  <Thumb
                    file={e.original}
                    label="Selfie sent for verification"
                    caption="Full, uncropped photo kept for Financial Ops"
                    onOpen={() => openPhoto(photoIndexOf.get(`${e.id}:original`) ?? 0)}
                  />
                  <Thumb
                    file={e.cropped}
                    label="Cropped profile picture"
                    caption="The version you confirmed as your profile picture"
                    round
                    onOpen={() => openPhoto(photoIndexOf.get(`${e.id}:cropped`) ?? 0)}
                  />
                  <Thumb
                    file={e.nationalId}
                    label="National ID photo"
                    caption="Photo of the ID card sent with this selfie"
                    onOpen={() => openPhoto(photoIndexOf.get(`${e.id}:nationalId`) ?? 0)}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={!!preview} onOpenChange={(o) => !o && setPreviewIndex(null)}>
        <DialogContent className="max-w-3xl p-3">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-base">{preview?.label}</DialogTitle>
            <p className="text-xs text-muted-foreground">
              {preview?.takenAt}
              {previewIndex !== null && flatPhotos.length > 1 && (
                <span className="ml-2">
                  · Photo {previewIndex + 1} of {flatPhotos.length}
                </span>
              )}
            </p>
          </DialogHeader>

          {preview && (
            <div
              className={`max-h-[70vh] w-full rounded-lg bg-muted/40 ${actualSize ? 'overflow-auto' : 'overflow-hidden'}`}
            >
              <img
                src={preview.url}
                alt={preview.label}
                className={actualSize ? 'max-w-none' : 'max-h-[70vh] w-full object-contain'}
              />
            </div>
          )}

          {flatPhotos.length > 1 && (
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" onClick={() => stepPhoto(-1)}>
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <Button variant="outline" size="sm" onClick={() => stepPhoto(1)}>
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Button variant="outline" size="sm" onClick={() => setActualSize((v) => !v)}>
              {actualSize ? <Minimize2 className="mr-2 h-4 w-4" /> : <Maximize2 className="mr-2 h-4 w-4" />}
              {actualSize ? 'Fit to screen' : 'Full resolution'}
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={preview?.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                Open in new tab
              </a>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <a href={preview?.url} download={preview?.fileName}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </a>
            </Button>
          </div>

          <p className="text-center text-[11px] text-muted-foreground">
            Keyboard: <kbd className="rounded border px-1">←</kbd> <kbd className="rounded border px-1">→</kbd> move
            between photos · <kbd className="rounded border px-1">F</kbd> fit/full resolution ·{' '}
            <kbd className="rounded border px-1">O</kbd> open in new tab · <kbd className="rounded border px-1">D</kbd>{' '}
            download · <kbd className="rounded border px-1">Esc</kbd> close
          </p>
        </DialogContent>
      </Dialog>

    </div>
  );
}
