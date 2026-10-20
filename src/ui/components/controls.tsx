import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit?: (v: number) => void;
  /** Value restored by tapping the readout. */
  reset?: number;
  /** Map slider position <-> value (e.g. logarithmic frequency). */
  scale?: { toPos: (v: number) => number; fromPos: (p: number) => number };
  disabled?: boolean;
}) {
  const { scale } = props;
  const pos = scale ? scale.toPos(props.value) : props.value;
  const min = scale ? 0 : props.min;
  const max = scale ? 1000 : props.max;
  const step = scale ? 1 : props.step ?? 1;
  const val = (raw: string) => (scale ? scale.fromPos(Number(raw)) : Number(raw));
  return (
    <div class="slider">
      <span class="slider-label">{props.label}</span>
      <button
        type="button"
        class="slider-value"
        title={props.reset !== undefined ? 'Tap to reset' : undefined}
        onClick={() => {
          if (props.reset === undefined) return;
          props.onInput(props.reset);
          props.onCommit?.(props.reset);
        }}
      >
        {props.format ? props.format(props.value) : props.value}
      </button>
      <input
        type="range"
        aria-label={props.label}
        min={min}
        max={max}
        step={step}
        value={pos}
        disabled={props.disabled}
        onInput={(e) => props.onInput(val((e.target as HTMLInputElement).value))}
        onChange={(e) => props.onCommit?.(val((e.target as HTMLInputElement).value))}
      />
    </div>
  );
}

export const logScale = (lo: number, hi: number) => ({
  toPos: (v: number) => (1000 * Math.log(Math.max(lo, Math.min(hi, v)) / lo)) / Math.log(hi / lo),
  fromPos: (p: number) => Math.round(lo * Math.pow(hi / lo, p / 1000)),
});

export function Segmented<T extends string | number>(props: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div class="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === props.value}
          class={o.value === props.value ? 'on' : ''}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { label: ComponentChildren; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label class="toggle">
      <span>
        {props.label}
        {props.hint && <div class="tiny faint">{props.hint}</div>}
      </span>
      <input type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
    </label>
  );
}

export function Sheet(props: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, button, select, textarea')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div class="backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={props.title} ref={ref}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}
