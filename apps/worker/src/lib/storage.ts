import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const client = new S3Client({
  region: process.env.S3_REGION ?? 'us-east-1',
  endpoint: process.env.S3_ENDPOINT,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: process.env.S3_ACCESS_KEY
    ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY ?? '' }
    : undefined,
});

const bucket = () => process.env.S3_BUCKET ?? 'crez-media';

export const storage = {
  async putJson(key: string, body: unknown): Promise<void> {
    await client.send(new PutObjectCommand({
      Bucket: bucket(), Key: key, Body: JSON.stringify(body), ContentType: 'application/json',
    }));
  },
  async putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await client.send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }));
  },
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const r = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
      const text = await r.Body?.transformToString();
      return text ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  },
  async exists(key: string): Promise<boolean> {
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
      return true;
    } catch {
      return false;
    }
  },
};
