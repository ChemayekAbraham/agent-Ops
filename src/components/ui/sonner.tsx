import { useTheme } from "next-themes";
import { Toaster as Sonner, toast as sonnerToast, ExternalToast } from "sonner";
import { hapticSuccess, hapticError, hapticWarning } from "@/lib/haptics";

type ToasterProps = React.ComponentProps<typeof Sonner>;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();
  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      position="top-center"
      style={{ zIndex: 2147483647 } as React.CSSProperties}
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

// Haptic-enhanced toast wrapper
const toast = Object.assign(
  (message: string | React.ReactNode, data?: ExternalToast) => sonnerToast(message, data),
  {
    success: (message: string | React.ReactNode, data?: ExternalToast) => {
      hapticSuccess();
      return sonnerToast.success(message, data);
    },
    error: (message: string | React.ReactNode, data?: ExternalToast) => {
      hapticError();
      return sonnerToast.error(message, data);
    },
    warning: (message: string | React.ReactNode, data?: ExternalToast) => {
      hapticWarning();
      return sonnerToast.warning(message, data);
    },
    info: (message: string | React.ReactNode, data?: ExternalToast) => {
      return sonnerToast.info(message, data);
    },
    loading: (message: string | React.ReactNode, data?: ExternalToast) => {
      return sonnerToast.loading(message, data);
    },
    promise: sonnerToast.promise,
    dismiss: sonnerToast.dismiss,
    message: sonnerToast.message,
    custom: sonnerToast.custom,
  }
);

export { Toaster, toast };
