import { V360_NEW_QUOTE_EXAMPLE_SENTENCE } from '@/lib/v360Captions';

/** Fixed Model A example. It sits beside a calculator and does not replace its result. */
export function V360IllustrativeExample() {
  return (
    <p className="text-[11px] leading-snug text-muted-foreground" data-testid="v360-illustrative-example">
      {V360_NEW_QUOTE_EXAMPLE_SENTENCE}
    </p>
  );
}
