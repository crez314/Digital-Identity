"""
§7.1 채택 모델 로더.

얼굴 검출 YuNet(MIT) / 얼굴 임베딩 SFace(Apache 2.0)는 OpenCV가 내장 API로 제공하므로
별도 프레임워크 없이 ONNX 가중치 파일만 있으면 CPU 추론이 가능하다(§18).

사용 금지 목록(InsightFace 가중치, Ultralytics YOLO, OpenPose 등)은 이 모듈에 반입하지 않는다.
"""
from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ..config import settings

log = logging.getLogger(__name__)

# opencv_zoo 배포 파일명. scripts/download_models.sh가 내려받는다.
YUNET_FILE = "face_detection_yunet_2023mar.onnx"
SFACE_FILE = "face_recognition_sface_2021dec.onnx"
RTMDET_FILE = "rtmdet_m_person.onnx"
RTMPOSE_FILE = "rtmpose_m.onnx"

FACE_DIM = 128  # SFace 출력 차원
FACE_STORAGE_DIM = 512  # §4.2 identity_embedding.vector(512) — 뒤를 0으로 패딩해 저장한다
BODY_DIM = 256

_detector = None
_recognizer = None
_person_detector = None
_pose = None


def model_path(name: str) -> Path:
    return settings().model_dir / name


def has_models() -> bool:
    return model_path(YUNET_FILE).exists() and model_path(SFACE_FILE).exists()


def is_mock() -> bool:
    return settings().ml_mode == "mock" or not has_models()


def face_detector(width: int = 320, height: int = 320):
    """YuNet — 경량, CPU 추론 가능. WIDER Easy 0.884 / Medium 0.866 / Hard 0.750."""
    global _detector
    if _detector is None:
        _detector = cv2.FaceDetectorYN.create(
            str(model_path(YUNET_FILE)), "", (width, height),
            score_threshold=0.6, nms_threshold=0.3, top_k=50,
        )
    _detector.setInputSize((width, height))
    return _detector


def face_recognizer():
    """SFace — MobileFaceNet 백본, LFW 0.9940."""
    global _recognizer
    if _recognizer is None:
        _recognizer = cv2.FaceRecognizerSF.create(str(model_path(SFACE_FILE)), "")
    return _recognizer


def person_detector():
    """RTMDet(Apache 2.0). 가중치가 없으면 None을 반환하고 얼굴 기반 폴백을 쓴다."""
    global _person_detector
    if _person_detector is None and model_path(RTMDET_FILE).exists():
        import onnxruntime as ort

        _person_detector = ort.InferenceSession(
            str(model_path(RTMDET_FILE)), providers=["CPUExecutionProvider"]
        )
    return _person_detector


def pose_estimator():
    """RTMPose(Apache 2.0). 없으면 keypoints는 None으로 반환한다."""
    global _pose
    if _pose is None and model_path(RTMPOSE_FILE).exists():
        import onnxruntime as ort

        _pose = ort.InferenceSession(str(model_path(RTMPOSE_FILE)), providers=["CPUExecutionProvider"])
    return _pose


def bundle() -> dict:
    """§7 모든 응답에 modelBundle(모델명+버전)을 포함해 재현성을 확보한다."""
    if is_mock():
        return {
            "detector": "mock-detector@1", "faceEmbedder": "mock-embedder@1",
            "bodyDetector": "mock-body@1", "tracker": "iou-bytetrack-style@1",
            "poseEstimator": None, "runtime": "mock",
        }
    return {
        "detector": "yunet@2023mar",
        "faceEmbedder": "sface@2021dec",
        "bodyDetector": "rtmdet-m@1.0" if person_detector() is not None else "yunet-derived@1",
        "tracker": "bytetrack-style@1",
        "poseEstimator": "rtmpose-m@1.0" if pose_estimator() is not None else None,
        "runtime": f"onnxruntime-cpu/opencv-{cv2.__version__}",
    }


def pad_to_storage_dim(vec: np.ndarray, dim: int = FACE_STORAGE_DIM) -> list[float]:
    """
    §4.2: 벡터 컬럼은 vector(512) 고정이고 dim 컬럼을 병행 관리한다.
    SFace(128차원)를 저장할 때는 뒤를 0으로 패딩한다 — 코사인 유사도는 패딩에 영향받지 않는다.
    """
    v = np.asarray(vec, dtype=np.float32).ravel()
    n = float(np.linalg.norm(v))
    if n > 0:
        v = v / n
    if v.size >= dim:
        return v[:dim].tolist()
    out = np.zeros(dim, dtype=np.float32)
    out[: v.size] = v
    return out.tolist()
