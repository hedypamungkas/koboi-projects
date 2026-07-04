FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.4.0"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
COPY erp_mcp_server.py ./erp_mcp_server.py
EXPOSE 8000
CMD ["python", "-m", "finance_ext.entrypoint"]
