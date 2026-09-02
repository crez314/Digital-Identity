"""S3 호환 스토리지 접근 (§15). crez-ml은 DB에 접근하지 않고 스토리지 키만 받는다(§2.2)."""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path

import boto3
from botocore.config import Config

from ..config import settings

log = logging.getLogger(__name__)
_client = None


def client():
    global _client
    if _client is None:
        s = settings()
        _client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint,
            region_name=s.s3_region,
            aws_access_key_id=s.s3_access_key,
            aws_secret_access_key=s.s3_secret_key,
            config=Config(s3={"addressing_style": "path" if s.s3_force_path_style else "auto"}),
        )
    return _client


def download(key: str, suffix: str = "") -> Path:
    """객체를 임시 파일로 내려받는다. 호출자가 정리 책임을 진다."""
    tmp = Path(tempfile.mkstemp(suffix=suffix or Path(key).suffix)[1])
    client().download_file(settings().s3_bucket, key, str(tmp))
    return tmp


def upload_bytes(key: str, data: bytes, content_type: str) -> None:
    client().put_object(Bucket=settings().s3_bucket, Key=key, Body=data, ContentType=content_type)


def get_json(key: str) -> dict | None:
    try:
        obj = client().get_object(Bucket=settings().s3_bucket, Key=key)
        import json

        return json.loads(obj["Body"].read())
    except Exception as e:  # noqa: BLE001 — 없으면 None으로 처리하는 것이 계약
        log.warning("get_json failed key=%s err=%s", key, e)
        return None
