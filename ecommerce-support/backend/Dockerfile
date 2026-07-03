FROM python:3.12-slim
WORKDIR /app
COPY vendor/koboi_agent-*.whl /tmp/
RUN pip install --no-cache-dir "$(echo /tmp/koboi_agent-*.whl)[api]"
COPY ecommerce-support/pyproject.toml ./
COPY ecommerce-support/src ./src
RUN pip install --no-cache-dir -e .
COPY ecommerce-support/config ./config
COPY ecommerce-support/data ./data
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
