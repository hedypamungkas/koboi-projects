# Backend: koboi-agent[api]==0.18.2 from PyPI + this app's claims_ext package, one container.
# UC1 uses config-driven features only (orchestration / self_healing / handover / policy /
# jobs.webhooks are all YAML + builtins), so the bare `koboi serve` CLI is the CMD -- no
# custom entrypoint/hook module is needed (unlike finance-reconciliation).
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
COPY data ./data
RUN useradd --create-home --uid 1000 app && mkdir -p /data && touch /data/.dockerkeep && chown -R app:app /app /data
USER app
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
