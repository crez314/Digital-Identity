import { Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PRESIGN_TTL_SECONDS } from '@crez/shared';

/**
 * §15 스토리지.
 * 모든 미디어는 presigned URL로만 접근한다. 퍼블릭 접근은 차단하며
 * 만료는 기본 15분이다. 버킷 정책(버전 관리·삭제 방지·90일 만료)은 infra에서 설정한다.
 */
@Injectable()
export class S3Service {
  private readonly client: S3Client;
  readonly bucket: string;

  constructor() {
    this.bucket = process.env.S3_BUCKET ?? 'crez-media';
    this.client = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
      credentials: process.env.S3_ACCESS_KEY
        ? { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY ?? '' }
        : undefined,
    });
  }

  private get ttl(): number {
    return Number(process.env.S3_PRESIGN_TTL_SECONDS ?? PRESIGN_TTL_SECONDS);
  }

  async presignPut(key: string, contentType: string): Promise<{ url: string; expiresIn: number }> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
      { expiresIn: this.ttl },
    );
    return { url, expiresIn: this.ttl };
  }

  async presignGet(key: string): Promise<{ url: string; expiresIn: number }> {
    const url = await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: this.ttl,
    });
    return { url, expiresIn: this.ttl };
  }

  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { exists: true, size: r.ContentLength ?? 0, contentType: r.ContentType ?? null };
    } catch {
      return { exists: false, size: 0, contentType: null };
    }
  }

  async putJson(key: string, body: unknown): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key,
      Body: JSON.stringify(body), ContentType: 'application/json',
    }));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /**
   * prefix 아래 객체를 모두 지운다(프로젝트·Identity 삭제). 지운 개수를 돌려준다.
   * 버킷 버전 관리가 켜져 있으면 이전 버전은 남는다 — 복구 여지를 두는 §15 정책과 같다.
   */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) throw new Error(`prefix는 '/'로 끝나야 합니다: ${prefix}`); // 'projects/1' 이 'projects/10'까지 지우지 않게
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (page.Contents ?? []).map((o) => ({ Key: o.Key as string }));
      if (keys.length) {
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}
