import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";
import { useSignedUrl } from "@/hooks/useSignedUrl";

const Avatar = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Root
    ref={ref}
    className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)}
    {...props}
  />
));
Avatar.displayName = AvatarPrimitive.Root.displayName;

/**
 * Image URLs (stored and signed) that already failed this session. A failed
 * avatar falls back to the placeholder and is never requested again, and its
 * stored URL is not re-signed either.
 */
const failedAvatarUrls = new Set<string>();

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, src, onLoadingStatusChange, ...props }, ref) => {
  const knownBad = !!src && failedAvatarUrls.has(src);
  // Auto-sign Supabase storage URLs (skipped for URLs that already failed)
  const signedSrc = useSignedUrl(knownBad ? undefined : src);
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const usable = !knownBad && signedSrc && !failedAvatarUrls.has(signedSrc) ? signedSrc : undefined;
  return (
    <AvatarPrimitive.Image
      ref={ref}
      className={cn("aspect-square h-full w-full object-cover", className)}
      src={usable}
      onLoadingStatusChange={(status) => {
        if (status === 'error') {
          if (src) failedAvatarUrls.add(src);
          if (signedSrc) failedAvatarUrls.add(signedSrc);
          force();
        }
        onLoadingStatusChange?.(status);
      }}
      {...props}
    />
  );
});
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Fallback
    ref={ref}
    className={cn("flex h-full w-full items-center justify-center rounded-full bg-muted", className)}
    {...props}
  />
));
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
