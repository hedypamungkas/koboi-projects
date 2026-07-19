# One image serves all three A2A roles (concierge / peer-it / peer-facilities); the config is
# selected at runtime via KOBOI_CONFIG (default: concierge). All features here are config-driven
# (peers/call_peer_agent, hooks, policy, proactive memory, handover), so the bare `koboi serve`
# CLI is the CMD -- no custom entrypoint. scripts/open_ticket.py is copied for the command hook.
FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
COPY scripts ./scripts
RUN useradd --create-home --uid 1000 app && mkdir -p /data && touch /data/.dockerkeep && chown -R app:app /app /data
USER app
EXPOSE 8000
# Shell form so ${KOBOI_CONFIG} expands at container start.
CMD koboi serve "config/${KOBOI_CONFIG:-concierge}.yaml" --host 0.0.0.0 --port 8000
