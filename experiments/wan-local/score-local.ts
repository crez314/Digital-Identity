/**
 * 로컬에서 만든 영상을 CREZ의 QC ML로 채점한다 — 자체 호스팅 결과물이 신원을 얼마나 유지하는지
 * 상용 API 결과물과 같은 잣대로 비교하기 위한 진단 스크립트. 운영 경로가 아니다.
 *
 *   pnpm --filter @crez/worker exec tsx ../../experiments/wan-local/score-local.ts <영상경로> <profileId>
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { getProfileCentroids, prisma } from '@crez/db';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ml } from '../../apps/worker/src/lib/ml';

async function main() {
  const [videoPath, profileId] = process.argv.slice(2);
  if (!videoPath || !profileId) throw new Error('사용법: score-local.ts <영상경로> <profileId>');

  const key = `experiments/wan-local/${Date.now()}-${basename(videoPath)}`;
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY!,
      secretAccessKey: process.env.S3_SECRET_KEY!,
    },
  });
  await s3.send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET!, Key: key,
    Body: readFileSync(videoPath), ContentType: 'video/webm',
  }));
  console.log('업로드:', key);

  const [centroid] = await getProfileCentroids([profileId]);
  if (!centroid?.faceCentroid) throw new Error('프로파일 centroid 없음');

  const res = await ml.scoreQc({
    videoKey: key,
    references: [{
      identityId: 'local',
      faceCentroid: centroid.faceCentroid,
      bodyCentroid: centroid.bodyCentroid ?? undefined,
    }],
    sampleFps: 5,
  } as never);

  const m = (res as never as { perIdentity: Array<Record<string, unknown>> }).perIdentity[0];
  const series = (m.series ?? []) as Array<Record<string, number>>;
  console.log('얼굴 유사도 ', m.faceSimilarity);
  console.log('신체 유사도 ', m.bodySimilarity);
  console.log('시간 일관성 ', m.temporalConsistency);
  console.log('binding    ', m.bindingStability);
  console.log('프레임별   ', series.map((s) => Number(s.similarity).toFixed(2)).join(' '));
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
