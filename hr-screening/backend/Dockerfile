FROM python:3.12-slim
WORKDIR /app
# git: sandbox.git_init seeds each jobs workdir as a git repo (audit trail) -- needs the binary.
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
# .dockerkeep makes /data non-empty so Docker seeds the named volume from this
# non-root /data on first mount (empty dirs are skipped -> volume would be root-owned,
# breaking USER app writes to the koboi sqlite sidecar).
RUN useradd --create-home --uid 1000 app && mkdir -p /data && touch /data/.dockerkeep && chown -R app:app /app /data
USER app
EXPOSE 8000
CMD ["python", "-m", "hr_ext.entrypoint"]
