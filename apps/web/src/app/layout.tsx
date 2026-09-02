import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'CREZ Digital Identity Content Engine',
  description: '디지털 신원 라이브러리 기반 다중 인물 영상 콘텐츠 생성 시스템',
};

const NAV = [
  { href: '/identities', label: 'Identity' },
  { href: '/projects', label: '프로젝트' },
  { href: '/rulesets', label: 'QC Ruleset' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <Providers>
          <div className="min-h-screen">
            <header className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
              <div className="mx-auto flex max-w-7xl items-center gap-6 px-6 py-3">
                <Link href="/" className="text-sm font-semibold tracking-tight">
                  CREZ <span className="text-neutral-400">DICE</span>
                </Link>
                <nav className="flex gap-4 text-sm">
                  {NAV.map((n) => (
                    <Link key={n.href} href={n.href} className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
                      {n.label}
                    </Link>
                  ))}
                </nav>
              </div>
            </header>
            <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
