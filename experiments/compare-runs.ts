/**
 * 같은 인물·같은 시작 프레임으로 돌린 생성들을 나란히 비교한다 (진단용).
 * 무엇을 바꿨을 때 신원 유사도가 어떻게 움직였는지 한 표로 본다.
 */
import { prisma } from '@crez/db';
async function main() {
  const segIds = process.argv.slice(2);
  console.log(
    '구간/시도'.padEnd(14), 'cond'.padStart(5), '얼굴'.padStart(7), '대조군'.padStart(7),
    'margin'.padStart(7), '시간일관'.padStart(8), '종합'.padStart(7), ' 얼굴px', ' 상태',
  );
  for (const segId of segIds) {
    const jobs = await prisma.generationJob.findMany({
      where: { segmentId: segId }, orderBy: { attempt: 'asc' }, include: { outputs: true },
    });
    for (const j of jobs) {
      const p = j.params as any;
      const cond = Number(p.conditioningStrength ?? 0.6).toFixed(2);
      for (const o of j.outputs) {
        const q = await prisma.qcRun.findFirst({ where: { outputId: o.id }, orderBy: { createdAt: 'desc' } });
        if (!q) { console.log(`${segId.slice(0,8)}/a${j.attempt}`.padEnd(14), cond.padStart(5), '  QC 없음'); continue; }
        const m: any = Object.values((q.perIdentity ?? {}) as any)[0] ?? {};
        const f = (v: any, d = 4) => (typeof v === 'number' ? v.toFixed(d) : '—');
        console.log(
          `${segId.slice(0,8)}/a${j.attempt}`.padEnd(14), cond.padStart(5),
          f(m.faceSimilarity).padStart(7), f(m.cohortFaceSimilarity).padStart(7),
          f(m.identityMargin).padStart(7), f(m.temporalConsistency).padStart(8),
          f(Number(q.overallScore)).padStart(7),
          String(Math.round(m.medianFaceHeightPx ?? 0)).padStart(7), ' ', q.status,
        );
      }
    }
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,300)); process.exit(1); });
