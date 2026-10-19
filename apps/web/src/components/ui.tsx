import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { Check, Copy } from 'lucide-react'
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { cn } from '../lib/cn.ts'

// ---------- Button ----------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md' | 'icon' | 'icon-sm'

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent-hover border-transparent shadow-panel disabled:opacity-50',
  secondary:
    'bg-surface text-fg border-border-strong hover:bg-surface-2 shadow-panel disabled:text-fg-subtle',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-surface-2 hover:text-fg',
  danger:
    'tone-danger bg-tone-bg text-tone-fg border-tone-bd hover:brightness-[0.97] disabled:opacity-50',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  icon: 'h-8 w-8 justify-center',
  'icon-sm': 'h-7 w-7 justify-center',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 select-none items-center rounded-md border font-medium transition-colors duration-150 disabled:cursor-not-allowed [&_svg]:size-4 [&_svg]:shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    />
  )
}

// ---------- Tooltip ----------

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={150}>
      {children}
    </TooltipPrimitive.Provider>
  )
}

/** A tooltip for an element that already has an accessible name (e.g. an aria-label). */
export function Tip({
  label,
  children,
  side = 'bottom',
}: {
  label: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-50 max-w-xs rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg shadow-pop"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  )
}

// ---------- Small pieces ----------

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-2 px-1 font-mono text-2xs text-fg-muted">
      {children}
    </kbd>
  )
}

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-2 border-border-strong border-t-accent',
        className,
      )}
    />
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-md bg-surface-3', className)} />
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="font-semibold text-2xs text-fg-subtle uppercase tracking-[0.06em]">
        {children}
      </h3>
      {aside}
    </div>
  )
}

/**
 * A box whose content may scroll, reachable by keyboard: it takes focus, so arrow keys scroll it
 * (WCAG 2.1.1). It is named, because a focusable region must say what it holds. Boxes that hold
 * links or buttons do not need it; focus reaches their content anyway. Rendered as a labelled
 * section (a region), or as a pre for code and excerpts.
 */
export function ScrollRegion({
  label,
  as = 'section',
  className,
  children,
}: {
  label: string
  as?: 'section' | 'pre'
  className?: string
  children: ReactNode
}) {
  const Tag = as
  return (
    <Tag
      aria-label={label}
      {...(as === 'pre' ? { role: 'region' } : {})}
      tabIndex={0}
      className={cn('focus-visible:-outline-offset-2', className)}
    >
      {children}
    </Tag>
  )
}

export function Panel({
  className,
  children,
  title,
  aside,
}: {
  className?: string
  children: ReactNode
  title?: ReactNode
  aside?: ReactNode
}) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface shadow-panel', className)}>
      {title !== undefined && (
        <header className="flex items-center justify-between gap-2 border-border border-b px-4 py-2.5">
          <h2 className="font-semibold text-fg text-sm">{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-fg-muted',
        className,
      )}
    >
      {icon && <div className="text-fg-subtle [&_svg]:size-6">{icon}</div>}
      <p className="font-medium text-fg">{title}</p>
      {children && <div className="max-w-md text-sm">{children}</div>}
    </div>
  )
}

/**
 * Copies text, with a transient confirmation announced to screen readers. An icon button with a
 * tooltip; with children, a small labelled button instead.
 */
export function CopyButton({
  text,
  label,
  children,
}: {
  text: string
  label: string
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1400)
    })
  }
  const icon = copied ? <Check aria-hidden /> : <Copy aria-hidden />
  const announce = (
    <span className="sr-only" aria-live="polite">
      {copied ? 'Copied' : ''}
    </span>
  )
  if (children !== undefined) {
    return (
      <Button size="sm" onClick={copy}>
        {icon}
        {children}
        {announce}
      </Button>
    )
  }
  return (
    <Tip label={copied ? 'Copied' : label}>
      <Button variant="ghost" size="icon-sm" aria-label={label} onClick={copy}>
        {icon}
        {announce}
      </Button>
    </Tip>
  )
}

/**
 * Segmented control for a few exclusive options. Native radio inputs give arrow-key navigation
 * and radio-group semantics for free.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: readonly { value: T; label: ReactNode; count?: number }[]
  onChange: (value: T) => void
  label: string
}) {
  const name = useId()
  return (
    <fieldset className="inline-flex min-w-0 flex-wrap items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const active = o.value === value
        return (
          <label
            key={o.value}
            className={cn(
              'inline-flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 font-medium text-xs transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
              active ? 'bg-surface text-fg shadow-panel' : 'text-fg-muted hover:text-fg',
            )}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={active}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
            {o.count !== undefined && (
              <span className="text-fg-subtle tabular-nums">{o.count.toLocaleString('en')}</span>
            )}
          </label>
        )
      })}
    </fieldset>
  )
}
