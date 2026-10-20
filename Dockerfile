# Smart Book AI: one image that serves the API and the built UI on port 8000.
# The language models stay in Ollama on the host (OLLAMA_URL); cover painting and voice (the multi-GB `media`
# group) are left out, and the app hides those features when they are missing.

# --- 1. build the React UI ----------------------------------------------------------------------------------------
FROM node:22-slim AS ui
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- 2. Python API ------------------------------------------------------------------------------------------------
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.18 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /app/backend

# dependencies first, so code changes don't reinstall them
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-group media --no-install-project
# the project is installed editable on purpose: it finds backend/seed and frontend/dist relative to its source
COPY backend/src ./src
COPY backend/seed ./seed
RUN uv sync --locked --no-dev --no-group media
COPY --from=ui /app/frontend/dist /app/frontend/dist

RUN useradd --create-home --uid 10001 smartbook && mkdir /data && chown smartbook /data
USER smartbook
ENV PATH="/app/.venv/bin:$PATH" \
    SMARTBOOK_HOST=0.0.0.0 \
    SMARTBOOK_PORT=8000 \
    SMARTBOOK_DATA_DIR=/data \
    OLLAMA_URL=http://host.docker.internal:11434
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["smartbook"]
