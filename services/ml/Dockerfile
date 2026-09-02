# §1.1 ML 추론 서비스 — Python 3.11.
# GPU 이미지는 CI에서 별도 태그로 빌드한다(§1.1 CI/CD).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1

# opencv-python-headless 런타임 의존성만 설치한다 (GUI 라이브러리 제외)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scripts ./scripts

# 모델 가중치는 이미지에 굽지 않고 볼륨으로 주입한다.
# 라이선스 대장(docs/licenses.md) 관리와 이미지 재빌드 분리를 위해서다.
ENV MODEL_DIR=/app/models
RUN mkdir -p /app/models

EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
