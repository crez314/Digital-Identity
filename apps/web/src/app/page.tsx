import Link from 'next/link';

const CARDS = [
  { href: '/identities', title: 'Identity 라이브러리', desc: '인물 등록, 자산 업로드, 캡처 슬롯 충족률, 프로파일 버전 관리' },
  { href: '/projects', title: '프로젝트', desc: '캐스팅·권리 게이트·소스 매핑·생성·QC·재생성' },
  { href: '/rulesets', title: 'QC Ruleset', desc: '점수 가중치와 임계값 튜닝 (§10)' },
];

export default function Home() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">CREZ Digital Identity Content Engine</h1>
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          디지털 신원 라이브러리 기반의 다중 인물 신원 일관성 유지 및 영상 콘텐츠 생성 시스템
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg border border-neutral-200 bg-white p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <div className="font-medium">{c.title}</div>
            <div className="mt-1 text-sm text-neutral-500">{c.desc}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
