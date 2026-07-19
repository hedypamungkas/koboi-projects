# Backend: koboi-agent[api]==0.18.2 from PyPI, config-only (no custom Python package).
# deep_research + websearch + self_healing + handover + jobs.webhooks are all config-driven, and
# the deep_research engine injects its own web tools (it does not call any custom tools -- verified
# live), so there is no `src/` package to install here. The bare `koboi serve` CLI is the CMD.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY config ./config
COPY data ./data
RUN useradd --create-home --uid 1000 app && mkdir -p /data && touch /data/.dockerkeep && chown -R app:app /app /data
USER app
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
