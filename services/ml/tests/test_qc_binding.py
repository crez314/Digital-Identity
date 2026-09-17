"""
QC 트랙 배정·시간 일관성 회귀 테스트 (§9.1, §10.1).

2026-09-16 실사 검증에서 드러난 문제를 고정한다.
캐스트 1명짜리 영상에 백댄서가 등장했더니 track 10개가 전부 그 1명에게 배정되어
얼굴 유사도 0.711 → 0.388, 시간 일관성 0.511 → 0.191로 내려앉았다.
같은 영상, 같은 모델인데 QC만 틀린 답을 낸 것이라 자동 재생성이 돈을 태울 뻔했다.
"""
import numpy as np
import pytest

from app.services import qc as qc_svc


def _vec(seed: int, dim: int = 512) -> list[float]:
    rng = np.random.default_rng(seed)
    v = rng.normal(size=dim).astype(np.float32)
    return (v / np.linalg.norm(v)).tolist()


ME = _vec(1)
STRANGER = _vec(99)


def _track(index: int, base: list[float], ms_list: list[int], jitter: float = 0.0) -> dict:
    """base 벡터를 조금씩 흔든 프레임으로 track 하나를 만든다."""
    rng = np.random.default_rng(index + 1000)
    frames = []
    for ms in ms_list:
        v = np.array(base, dtype=np.float32)
        if jitter:
            v = v + rng.normal(scale=jitter, size=v.shape).astype(np.float32)
            v = v / np.linalg.norm(v)
        frames.append({"ms": ms, "faceVector": v.tolist(), "faceQuality": 0.7, "occlusion": 0.0})
    centroid = np.mean([f["faceVector"] for f in frames], axis=0)
    centroid = centroid / np.linalg.norm(centroid)
    return {
        "trackIndex": index,
        "startMs": ms_list[0],
        "endMs": ms_list[-1],
        "frames": frames,
        "faceCentroid": centroid.tolist(),
    }


@pytest.fixture
def stub_analysis(monkeypatch):
    """실제 모델 없이 score()의 계산 경로만 태운다."""
    def _install(tracks: list[dict], duration_ms: int = 5000):
        monkeypatch.setattr(qc_svc.models, "is_mock", lambda: False)
        monkeypatch.setattr(
            qc_svc, "analyze_video",
            lambda *a, **k: {
                "tracks": tracks, "durationMs": duration_ms, "fps": 30.0,
                "modelBundle": {"runtime": "test"},
            },
        )
    return _install


REFS = [{"identityId": "me", "faceCentroid": ME}]


def test_다른_사람_track은_캐스트에_섞이지_않는다(stub_analysis):
    me = _track(0, ME, [0, 200, 400, 600, 800], jitter=0.01)
    others = [_track(i, STRANGER, [400, 600, 800], jitter=0.01) for i in range(1, 6)]
    stub_analysis([me, *others])

    res = qc_svc.score("v.mp4", REFS, None, sample_fps=5, assign_min_similarity=0.35)
    m = res["perIdentity"][0]

    assert [s["trackIndex"] for s in m["trackSpans"]] == [0]
    assert m["faceSimilarity"] > 0.9          # 본인 track만 봤으니 높아야 한다
    assert all(p["trackIndex"] == 0 for p in m["series"])


def test_임계값을_낮추면_남의_track까지_들어와_점수가_무너진다(stub_analysis):
    """고치기 전 동작을 재현한다 — 임계값이 배정의 유일한 방어선임을 못 박는다."""
    me = _track(0, ME, [0, 200, 400, 600, 800], jitter=0.01)
    others = [_track(i, STRANGER, [400, 600, 800], jitter=0.01) for i in range(1, 6)]
    stub_analysis([me, *others])

    loose = qc_svc.score("v.mp4", REFS, None, sample_fps=5, assign_min_similarity=-1.0)
    strict = qc_svc.score("v.mp4", REFS, None, sample_fps=5, assign_min_similarity=0.35)

    assert loose["perIdentity"][0]["faceSimilarity"] < strict["perIdentity"][0]["faceSimilarity"]
    assert loose["perIdentity"][0]["temporalConsistency"] < strict["perIdentity"][0]["temporalConsistency"]


def test_얼굴이_끊긴_구간은_인접_프레임으로_보지_않는다(stub_analysis):
    """
    같은 track이라도 중간에 얼굴을 못 잡으면 프레임이 띄엄띄엄 남는다.
    그 간격을 인접 프레임 변화량으로 계산하면 그냥 움직인 것을 신원이 튄 것으로 읽는다.
    """
    gapped = _track(0, ME, [0, 200, 400, 3000, 5000], jitter=0.12)
    stub_analysis([gapped])

    res = qc_svc.score("v.mp4", REFS, None, sample_fps=5, assign_min_similarity=0.35)
    deltas = [p["embeddingDelta"] for p in res["perIdentity"][0]["series"]]
    # 3000ms, 5000ms 프레임은 직전과 2.6초·2초 떨어져 있으므로 변화량을 매기지 않는다
    assert deltas[0] is None          # 첫 프레임은 비교 대상이 없다
    assert deltas[3] is None
    assert deltas[4] is None


def test_아무_track도_임계값을_못_넘으면_인물이_없는_것으로_본다(stub_analysis):
    """생성물이 완전히 다른 사람이면 점수가 높게 나오면 안 된다."""
    stub_analysis([_track(0, STRANGER, [0, 200, 400], jitter=0.01)])

    res = qc_svc.score("v.mp4", REFS, None, sample_fps=5, assign_min_similarity=0.35)
    m = res["perIdentity"][0]
    assert m["trackSpans"] == []
    assert m["bindingStability"] == 0.0
    assert m["faceSimilarity"] == 0.0
