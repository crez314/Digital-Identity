'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

/** §1.1 서버 상태는 TanStack Query, 편집기 로컬 상태는 Zustand */
export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5000 } } }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
