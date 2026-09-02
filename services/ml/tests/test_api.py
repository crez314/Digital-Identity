"""crez-ml 엔드포인트 계약 검증 (§7). mock 모드라 GPU·모델 가중치가 필요 없다."""


def test_health(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert "modelBundle" in body


def test_internal_token_required(client):
    """서비스 간 호출만 허용한다 (§1.1)."""
    res = client.post("/v1/embed/face", json={"imageKeys": ["a.jpg"]})
    assert res.status_code == 401


def test_embed_face_returns_model_bundle(client, auth):
    """§7 모든 응답에 modelBundle을 포함해 재현성을 확보한다."""
    body = client.post("/v1/embed/face", json={"imageKeys": ["a.jpg", "b.jpg"]}, headers=auth).json()
    assert len(body["results"]) == 2
    assert body["modelBundle"]["runtime"]
    for r in body["results"]:
        assert r["ok"] is True
        assert r["dim"] == 512  # §4.2 vector(512)


def test_mock_is_deterministic(client, auth):
    """mock은 무작위가 아니어야 파이프라인 테스트가 재현 가능하다 (§18)."""
    a = client.post("/v1/embed/face", json={"imageKeys": ["same.jpg"]}, headers=auth).json()
    b = client.post("/v1/embed/face", json={"imageKeys": ["same.jpg"]}, headers=auth).json()
    assert a["results"][0]["vector"] == b["results"][0]["vector"]


def test_aggregate_reports_variance_without_judging(client, auth):
    """§2.2 ML은 수치만 낸다. 임계값 판정(CREZ-IDN-003)은 api·워커 몫이다."""
    vec = client.post("/v1/embed/face", json={"imageKeys": ["x.jpg"]}, headers=auth).json()["results"][0]["vector"]
    body = client.post(
        "/v1/profile/aggregate",
        json={"vectors": [{"id": f"v{i}", "vector": vec, "quality": 0.8} for i in range(4)]},
        headers=auth,
    ).json()
    assert body["dim"] == 512
    assert body["variance"] >= 0
    assert "passed" not in body and "ok" not in body


def test_identity_assign_is_one_to_one(client, auth):
    """§9.1 Hungarian 전역 최적 1:1 할당."""
    analysis = client.post("/v1/video/analyze", json={"videoKey": "v.mp4"}, headers=auth).json()
    tracks = analysis["tracks"]
    refs = [{"identityId": f"id-{i}", "faceCentroid": t["faceCentroid"]} for i, t in enumerate(tracks)]
    body = client.post("/v1/identity/assign", json={"tracks": tracks, "references": refs}, headers=auth).json()

    assigned = [a["identityId"] for a in body["assignments"] if a["identityId"]]
    assert len(assigned) == len(set(assigned)), "한 인물이 두 트랙에 할당되면 안 된다"
    for a in body["assignments"]:
        assert "margin" in a  # δ_margin 판정 근거를 반드시 제공한다


def test_qc_score_returns_series_but_no_verdict(client, auth):
    """§7 /v1/qc/score는 점수와 원시 시계열만 반환하고 합격 여부를 판단하지 않는다."""
    refs = [
        {"identityId": "id-a", "faceCentroid": [0.1] * 512},
        {"identityId": "id-b", "faceCentroid": [0.2] * 512},
    ]
    body = client.post("/v1/qc/score", json={"videoKey": "v.mp4", "references": refs}, headers=auth).json()

    assert len(body["perIdentity"]) == 2
    for p in body["perIdentity"]:
        assert p["series"], "프레임 단위 원시 시계열이 있어야 규칙 엔진이 구간을 특정할 수 있다"
        for key in ("faceSimilarity", "temporalConsistency", "bindingStability"):
            assert 0.0 <= p[key] <= 1.0
        # 판정 필드가 있으면 안 된다 — 판단은 crez-api가 한다
        assert "passed" not in p and "status" not in p


def test_qc_artifact_shape(client, auth):
    body = client.post("/v1/qc/artifact", json={"videoKey": "v.mp4"}, headers=auth).json()
    assert "spans" in body and "modelBundle" in body
