import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const clientConfig = {
  region: process.env.S3_REGION ?? 'us-east-1',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: process.env.S3_ACCESS_KEY
    ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY ?? '' }
    : undefined,
};
const client = new S3Client({ ...clientConfig, endpoint: process.env.S3_ENDPOINT });
const bucket = () => process.env.S3_BUCKET ?? 'crez-media';

/**
 * 외부 생성 제공자에게 넘기는 presigned URL은 인터넷에서 열려야 한다(§12.1 제약 3).
 * 로컬 MinIO 주소(localhost)로 서명하면 제공자가 레퍼런스 이미지를 받아갈 수 없으므로,
 * S3_PUBLIC_ENDPOINT가 있으면 그 주소로 서명한다. SigV4 서명에는 Host가 들어가기 때문에
 * 제공자가 접속하는 주소와 서명에 쓴 주소가 같아야 한다 — 내려받기·업로드는 내부 주소를 그대로 쓴다.
 */
let publicClient: S3Client | null = null;
function presignClient(): S3Client {
  const endpoint = process.env.S3_PUBLIC_ENDPOINT;
  if (!endpoint) return client;
  publicClient ??= new S3Client({ ...clientConfig, endpoint });
  return publicClient;
}

export async function presignedGet(key: string, ttl = 900): Promise<string> {
  return getSignedUrl(presignClient(), new GetObjectCommand({ Bucket: bucket(), Key: key }), { expiresIn: ttl });
}

export async function downloadTo(key: string, localPath: string): Promise<void> {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  if (!res.Body) throw new Error(`empty object: ${key}`);
  await pipeline(res.Body as Readable, createWriteStream(localPath));
}

export async function uploadFrom(key: string, localPath: string, contentType: string): Promise<void> {
  const body = await readFile(localPath);
  await client.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
}
