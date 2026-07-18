# Backend: koboi-agent[api]==0.18.2 from PyPI + cs_ext, one container.
# proactive memory + self_consistency + media + handover + jobs.webhooks are all config-driven,
# so the bare `koboi serve` CLI is the CMD (no custom entrypoint).
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
COPY data ./data
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
