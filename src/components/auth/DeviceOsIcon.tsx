import type { SVGProps } from 'react';
import type { DeviceIconKey } from '@/hooks/useNewDeviceSignIns';

/** Recognisable OS marks for sign-in alerts. Monochrome (currentColor) so they theme in light and dark. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

const Apple = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M16.37 12.6c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.71-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.86-.76-1.47.02-2.83.86-3.59 2.17-1.53 2.66-.39 6.59 1.1 8.75.73 1.05 1.6 2.24 2.73 2.2 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.29-.88-2.3-3.51zM14.2 6.13c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.64-1.05 1.67-.92 2.66.97.08 1.96-.49 2.56-1.21z" />
  </svg>
);

const Android = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M7.2 3.1a.5.5 0 0 1 .68.18l1.2 2.07A7.9 7.9 0 0 1 12 4.8c1.04 0 2.03.2 2.92.55l1.2-2.07a.5.5 0 1 1 .87.5l-1.17 2.03A7.2 7.2 0 0 1 19.5 11.5h-15a7.2 7.2 0 0 1 3.68-5.69L7.02 3.78a.5.5 0 0 1 .18-.68zM8.75 8.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zm6.5 0a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zM4.5 12.5h15V19a1.5 1.5 0 0 1-1.5 1.5h-.5V23a1.25 1.25 0 0 1-2.5 0v-2.5h-6V23a1.25 1.25 0 0 1-2.5 0v-2.5H6A1.5 1.5 0 0 1 4.5 19v-6.5zM2.25 12.5a1.25 1.25 0 0 1 1.25 1.25v4.5a1.25 1.25 0 0 1-2.5 0v-4.5c0-.69.56-1.25 1.25-1.25zm19.5 0c.69 0 1.25.56 1.25 1.25v4.5a1.25 1.25 0 0 1-2.5 0v-4.5c0-.69.56-1.25 1.25-1.25z" />
  </svg>
);

const Windows = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M2 4.5 10 3.4v8.1H2V4.5zm9-1.24L22 1.75V11.5H11V3.26zM2 12.5h8v8.1l-8-1.1v-7zm9 0h11v9.75l-11-1.51V12.5z" />
  </svg>
);

const Mac = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="3.5" y="4" width="17" height="11.5" rx="1.5" />
    <path d="M1.5 19h21l-1.2-2.5H2.7L1.5 19z" />
    <path fill="currentColor" stroke="none" d="M13.6 9.9c0-.95.78-1.4.81-1.43a1.73 1.73 0 0 0-1.37-.74c-.58-.06-1.13.34-1.43.34-.3 0-.75-.33-1.23-.33a1.82 1.82 0 0 0-1.54.94c-.66 1.14-.17 2.84.47 3.77.31.45.69.96 1.17.95.47-.02.65-.31 1.22-.31.57 0 .73.31 1.23.3.51-.01.83-.46 1.14-.92.36-.52.5-1.03.52-1.06-.01 0-.99-.38-.99-1.51zm-.93-2.8c.26-.32.43-.75.39-1.19-.38.02-.83.25-1.1.56-.24.28-.45.72-.4 1.15.42.03.85-.21 1.11-.52z" />
  </svg>
);

const Linux = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M12 1.5c-2.2 0-3.6 1.8-3.6 4.4 0 1.3.3 2.2-.4 3.4-.9 1.5-2.6 3.4-2.9 6-.1 1 .2 1.7.6 2.2-.9.4-2 .7-2.1 1.6-.1.8.8 1.2 2.4 1.7 1.4.4 2.4 1.3 3.3 1.3.8 0 1.3-.6 1.5-1.1h3.4c.2.5.7 1.1 1.5 1.1.9 0 1.9-.9 3.3-1.3 1.6-.5 2.5-.9 2.4-1.7-.1-.9-1.2-1.2-2.1-1.6.4-.5.7-1.2.6-2.2-.3-2.6-2-4.5-2.9-6-.7-1.2-.4-2.1-.4-3.4 0-2.6-1.4-4.4-3.6-4.4zm-1.6 4.3c.4 0 .7.5.7 1.1 0 .3-.1.5-.2.7l-.5-.1c.1-.1.1-.3.1-.5 0-.3-.1-.6-.3-.6s-.3.3-.3.6v.2l-.4-.2c0-.7.4-1.2.9-1.2zm3.1 0c.6 0 1 .6 1 1.3l-.5.2v-.2c0-.4-.2-.7-.5-.7s-.4.3-.4.7v.3l-.5.1c-.1-.2-.1-.4-.1-.6 0-.6.4-1.1 1-1.1zM12 8c.8 0 2 .6 2 .9 0 .3-1.2 1.1-2 1.1s-2-.8-2-1.1C10 8.6 11.2 8 12 8zm0 3.4c1.9 0 3.4 2.1 3.4 4.6 0 1.4-.4 2.4-1 3.1H9.6c-.6-.7-1-1.7-1-3.1 0-2.5 1.5-4.6 3.4-4.6z" />
  </svg>
);

const Unknown = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" {...p}>
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M10.2 9.2a1.9 1.9 0 0 1 3.7.6c0 1.3-1.9 1.7-1.9 2.9" />
    <circle cx="12" cy="15.6" r="0.6" fill="currentColor" />
    <path d="M10.5 19h3" />
  </svg>
);

const ICONS: Record<DeviceIconKey, (p: IconProps) => JSX.Element> = {
  iphone: Apple,
  android: Android,
  windows: Windows,
  mac: Mac,
  linux: Linux,
  unknown: Unknown,
};

export function DeviceOsIcon({ icon, size, ...props }: { icon: DeviceIconKey } & IconProps) {
  const Icon = ICONS[icon] ?? Unknown;
  return <Icon aria-hidden="true" width={size ?? 24} height={size ?? 24} {...props} />;
}
