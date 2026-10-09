import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
export function Button({ variant = 'secondary', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-blue-600 text-white hover:bg-blue-700 border-blue-600',
    success: 'bg-emerald-600 text-white hover:bg-emerald-700 border-emerald-600',
    danger: 'bg-red-600 text-white hover:bg-red-700 border-red-600',
    secondary: 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300',
    ghost: 'bg-transparent text-slate-600 hover:bg-slate-100 border-transparent',
  };
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50',
        styles[variant],
        className,
      )}
    />
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  blue: 'bg-blue-50 text-blue-700 ring-blue-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  slate: 'bg-slate-100 text-slate-700 ring-slate-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};
export function Badge({ children, color = 'slate', title }: { children: ReactNode; color?: keyof typeof BADGE; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', BADGE[color])}>
      {children}
    </span>
  );
}

const STATUS_COLOR: Record<string, keyof typeof BADGE> = {
  // messages
  accepted: 'green', delivered: 'green', simulated: 'violet', queued: 'blue', processing: 'blue', draft: 'slate', excluded: 'slate',
  failed: 'red', bounced: 'red', skipped: 'amber', unknown: 'amber',
  // campaigns
  approved: 'blue', sending: 'blue', paused: 'amber', completed: 'green', cancelled: 'slate',
  // runs / companies
  running: 'blue', interrupted: 'amber', scanned: 'green', scanning: 'blue', discovered: 'slate', no_website: 'slate',
  invalid_website: 'amber', blocked_robots: 'amber', scan_failed: 'red',
  // contacts
  eligible: 'green', suppressed: 'red', contacted: 'violet', invalid: 'red', low_confidence: 'amber',
};
const STATUS_LABEL: Record<string, string> = {
  accepted: 'Accepted by SMTP', simulated: 'Simulated (test)', unknown: 'Outcome unknown', low_confidence: 'Low confidence',
  no_website: 'No website', invalid_website: 'Invalid website', blocked_robots: 'Blocked by robots.txt', scan_failed: 'Scan failed',
};
export function StatusBadge({ status }: { status: string }) {
  return <Badge color={STATUS_COLOR[status] ?? 'slate'}>{STATUS_LABEL[status] ?? status.replace(/_/g, ' ')}</Badge>;
}

export function Stat({ label, value, hint, tone = 'slate' }: { label: string; value: ReactNode; hint?: string; tone?: 'slate' | 'green' | 'red' | 'amber' | 'blue' | 'violet' }) {
  const tones = { slate: 'text-slate-900', green: 'text-emerald-600', red: 'text-red-600', amber: 'text-amber-600', blue: 'text-blue-600', violet: 'text-violet-600' };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-400">{hint}</div>}
    </div>
  );
}

export function Alert({ tone = 'info', children, title }: { tone?: 'info' | 'warn' | 'error' | 'success'; children: ReactNode; title?: string }) {
  const s = {
    info: 'border-blue-200 bg-blue-50 text-blue-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  }[tone];
  return (
    <div className={cx('rounded-lg border px-4 py-3 text-sm', s)}>
      {title && <div className="mb-0.5 font-semibold">{title}</div>}
      {children}
    </div>
  );
}

export function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert tone="error">{error instanceof Error ? error.message : String(error)}</Alert>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <div className="font-medium text-slate-700">{title}</div>
      {children && <div className="mt-1 text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-2 px-1 py-3 text-sm text-slate-600">
      <span>
        {total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total.toLocaleString()}`}
      </span>
      <div className="flex gap-2">
        <Button disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone = 'blue' }: { value: number; tone?: 'blue' | 'green' }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={cx('h-full rounded-full transition-all duration-500', tone === 'green' ? 'bg-emerald-500' : 'bg-blue-600')} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="min-w-full divide-y divide-slate-200 text-sm">{children}</table>
    </div>
  );
}
export const th = 'px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 bg-slate-50 whitespace-nowrap';
export const td = 'px-3 py-2.5 align-top';

export function ConfidencePill({ value }: { value: number }) {
  const color = value >= 70 ? 'green' : value >= 40 ? 'amber' : 'red';
  return <Badge color={color}>{value}</Badge>;
}

/** Sandboxed preview of untrusted HTML (no scripts, no same-origin access). */
export function HtmlPreview({ html, className }: { html: string; className?: string }) {
  return <iframe title="Email preview" sandbox="" srcDoc={html} className={cx('h-[560px] w-full rounded-lg border border-slate-200 bg-white', className)} />;
}
