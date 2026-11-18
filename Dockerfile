# OpenAI-Codex: build the browser frontend independently of the runtime.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
COPY package.json /app/package.json
COPY locales/ /app/locales/
RUN npm run build:web

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /data && chown appuser:appuser /data
COPY requirements-web.txt ./
RUN pip install --no-cache-dir -r requirements-web.txt
COPY ai/ ./ai/
COPY engine/ ./engine/
COPY i18n/ ./i18n/
COPY locales/ ./locales/
COPY engine_sidecar.py web_app.py LICENSE THIRD-PARTY-NOTICES.md ./
COPY third-party/ ./third-party/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
ENV HOST=0.0.0.0 PORT=5000 MMDL_DOWNLOADS=/data PYTHONDONTWRITEBYTECODE=1
USER appuser
EXPOSE 5000
CMD ["python", "web_app.py"]
