/**
 * QC 점수를 저장된 결과물에 대해 다시 계산해 내부 시계열까지 들여다보는 진단 스크립트.
 * 운영 경로가 아니다 — 왜 점수가 낮은지 확인할 때만 쓴다.
 *
 *   pnpm --filter @crez/worker exec tsx scripts/inspect-qc.ts <segmentId> <attempt>
 */
import { getProfileCentroids, prisma } from '@crez/db';
import { ml } from '../src/lib/ml';

async function main() {
  const [segmentId, attemptArg] = process.argv.slice(2);
  const attempt = Number(attemptArg);
  const job = await prisma.generationJob.findFirstOrThrow({
    where: { segmentId, attempt },
    include: { outputs: true, segment: { include: { project: { include: { cast: true } } } } },
  });
  const output = job.outputs[0];
  const cast = job.segment.project.cast;
  const centroids = await getProfileCentroids(cast.map((c) => c.profileId));
  const byProfile = new Map(centroids.map((c) => [c.id, c]));

  const references = cast.flatMap((c) => {
    const cen = byProfile.get(c.profileId);
    return cen?.faceCentroid
      ? [{ identityId: c.identityId, faceCentroid: cen.faceCentroid, bodyCentroid: cen.bodyCentroid ?? undefined }]
      : [];
  });

  const res = await ml.scoreQc({
    videoKey: output.storageKey,
    references,
    sampleFps: 5,
  } as never);

  for (const p of (res as never as { perIdentity: Array<Record<string, unknown>> }).perIdentity) {
    const series = (p.series ?? []) as Array<Record<string, number | null>>;
    console.log('identity', p.identityId);
    console.log('  faceSimilarity', p.faceSimilarity, 'temporal', p.temporalConsistency,
      'binding', p.bindingStability, 'validFrameRatio', p.validFrameRatio);
    console.log('  trackSpans', JSON.stringify(p.trackSpans));
    console.log('  ms / trackIndex / similarity / embeddingDelta / quality');
    for (const s of series) {
      console.log(`   ${String(s.ms).padStart(5)} t${s.trackIndex} sim=${Number(s.similarity).toFixed(3)}`
        + ` delta=${s.embeddingDelta === null ? '  -  ' : Number(s.embeddingDelta).toFixed(3)}`
        + ` q=${Number(s.frameQuality).toFixed(2)}`);
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
