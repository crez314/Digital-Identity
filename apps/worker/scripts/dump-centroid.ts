/** 진단용 — 저장된 프로파일 centroid를 꺼낸다 */
import { getProfileCentroids } from '@crez/db';
getProfileCentroids([process.argv[2]]).then((c) => {
  console.log(JSON.stringify({ face: c[0]?.faceCentroid ?? null, dim: c[0]?.faceCentroid?.length ?? 0 }));
  process.exit(0);
});
