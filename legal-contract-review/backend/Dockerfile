FROM python:3.12-slim
WORKDIR /app
COPY vendor/koboi_agent-*.whl /tmp/
RUN pip install --no-cache-dir "$(echo /tmp/koboi_agent-*.whl)[api]"
COPY legal-contract-review/pyproject.toml ./
COPY legal-contract-review/src ./src
RUN pip install --no-cache-dir -e .
COPY legal-contract-review/config ./config
COPY legal-contract-review/playbook_skills ./playbook_skills
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
