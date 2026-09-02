#!/usr/bin/env node
/**
 * §7.4 라이선스 스캐너.
 *
 * AGPL 및 비상업 라이선스 의존성이 추가되면 빌드를 실패시킨다.
 * 사람의 주의력에 의존하면 반드시 새어 들어온다.
 *
 * 검사 대상:
 *  1. node_modules의 모든 패키지 license 필드
 *  2. Python requirements.txt의 금지 패키지명
 *  3. 소스 코드에 금지 모델/패키지가 import되었는지
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');

/** SaaS 구조에서 소스 공개 의무가 발동하거나 상업 이용이 금지된 라이선스 (§7.1, §22) */
const FORBIDDEN_LICENSES = [
  /\bAGPL\b/i,
  /\bSSPL\b/i,
  /Commons[- ]Clause/i,
  /non[- ]?commercial/i,
  /CC[- ]BY[- ]NC/i,
  /research[- ]only/i,
];

/** §7.1 사용 금지 목록 — 코드베이스 반입 불가 */
const FORBIDDEN_PACKAGES = [
  { name: 'insightface', reason: '사전학습 가중치가 비상업 연구 목적 전용 (§7.1)' },
  { name: 'ultralytics', reason: 'AGPL-3.0 — SaaS에서 소스 공개 의무 발동 (§7.1)' },
  { name: 'openpose', reason: '상업 이용 불가 — RTMPose 사용 (§7.1)' },
  { name: 'facenet-pytorch', reason: 'VGGFace2 데이터셋 철회 (§7.1)' },
  { name: 'adaface', reason: '가중치가 연구용 데이터셋(Glint360K) 학습 (§7.1)' },
  { name: 'magface', reason: '가중치가 연구용 데이터셋 학습 (§7.1)' },
  { name: 'yolov5', reason: 'AGPL-3.0 (§7.1)' },
  { name: 'yolov8', reason: 'AGPL-3.0 (§7.1)' },
  // 코드는 퍼미시브이나 배포 가중치가 연구 전용 데이터셋 학습 — research 격리 구역에서만 허용
  { name: 'torchreid', reason: '가중치가 Market-1501·MSMT17·DukeMTMC(철회) 학습 — 연구 전용 (§7.1)' },
  { name: 'osnet', reason: '가중치가 연구 전용 Re-ID 데이터셋 학습 (§7.1)' },
  { name: 'fastreid', reason: '가중치가 연구 전용 Re-ID 데이터셋 학습 (§7.1)' },
];

/** 라이선스 정보가 없거나 특이한 패키지 중 검토를 마친 것 */
const ALLOWLIST = new Set([]);

/**
 * research 트랙 격리 구역 (§7.1).
 *
 * 연구 전용 가중치 모델을 성능 비교 목적으로 다루는 것 자체는 막지 않는다.
 * 다만 production 경로로 새어나가지 않아야 하므로, 다음 세 곳에서만 참조를 허용한다.
 *   1. 격리 디렉터리 자체
 *   2. 격리 전용 의존성 파일
 *   3. 지연 로딩 다리 역할을 하는 레지스트리 (CREZ_ALLOW_RESEARCH_ENCODERS 가드 안쪽)
 * 그 밖의 위치에서 참조되면 격리가 깨진 것이므로 빌드를 실패시킨다.
 */
const RESEARCH_QUARANTINE = [
  'services/ml/app/encoders/research/',
  'services/ml/requirements-research.txt',
  'services/ml/app/encoders/registry.py',
];

const inQuarantine = (path) => RESEARCH_QUARANTINE.some((q) => path.startsWith(q));

const violations = [];
const warnings = [];
const quarantined = [];

