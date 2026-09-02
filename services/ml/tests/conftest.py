import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("ML_MODE", "mock")
os.environ.setdefault("ML_INTERNAL_TOKEN", "test-token")

from app.main import app  # noqa: E402


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def auth() -> dict[str, str]:
    return {"x-internal-token": os.environ["ML_INTERNAL_TOKEN"]}
