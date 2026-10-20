import { Apple, HelpCircle, Laptop, Monitor, Smartphone, Terminal, type LucideProps } from 'lucide-react';
import type { DeviceIconKey } from '@/hooks/useNewDeviceSignIns';

/**
 * One icon per device family for sign-in alerts. lucide has no Windows/Android/
 * Linux brand marks, so these are the closest generic shapes; the label beside
 * the icon names the OS. Swapping in brand SVGs is a styling call (Gemini).
 */
const ICONS: Record<DeviceIconKey, React.ComponentType<LucideProps>> = {
  iphone: Apple,
  android: Smartphone,
  windows: Monitor,
  mac: Laptop,
  linux: Terminal,
  unknown: HelpCircle,
};

export function DeviceOsIcon({ icon, ...props }: { icon: DeviceIconKey } & LucideProps) {
  const Icon = ICONS[icon] ?? HelpCircle;
  return <Icon aria-hidden="true" {...props} />;
}
