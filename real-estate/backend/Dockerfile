FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.4.0"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
