/**
 * 자동 분류기를 이미 사람이 라벨을 붙인 사진들에 돌려 일치율을 본다 — 진단 스크립트, 운영 경로가 아니다.
 *
 *   pnpm --filter @crez/worker exec tsx scripts/check-slot-classifier.ts <identityCode>
 */
import { prisma } from '@crez/db';
import { ASSET_QUALITY_POLICY } from '@crez/shared';
import { ml } from '../src/lib/ml';
import { classifyCaptureSlot, slotSignalsFromLandmarks } from '../src/lib/asset-slot';

async function main() {
  const code = process.argv[2] ?? 'CRZ-A008';
  const identity = await prisma.identity.findFirst({ where: { code } });
  if (!identity) throw new Error(`인물 없음: ${code}`);

  const assets = await prisma.identityAsset.findMany({
    // rejectReason은 대부분 null이라 not: 'DEACTIVATED'로 거르면 null까지 빠진다
    where: {
      identityId: identity.id,
      captureSlot: { not: null },
      OR: [{ rejectReason: null }, { rejectReason: { not: 'DEACTIVATED' } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${code} — 사람이 라벨을 붙인 사진 ${assets.length}장\n`);

  let hit = 0;
  let review = 0;
  for (const a of assets) {
    const faceRes = await ml.embedFace({ imageKeys: [a.storageKey], traceId: 'slot-check' });
    const f = faceRes.results[0];
    const frameH = f?.imageHeight ?? 0;
    const faceHeightRatio = f?.bbox && frameH ? f.bbox.h / frameH : null;
    const hasFace = !!f?.ok && !!f.bbox;

    let bodyInFrameRatio: number | null = null;
    if (!hasFace || (faceHeightRatio ?? 0) < ASSET_QUALITY_POLICY.minFaceHeightRatio) {
      const bodyRes = await ml.embedBody({ imageKeys: [a.storageKey], traceId: 'slot-check' });
      bodyInFrameRatio = bodyRes.results[0]?.bodyInFrameRatio ?? null;
    }

    const s = slotSignalsFromLandmarks(f?.landmarks ?? null, f?.bbox?.w ?? null);
    const g = classifyCaptureSlot({
      hasFace, faceHeightRatio, bodyInFrameRatio,
      signedNoseOffset: s.signedNoseOffset, eyeDistanceRatio: s.eyeDistanceRatio,
    });

    const ok = g.slot === a.captureSlot;
    if (ok) hit += 1;
    if (g.needsReview) review += 1;
    console.log(
      `${ok ? '  ' : '✗ '}사람=${String(a.captureSlot).padEnd(11)} 분류=${String(g.slot).padEnd(11)}` +
      ` offset=${String(g.detail.signedNoseOffset).padStart(7)} eye=${String(g.detail.eyeDistanceRatio).padStart(6)}` +
      ` face=${String(g.detail.faceHeightRatio).padStart(6)}${g.needsReview ? '  [확인필요]' : ''}`,
    );
  }
  console.log(`\n일치 ${hit}/${assets.length} · 확인필요 ${review}장`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
