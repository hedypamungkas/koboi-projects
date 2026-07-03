FROM python:3.12-slim
WORKDIR /app
COPY vendor/koboi_agent-*.whl /tmp/
RUN pip install --no-cache-dir "$(echo /tmp/koboi_agent-*.whl)[api]"
COPY healthcare-intake/pyproject.toml ./
COPY healthcare-intake/src ./src
RUN pip install --no-cache-dir -e .
COPY healthcare-intake/config ./config
COPY healthcare-intake/data ./data
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
