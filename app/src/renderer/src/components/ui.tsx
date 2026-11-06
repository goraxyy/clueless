// Small shared UI pieces.
import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'chip'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-claude-500 text-white hover:bg-claude-400 font-medium shadow-sm disabled:bg-zinc-200 disabled:text-zinc-400 dark:disabled:bg-white/10 dark:disabled:text-zinc-600',
  secondary:
    'border border-zinc-900/10 bg-white/70 text-zinc-800 hover:bg-zinc-50 dark:border-white/15 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-zinc-700',
  ghost: 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100',
  chip: 'border border-zinc-900/10 bg-white/70 text-zinc-700 hover:border-claude-500 hover:text-zinc-950 dark:border-white/15 dark:bg-black/40 dark:text-zinc-200 dark:hover:border-claude-500 dark:hover:text-white'
}

export function Button({
  variant = 'secondary',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cx(
        'no-drag inline-flex items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'chip' ? 'h-7 gap-1 whitespace-nowrap px-2 text-[11.5px]' : 'h-9 gap-1.5 px-3 text-sm',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconButton({
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'no-drag relative inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-zinc-300 bg-zinc-50/70 px-1.5 py-px font-sans text-[11px] text-zinc-600 dark:border-white/20 dark:bg-white/10 dark:text-zinc-300">
      {children}
    </kbd>
  )
}

export function isMac(platform?: string): boolean {
  return (platform ?? navigator.platform).toLowerCase().includes('mac') || platform === 'darwin'
}

const ARROWS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→' }

/** "CommandOrControl+Shift+Space" -> "⌘ ⇧ Space" on macOS, "Ctrl Shift Space" elsewhere. */
export function hotkeyLabel(accelerator: string, platform?: string): string {
  const mac = isMac(platform)
  return accelerator
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl') return mac ? '⌘' : 'Ctrl'
      if (k === 'Control') return mac ? '⌃' : 'Ctrl'
      if (k === 'Shift') return mac ? '⇧' : 'Shift'
      if (k === 'Alt') return mac ? '⌥' : 'Alt'
      return ARROWS[k] ?? k
    })
    .join(mac ? ' ' : '+')
}
