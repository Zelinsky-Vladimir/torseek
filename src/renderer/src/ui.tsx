import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cx } from './format'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-2 hover:bg-accent text-white shadow-[0_1px_0_rgba(255,255,255,0.12)_inset]',
  secondary: 'bg-panel-2 hover:bg-hover text-fg border border-line',
  ghost: 'hover:bg-hover text-muted hover:text-fg',
  danger: 'bg-bad/15 hover:bg-bad/25 text-bad border border-bad/30',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]',
        VARIANTS[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      className={cx(
        'inline-flex size-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40',
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cx(
        'h-9 rounded-lg border border-line bg-panel px-3 text-[13.5px] text-fg placeholder:text-faint outline-none transition-colors focus:border-accent/70 focus:bg-panel-2 selectable',
        className,
      )}
    />
  )
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40',
        checked ? 'bg-accent-2' : 'bg-line-2',
      )}
    >
      <span className={cx('absolute size-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function Chip({ active, onClick, children, count }: { active?: boolean; onClick?: () => void; children: ReactNode; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors',
        active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-line text-muted hover:border-line-2 hover:text-fg',
      )}
    >
      {children}
      {count != null && <span className={cx('tabular-nums', active ? 'text-accent' : 'text-faint')}>{count}</span>}
    </button>
  )
}

const BADGE_TONES = {
  neutral: 'bg-line/70 text-muted',
  accent: 'bg-accent/15 text-accent',
  good: 'bg-good/12 text-good',
  warn: 'bg-warn/12 text-warn',
  bad: 'bg-bad/12 text-bad',
}

export function Badge({ tone = 'neutral', children, title }: { tone?: keyof typeof BADGE_TONES; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-semibold tracking-wide', BADGE_TONES[tone])}>
      {children}
    </span>
  )
}

export function ProgressBar({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'good' | 'muted' | 'bad'; className?: string }) {
  const color = { accent: 'bg-accent', good: 'bg-good', muted: 'bg-faint', bad: 'bg-bad' }[tone]
  return (
    <div className={cx('h-1.5 overflow-hidden rounded-full bg-line', className)}>
      <div className={cx('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-line bg-panel text-muted">{icon}</div>
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <div className="max-w-md text-[13px] leading-relaxed text-muted">{children}</div>}
    </div>
  )
}
