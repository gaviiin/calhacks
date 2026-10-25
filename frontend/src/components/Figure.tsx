import { useTween } from '../lib/motion';

/** A number that counts to its value. `format` turns the eased number into text. */
export function Figure({ value, format, className }: { value: number; format: (v: number) => string; className?: string }) {
  const v = useTween(value);
  return (
    <b className={className} aria-label={format(value)}>
      {format(v)}
    </b>
  );
}
