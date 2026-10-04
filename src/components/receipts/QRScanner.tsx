import { useState, useEffect, useRef } from 'react';
import type { Html5Qrcode as Html5QrcodeType } from 'html5-qrcode';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Camera, X, ScanLine, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { hapticSuccess } from '@/lib/haptics';

interface QRScannerProps {
  onScan: (code: string) => void;
  buttonVariant?: 'default' | 'outline' | 'ghost' | 'secondary';
  buttonSize?: 'default' | 'sm' | 'lg' | 'icon';
  buttonClassName?: string;
}

export function QRScanner({ 
  onScan, 
  buttonVariant = 'outline',
  buttonSize = 'icon',
  buttonClassName = ''
}: QRScannerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const scannerRef = useRef<Html5QrcodeType | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const startScanner = async () => {
    if (!containerRef.current) return;

    try {
      // html5-qrcode is ~330 KB; load it only when the camera is actually
      // opened so it stays out of every dashboard's first paint.
      const { Html5Qrcode } = await import('html5-qrcode');
      const html5QrCode = new Html5Qrcode('qr-reader');
      scannerRef.current = html5QrCode;

      await html5QrCode.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: { width: 250, height: 250 },
          aspectRatio: 1,
        },
        (decodedText) => {
          // Success callback - trigger haptic feedback
          hapticSuccess();
          onScan(decodedText);
          stopScanner();
          setIsOpen(false);
          toast.success('QR Code scanned successfully!');
        },
        () => {
          // Error callback - ignore, just means no QR found yet
        }
      );

      setIsScanning(true);
      setHasPermission(true);
    } catch (err) {
      console.error('Failed to start scanner:', err);
      setHasPermission(false);
      toast.error('Could not access camera. Please check permissions.');
    }
  };

  const stopScanner = async () => {
    if (scannerRef.current && scannerRef.current.isScanning) {
      try {
        await scannerRef.current.stop();
        await scannerRef.current.clear();
      } catch (err) {
        console.error('Error stopping scanner:', err);
      }
    }
    setIsScanning(false);
  };

  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure the container is mounted
      const timer = setTimeout(() => {
        startScanner();
      }, 100);
      return () => clearTimeout(timer);
    } else {
      stopScanner();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => {
    return () => {
      stopScanner();
    };
  }, []);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      stopScanner();
    }
    setIsOpen(open);
  };

  return (
    <>
      <Button
        type="button"
        variant={buttonVariant}
        size={buttonSize}
        onClick={() => setIsOpen(true)}
        className={buttonClassName}
      >
        <Camera className="h-4 w-4" />
      </Button>

      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-sm p-0 overflow-hidden">
          <DialogHeader className="p-4 pb-2">
            <DialogTitle className="flex items-center gap-2">
              <ScanLine className="h-5 w-5 text-primary" />
              Scan Receipt QR Code
            </DialogTitle>
          </DialogHeader>

          <div className="relative">
            {/* Scanner container */}
            <div 
              id="qr-reader" 
              ref={containerRef}
              className="w-full aspect-square bg-black"
            />

            {/* Loading overlay */}
            {!isScanning && hasPermission !== false && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/80">
                <div className="text-center text-white">
                  <Loader2 className="h-8 w-8 animate-spin mx-auto mb-2" />
                  <p className="text-sm">Starting camera...</p>
                </div>
              </div>
            )}

            {/* Permission denied overlay */}
            {hasPermission === false && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/90 p-4">
                <div className="text-center text-white">
                  <Camera className="h-12 w-12 mx-auto mb-3 opacity-50" />
                  <p className="font-medium mb-1">Camera Access Denied</p>
                  <p className="text-sm text-white/70">
                    Please allow camera access in your browser settings to scan QR codes.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-4"
                    onClick={() => {
                      setHasPermission(null);
                      startScanner();
                    }}
                  >
                    Try Again
                  </Button>
                </div>
              </div>
            )}

            {/* Scanning indicator */}
            {isScanning && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-64 h-64 border-2 border-primary rounded-lg relative">
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary animate-scan-line" />
                </div>
              </div>
            )}
          </div>

          <div className="p-4 pt-2 text-center">
            <p className="text-sm text-muted-foreground">
              Point your camera at the QR code on your receipt
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 gap-2"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-4 w-4" />
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