// ── 1. node 의존성 ────────────────────────────────────────
function scanNodeModules(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === '.bin') continue;
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;

    if (entry.startsWith('@')) {
      scanNodeModules(full, depth + 1);
      continue;
    }

    const pkgPath = join(full, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        const license = typeof pkg.license === 'string'
          ? pkg.license
          : pkg.license?.type ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type).join(',') : '');
        const id = `${pkg.name}@${pkg.version}`;

        if (ALLOWLIST.has(pkg.name)) continue;

        if (license && FORBIDDEN_LICENSES.some((re) => re.test(license))) {
          violations.push({ kind: 'license', id, license, reason: '금지 라이선스' });
        }
        const forbidden = FORBIDDEN_PACKAGES.find((f) => pkg.name?.toLowerCase().includes(f.name));
        if (forbidden) {
          violations.push({ kind: 'package', id, license, reason: forbidden.reason });
        }
        if (!license && pkg.name && !pkg.private) {
          warnings.push({ id, reason: 'license 필드 없음 — 수동 확인 필요' });
        }
      } catch {
        // 깨진 package.json은 스캔 대상이 아니다
      }
    }
    const nested = join(full, 'node_modules');
    if (existsSync(nested)) scanNodeModules(nested, depth + 1);
  }
}

const pnpmStore = join(ROOT, 'node_modules', '.pnpm');
scanNodeModules(existsSync(pnpmStore) ? pnpmStore : join(ROOT, 'node_modules'));

// ── 2. Python 의존성 ──────────────────────────────────────
const reqFiles = ['services/ml/requirements.txt', 'services/ml/requirements-dev.txt'];
for (const rel of reqFiles) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const name = line.trim().split(/[=<>~\[#]/)[0].trim().toLowerCase();
    if (!name || line.trim().startsWith('#') || name.startsWith('-r')) continue;
    const forbidden = FORBIDDEN_PACKAGES.find((f) => name.includes(f.name));
    if (forbidden) {
      violations.push({
        kind: 'python', id: `${name} (${rel})`,
        reason: `${forbidden.reason} — production 의존성에 있으면 안 된다`,
      });
    }
  }
}

// ── 3. 소스 코드 import 검사 ──────────────────────────────
const patterns = FORBIDDEN_PACKAGES.map((f) => f.name).join('|');
try {
  const hits = execSync(
    `grep -rniE "(import|from|require).*(${patterns})" ` +
    `--include=*.py --include=*.ts --include=*.tsx ` +
    `apps packages services scripts 2>/dev/null || true`,
    { cwd: ROOT, encoding: 'utf8' },
  ).trim();
  if (hits) {
    for (const line of hits.split('\n')) {
      // 이 스캐너 자신과 문서의 언급은 위반이 아니다
      if (line.startsWith('scripts/license-scan')) continue;
      const file = line.split(':')[0];
      if (inQuarantine(file)) {
        quarantined.push(file);
        continue;
      }
      violations.push({
        kind: 'import', id: line.slice(0, 160),
        reason: '격리 구역 밖에서 연구 전용 모델을 참조한다 (§7.1)',
      });
    }
  }
} catch {
  // grep 실패는 무시
}

// ── 결과 ──────────────────────────────────────────────────
console.log(`라이선스 스캔 — ${new Date().toISOString()}`);
console.log(`금지 라이선스 패턴 ${FORBIDDEN_LICENSES.length}개, 금지 패키지 ${FORBIDDEN_PACKAGES.length}개 검사`);

if (quarantined.length > 0) {
  const files = [...new Set(quarantined)];
  console.log(`\nresearch 격리 구역에서만 참조됨 (허용): ${files.length}개 파일`);
  for (const f of files) console.log(`  - ${f}`);
  console.log('  → production 빌드·기본 requirements에는 포함되지 않아야 한다.');
}

if (warnings.length > 0) {
  console.log(`\n확인 필요 ${warnings.length}건 (빌드는 계속됨):`);
  for (const w of warnings.slice(0, 10)) console.log(`  - ${w.id}: ${w.reason}`);
  if (warnings.length > 10) console.log(`  ... 외 ${warnings.length - 10}건`);
}

if (violations.length > 0) {
  console.error(`\n❌ 라이선스 위반 ${violations.length}건 — 빌드를 중단합니다 (§7.4)\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.id}`);
    console.error(`      ${v.reason}${v.license ? ` (license: ${v.license})` : ''}`);
  }
  console.error('\ndocs/licenses.md의 대체 모델을 사용하세요.');
  process.exit(1);
}

console.log('\n✅ 금지 라이선스·패키지 의존성이 없습니다.');
