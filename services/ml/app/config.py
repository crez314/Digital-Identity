"""crez-ml 설정 (기술명세서 §7, §18)."""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # cpu | gpu | mock — GPU 없는 개발 머신에서는 cpu 또는 mock으로 전체 플로우를 돌린다(§18).
    ml_mode: str = "cpu"
    ml_internal_token: str = "dev-internal-token"

    model_dir: Path = Path(__file__).resolve().parent.parent / "models"

    s3_endpoint: str | None = None
    s3_region: str = "us-east-1"
    s3_bucket: str = "crez-media"
    s3_access_key: str | None = None
    s3_secret_key: str | None = None
    s3_force_path_style: bool = True

    # 프레임 샘플링 상한 — 장시간 영상에서 메모리가 터지지 않게 한다
    max_sampled_frames: int = 3000

    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


@lru_cache
def settings() -> Settings:
    return Settings()
