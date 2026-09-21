/**
 * 영상 프레임의 얼굴 유사도가 "진짜 신원 이탈"인지 "얼굴이 작아서 생긴 측정 손실"인지 가른다.
 *
 * 같은 프레임을 그대로 / 2배 / 3배로 키워 각각 재고, 키웠을 때 점수가 오르면 정보가 늘어난 게
 * 아니라 검출·정렬이 화소를 더 받아 나아진 것이다 = 측정 손실. 안 오르면 진짜 이탈이다.
 * 진단용 스크립트, 운영 경로가 아니다.
 */
import { readFileSync } from 'node:fs';
import { prisma, getProfileCentroids } from '@crez/db';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ml } from '../apps/worker/src/lib/ml';

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

async function main() {
  const files = process.argv.slice(2);
  const id = await prisma.identity.findFirst({ where: { code: 'CRZ-A009' } });
  const prof = await prisma.identityProfile.findFirst({
    where: { identityId: id!.id, status: 'ACTIVE' }, orderBy: { version: 'desc' },
  });
  const [c] = await getProfileCentroids([prof!.id]);
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION ?? 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
  });
  console.log('파일'.padEnd(26), '유사도', ' 얼굴px', ' 품질');
  for (const f of files) {
    const key = `diagnostics/facescale/${Date.now()}-${f.split('/').pop()}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET!, Key: key, Body: readFileSync(f), ContentType: 'image/png',
    }));
    const r = await ml.embedFace({ imageKeys: [key], traceId: 'facescale' });
    const v = r.results[0];
    if (!v?.ok || !v.vector) { console.log((f.split('/').pop() ?? '').padEnd(26), '검출 실패', v?.error ?? ''); continue; }
    const sim = cos(v.vector as number[], c!.faceCentroid as number[]);
    console.log(
      (f.split('/').pop() ?? '').padEnd(26),
      sim.toFixed(4).padStart(6),
      String(Math.round(v.bbox?.h ?? 0)).padStart(6),
      (v.quality ?? 0).toFixed(3).padStart(6),
    );
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,300)); process.exit(1); });
