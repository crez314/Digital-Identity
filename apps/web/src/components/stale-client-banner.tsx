'use client';

import { useEffect, useState } from 'react';

const CHECK_INTERVAL_MS = 60_000;

async function fetchBootId(): Promise<string | null> {
  try {
    const res = await fetch('/api/client-version', { cache: 'no-store' });
    if (!res.ok) return null;
    return ((await res.json()) as { bootId?: string }).bootId ?? null;
  } catch {
    // 서버가 잠시 내려간 동안은 판단하지 않는다 — 다시 뜬 뒤 값이 바뀌었는지로 본다
    return null;
  }
}

/**
 * 이 탭의 코드가 서버보다 오래됐으면 새로고침하라고 알린다.
 *
 * 처음 받은 부팅 식별자를 기억해 두고, 탭으로 돌아올 때와 1분마다 다시 묻는다. 값이 바뀌었으면
 * 그 사이 서버가 새 코드로 다시 뜬 것이다. 업로드 도중일 수 있어 자동으로 새로고침하지는 않는다.
 */
export function StaleClientBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let initial: string | null = null;
    let cancelled = false;

    const check = async () => {
      const current = await fetchBootId();
      if (cancelled || current === null) return;
      if (initial === null) initial = current;
      else if (current !== initial) setStale(true);
    };

    void check();
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(timer);
    };
  }, []);

  if (!stale) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <span>
          이 화면은 서버보다 오래된 코드로 돌고 있습니다. 새로고침해야 최신 기능(사진 드래그 이동, 자동 분류 등)이
          제대로 동작합니다.
        </span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500"
        >
          새로고침
        </button>
      </div>
    </div>
  );
}
