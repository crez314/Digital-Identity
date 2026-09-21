/**
 * 다중 시점 centroid가 자세 때문에 생기는 오탐을 줄이는지 검증한다 (진단용).
 *
 * 지금은 모든 프레임을 정면에 치우친 centroid 하나에 댄다. 고개를 돌린 프레임은
 * 같은 사람이어도 낮게 나온다 — 실제로 본인의 90도 사진이 0.25를 받는다.
 * 시점별 centroid를 만들어 "가장 가까운 시점"과 비교하면 자세가 아니라 신원을 재게 된다.
 */
import { readFileSync } from 'node:fs';
import { prisma, getProfileCentroids, listEmbeddings } from '@crez/db';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ml } from '../apps/worker/src/lib/ml';

const cos = (a: number[], b: number[]) => {
  let d=0,na=0,nb=0; for (let i=0;i<a.length;i++){d+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return d/(Math.sqrt(na)*Math.sqrt(nb));
};
const mean = (vs: number[][]) => {
  const out = new Array(vs[0].length).fill(0);
  for (const v of vs) for (let i=0;i<v.length;i++) out[i]+=v[i];
  return out.map(x => x/vs.length);
};

const GROUP: Record<string,string> = {
  FRONT:'정면', BODY_FRONT:'정면', LEFT_45:'45도', RIGHT_45:'45도', LEFT_90:'측면', RIGHT_90:'측면',
};

async function main() {
  const frameFiles = process.argv.slice(2);
  const id = await prisma.identity.findFirst({ where: { code: 'CRZ-A009' } });
  const prof = await prisma.identityProfile.findFirst({ where: { identityId: id!.id, status: 'ACTIVE' }, orderBy: { version: 'desc' } });
  const [c] = await getProfileCentroids([prof!.id]);
  const embs: any[] = await listEmbeddings(id!.id, 'FACE');
  const assets = await prisma.identityAsset.findMany({ where: { identityId: id!.id } });
  const slot = new Map(assets.map(a => [a.id, a.captureSlot]));

  const groups = new Map<string, number[][]>();
  for (const e of embs) {
    const g = GROUP[String(slot.get(e.assetId))] ?? '기타';
    groups.set(g, [...(groups.get(g) ?? []), e.vector as number[]]);
  }
  const views = new Map<string, number[]>();
  for (const [g, vs] of groups) { views.set(g, mean(vs)); console.log(`시점 centroid '${g}' ← ${vs.length}장`); }

  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION ?? 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: process.env.S3_ACCESS_KEY!, secretAccessKey: process.env.S3_SECRET_KEY! },
  });

  console.log('\n프레임      현행(단일)  정면    45도    측면   → 다중시점최대  품질');
  const cur: [number,number][] = [], multi: [number,number][] = [];
  for (const f of frameFiles) {
    const key = `diagnostics/multiview/${Date.now()}-${f.split('/').pop()}`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: readFileSync(f), ContentType: 'image/png' }));
    const r = await ml.embedFace({ imageKeys: [key], traceId: 'multiview' });
    const v = r.results[0];
    if (!v?.ok || !v.vector) { console.log((f.split('/').pop()??'').padEnd(11), '검출 실패'); continue; }
    const vec = v.vector as number[];
    const q = Math.max(v.quality ?? 0, 0.05);
    const single = cos(vec, c!.faceCentroid as number[]);
    const per = ['정면','45도','측면'].map(g => views.has(g) ? cos(vec, views.get(g)!) : NaN);
    const best = Math.max(...per.filter(Number.isFinite));
    cur.push([single, q]); multi.push([best, q]);
    console.log(
      (f.split('/').pop()??'').replace('.png','').padEnd(11),
      single.toFixed(3).padStart(8),
      ...per.map(x => (Number.isFinite(x)? x.toFixed(3): '  -  ').padStart(7)),
      '  →', best.toFixed(3).padStart(6), q.toFixed(2).padStart(6),
    );
  }
  const wm = (p: [number,number][]) => p.reduce((a,[v,w])=>a+v*w,0) / p.reduce((a,[,w])=>a+w,0);
  console.log('\n품질가중 평균  현행', wm(cur).toFixed(4), ' → 다중시점', wm(multi).toFixed(4));
  await prisma.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,400)); process.exit(1); });
