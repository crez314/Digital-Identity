'use client';

import { CrezApiError } from '@/lib/api';

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}>
      {children}
    </div>
  );
}

export function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex rounded px-2 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function Button({
  children, onClick, disabled, variant = 'primary', type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  type?: 'button' | 'submit';
}) {
  const styles = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900',
    secondary: 'border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800',
    danger: 'bg-red-600 text-white hover:bg-red-500',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {children}
    </button>
  );
}

/** §17 에러 규약을 그대로 노출한다 — 운영자가 사유 코드로 판단할 수 있어야 한다. */
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof CrezApiError) {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950">
        <div className="font-mono text-xs text-red-700 dark:text-red-400">{error.body.code}</div>
        <div className="mt-1 text-red-900 dark:text-red-200">{error.body.message}</div>
        {error.body.detail ? (
          <pre className="mt-2 max-h-40 overflow-auto rounded bg-red-100 p-2 text-xs dark:bg-red-900/40">
            {JSON.stringify(error.body.detail, null, 2)}
          </pre>
        ) : null}
        {error.body.traceId ? (
          <div className="mt-2 font-mono text-[11px] text-red-600">trace {error.body.traceId}</div>
        ) : null}
      </div>
    );
  }
  return (
    <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      {String((error as Error)?.message ?? error)}
    </div>
  );
}

export function Loading({ label = '불러오는 중' }: { label?: string }) {
  return <div className="py-8 text-center text-sm text-neutral-500">{label}…</div>;
}

export function Empty({ label }: { label: string }) {
  return <div className="py-10 text-center text-sm text-neutral-400">{label}</div>;
}
