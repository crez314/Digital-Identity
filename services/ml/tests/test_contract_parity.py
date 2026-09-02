"""
§3: DTO 단일 출처는 packages/contracts다.
Pydantic 모델이 생성된 JSON Schema와 어긋나면 런타임에 502(스키마 불일치)로 터진다.
CI에서 미리 잡는다.
"""
import json
from pathlib import Path

import pytest

from app import schemas

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schemas" / "contracts.schema.json"

# JSON Schema 이름 → Pydantic 모델
PAIRS = [
    ("EmbedFaceRequest", schemas.EmbedFaceRequest),
    ("EmbedFaceResponse", schemas.EmbedFaceResponse),
    ("EmbedBodyRequest", schemas.EmbedBodyRequest),
    ("AggregateRequest", schemas.AggregateRequest),
    ("AggregateResponse", schemas.AggregateResponse),
    ("VideoAnalyzeRequest", schemas.VideoAnalyzeRequest),
    ("VideoAnalyzeResponse", schemas.VideoAnalyzeResponse),
    ("IdentityAssignRequest", schemas.IdentityAssignRequest),
    ("IdentityAssignResponse", schemas.IdentityAssignResponse),
    ("QcScoreRequest", schemas.QcScoreRequest),
    ("QcScoreResponse", schemas.QcScoreResponse),
    ("QcArtifactRequest", schemas.QcArtifactRequest),
    ("QcArtifactResponse", schemas.QcArtifactResponse),
    ("ExtractFramesRequest", schemas.ExtractFramesRequest),
    ("ExtractFramesResponse", schemas.ExtractFramesResponse),
    ("ModelBundle", schemas.ModelBundle),
]


@pytest.fixture(scope="module")
def contracts() -> dict:
    assert SCHEMA_PATH.exists(), "pnpm contracts:jsonschema 를 먼저 실행하세요"
    return json.loads(SCHEMA_PATH.read_text())["definitions"]


def _properties(node: dict) -> dict:
    """zod-to-json-schema는 최상위를 $ref 없이 펼쳐서 낸다."""
    if "properties" in node:
        return node["properties"]
    for key in ("definitions", "$defs"):
        if key in node:
            first = next(iter(node[key].values()))
            if "properties" in first:
                return first["properties"]
    return {}


@pytest.mark.parametrize("name,model", PAIRS)
def test_field_names_match(contracts, name, model):
    assert name in contracts, f"{name}이 생성된 스키마에 없습니다"
    expected = set(_properties(contracts[name]))
    actual = set(model.model_json_schema().get("properties", {}))

    missing = expected - actual
    extra = actual - expected
    assert not missing, f"{name}: Pydantic에 없는 필드 {sorted(missing)}"
    assert not extra, f"{name}: contracts에 없는 필드 {sorted(extra)}"


def test_required_fields_are_not_weaker(contracts):
    """contracts가 필수로 정의한 필드를 Pydantic이 선택으로 두면 안 된다."""
    for name, model in PAIRS:
        expected_required = set(contracts[name].get("required", []))
        actual = model.model_json_schema()
        actual_required = set(actual.get("required", []))
        weaker = expected_required - actual_required
        assert not weaker, f"{name}: contracts에서 필수인데 Pydantic에서 선택인 필드 {sorted(weaker)}"
