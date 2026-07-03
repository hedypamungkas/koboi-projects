# Build context is the repo root (see docker-compose.yml) so we can reach
# both vendor/ (the koboi-agent wheel) and finance-reconciliation/ (this app).
FROM python:3.12-slim
WORKDIR /app
COPY vendor/koboi_agent-*.whl /tmp/
RUN pip install --no-cache-dir "$(echo /tmp/koboi_agent-*.whl)[api]"
COPY finance-reconciliation/pyproject.toml ./
COPY finance-reconciliation/src ./src
RUN pip install --no-cache-dir -e .
COPY finance-reconciliation/config ./config
COPY finance-reconciliation/erp_mcp_server.py ./erp_mcp_server.py
EXPOSE 8000
CMD ["python", "-m", "finance_ext.entrypoint"]
