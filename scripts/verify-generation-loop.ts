/**
 * 실제 생성 영상에 대한 CREZ 판정 루프 검증.
 *
 * ML 서비스가 낸 실측 시계열(/v1/qc/score 응답)에 규칙 엔진과 점수 엔진을 적용해
 * finding·종합점수·합격여부까지 실제로 산출되는지 확인한다.
 * mock이 아니라 상용 모델이 만든 영상과 실제 얼굴 임베딩을 사용한다.
 *
 * 사용: pnpm exec tsx scripts/verify-generation-loop.ts <qc-score-응답.json>
 */
import { readFileSync } from 'node:fs';
import { compositeScore, detectAll, judgeMultiPerson, type IdentitySeries } from '@crez/engine';
import { PrismaClient } from '@prisma/client';
import { QcThresholds, ScoreWeights } from '@crez/contracts';

const prisma = new PrismaClient();

async function main() {
  const path = process.argv[2] ?? '/tmp/qc-res.json';
  const res = JSON.parse(readFileSync(path, 'utf8'));

  const ruleset = await prisma.qcRuleset.findFirstOrThrow({ where: { isActive: true } });
  const weights = ScoreWeights.parse(ruleset.weights);
  const thresholds = QcThresholds.parse(ruleset.thresholds);

  console.log(`ruleset: ${ruleset.version}`);
  console.log(`영상: ${res.videoKey} (${res.durationMs}ms)`);
  console.log(`모델: ${res.modelBundle.detector} + ${res.modelBundle.faceEmbedder}\n`);

  const scores: Record<string, number> = {};
  for (const m of res.perIdentity) {
    const score = compositeScore(
      {
        faceSimilarity: m.faceSimilarity,
        bodySimilarity: m.bodySimilarity,
        temporalConsistency: m.temporalConsistency,
        motionConsistency: m.motionConsistency,
        bindingStability: m.bindingStability,
        validFrameRatio: m.validFrameRatio,
      },
      weights,
    );
    scores[m.identityId] = score;

    const series: IdentitySeries = {
      identityId: m.identityId,
      series: m.series,
      trackSpans: m.trackSpans,
    };
    const findings = detectAll(series, thresholds);

    console.log(`[${m.identityId}] 종합 ${score.toFixed(4)}`);
    console.log(`  face ${m.faceSimilarity.toFixed(4)} · temporal ${m.temporalConsistency.toFixed(4)} · binding ${m.bindingStability.toFixed(4)}`);
    if (findings.length === 0) {
      console.log('  finding 없음');
    } else {
      for (const f of findings) {
        console.log(`  ${f.findingType} [${f.severity}] ${f.startMs}–${f.endMs}ms conf=${f.confidence.toFixed(3)}`);
        if (f.evidence.note) console.log(`      ${f.evidence.note}`);
      }
    }
    console.log();
  }

  const verdict = judgeMultiPerson(scores, thresholds);
  console.log('── 판정 (§10.3) ──');
  console.log(`  합격: ${verdict.passed}`);
  console.log(`  종합: ${verdict.overallScore}`);
  if (verdict.reasons.length) console.log(`  사유: ${verdict.reasons.join(' / ')}`);
  if (verdict.failingIdentityIds.length) console.log(`  미달 인물: ${verdict.failingIdentityIds.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
