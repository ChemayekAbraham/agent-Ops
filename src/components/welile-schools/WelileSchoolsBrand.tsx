import welileLogo from '@/assets/welile-logo.png';
import { wordmarkClass } from './wordmark';

/** Logo + "Welile Schools" wordmark, used as the title in every Welile Schools header. */
export default function WelileSchoolsBrand() {
  return (
    <>
      <img src={welileLogo} alt="" aria-hidden className="h-7 w-auto shrink-0 rounded-lg" />
      <h1 className="min-w-0 flex-1 truncate text-lg font-bold">
        <span className={`${wordmarkClass} text-xl text-primary`}>Welile</span> Schools
      </h1>
    </>
  );
}
