/**
 * 같은 영상을 '다른 사람'의 centroid에 대고 재어 분리도를 본다 (진단용).
 *
 * "0.593이 낮다"는 말은 다른 사람이 몇 점을 받는지 알아야 성립한다. 본인 사진의 천장과
 * 타인의 바닥 사이 어디에 있는지가 실제 판별력이고, 합격선은 거기서 나와야 한다.
 */
import { readFileSync } from 'node:fs';
import { prisma, getProfileCentroids } from '@crez/db';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ml } from '../apps/worker/src/lib/ml';

const cos = (a: number[], b: number[]) => {
  let d=0,na=0,nb=0; for (let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return d/(Math.sqrt(na)*Math.sqrt(nb));
};
const wmean = (p: [number,number][]) => p.reduce((a,[v,w])=>a+v*w,0)/p.reduce((a,[,w])=>a+w,0);

async function main() {
  const files = process.argv.slice(2);
  const codes = ['CRZ-A009', 'CRZ-A008'];
  const refs: { code: string; vec: number[] }[] = [];
  for (const code of codes) {
    const id = await prisma.identity.findFirst({ where: { code } });
    if (!id) continue;
    const prof = await prisma.identityProfile.findFirst({ where: { identityId: id.id, status: 'ACTIVE' }, orderBy: { version: 'desc' } });
    if (!prof) continue;
    const [c] = await getProfileCentroids([prof.id]);
    if (c?.faceCentroid) refs.push({ code, vec: c.faceCentroid as number[] });
  }
  console.log('기준:', refs.map(r => r.code).join(' vs '), '\n');

  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION ?? 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
  });

  const acc = refs.map(() => [] as [number,number][]);
  for (const f of files) {
    const key = `diagnostics/impostor/${Date.now()}-${f.split('/').pop()}`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: readFileSync(f), ContentType: 'image/png' }));
    const r = await ml.embedFace({ imageKeys: [key], traceId: 'impostor' });
    const v = r.results[0];
    if (!v?.ok || !v.vector) continue;
    const q = Math.max(v.quality ?? 0, 0.05);
    refs.forEach((ref, i) => acc[i].push([cos(v.vector as number[], ref.vec), q]));
  }
  const n = acc[0].length;
  console.log(`프레임 ${n}장\n`);
  refs.forEach((ref, i) => {
    const sims = acc[i].map(([s]) => s).sort((a,b)=>b-a);
    const topN = Math.max(3, Math.round(n * 0.4));
    const best = acc[i].slice().sort((a,b) => b[1]-a[1]).slice(0, topN);
    console.log(`${ref.code}  전체가중평균 ${wmean(acc[i]).toFixed(4)}` +
      `  상위품질40%평균 ${wmean(best).toFixed(4)}` +
      `  최고 ${sims[0].toFixed(4)}  최저 ${sims[n-1].toFixed(4)}`);
  });
  const g = wmean(acc[0]), im = wmean(acc[1]);
  console.log(`\n분리도(본인−타인)  ${(g-im).toFixed(4)}`);
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,400)); process.exit(1); });
