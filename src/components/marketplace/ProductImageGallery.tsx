import { useState } from 'react';
import { StorageImage } from '@/components/ui/StorageImage';
import { ChevronLeft, ChevronRight, Package, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ImageZoom } from './ImageZoom';
import { ImageLightbox } from './ImageLightbox';

interface ProductImageGalleryProps {
  mainImage: string | null;
  galleryImages: { id: string; image_url: string }[];
  productName: string;
  enableZoom?: boolean;
  enableLightbox?: boolean;
}

export function ProductImageGallery({ 
  mainImage, 
  galleryImages, 
  productName,
  enableZoom = true,
  enableLightbox = true
}: ProductImageGalleryProps) {
  // Combine main image with gallery images
  const allImages = [
    ...(mainImage ? [{ id: 'main', image_url: mainImage }] : []),
    ...galleryImages,
  ];

  const [currentIndex, setCurrentIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (allImages.length === 0) {
    return (
      <div className="aspect-video rounded-lg bg-muted overflow-hidden flex items-center justify-center">
        <Package className="h-16 w-16 text-muted-foreground" />
      </div>
    );
  }

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? allImages.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === allImages.length - 1 ? 0 : prev + 1));
  };

  const openLightbox = () => {
    if (enableLightbox) {
      setLightboxOpen(true);
    }
  };

  return (
    <>
      <div className="space-y-2">
        {/* Main Image */}
        <div 
          className="relative aspect-video rounded-lg bg-muted overflow-hidden group cursor-pointer"
          onClick={openLightbox}
        >
          {enableZoom ? (
            <ImageZoom
              src={allImages[currentIndex].image_url}
              alt={`${productName} - Image ${currentIndex + 1}`}
              className="w-full h-full"
              zoomScale={2.5}
            />
          ) : (
            <StorageImage
              src={allImages[currentIndex].image_url}
              alt={`${productName} - Image ${currentIndex + 1}`}
              className="w-full h-full object-cover"
            />
          )}

          {/* Fullscreen Button */}
          {enableLightbox && (
            <Button
              variant="secondary"
              size="icon"
              className="absolute top-2 right-2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity z-10 bg-background/80 backdrop-blur-sm"
              onClick={(e) => { e.stopPropagation(); openLightbox(); }}
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          )}

          {/* Navigation Arrows */}
          {allImages.length > 1 && (
            <>
              <Button
                variant="secondary"
                size="icon"
                className="absolute left-2 top-1/2 -translate-y-1/2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                onClick={(e) => { e.stopPropagation(); goToPrevious(); }}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                onClick={(e) => { e.stopPropagation(); goToNext(); }}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>

              {/* Image Counter */}
              <div className="absolute bottom-2 left-2 bg-background/80 backdrop-blur-sm text-xs px-2 py-1 rounded-md z-10">
                {currentIndex + 1} / {allImages.length}
              </div>
            </>
          )}

          {/* Click to expand hint */}
          {enableLightbox && (
            <div className="absolute bottom-2 right-2 bg-background/80 backdrop-blur-sm text-xs px-2 py-1 rounded-md z-10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              <Maximize2 className="h-3 w-3" />
              <span className="hidden sm:inline">Click to expand</span>
            </div>
          )}
        </div>

        {/* Thumbnails */}
        {allImages.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {allImages.map((image, index) => (
              <button
                key={image.id}
                onClick={() => setCurrentIndex(index)}
                className={cn(
                  "flex-shrink-0 w-14 h-14 rounded-md overflow-hidden border-2 transition-colors",
                  index === currentIndex
                    ? "border-primary"
                    : "border-transparent hover:border-muted-foreground/50"
                )}
              >
                <StorageImage
                  src={image.image_url}
                  alt={`${productName} - Thumbnail ${index + 1}`}
                  className="w-full h-full object-cover"
                />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Lightbox */}
      <ImageLightbox
        images={allImages}
        initialIndex={currentIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        productName={productName}
      />
    </>
  );
}
