FROM python:3.12-slim
WORKDIR /app
COPY vendor/koboi_agent-*.whl /tmp/
RUN pip install --no-cache-dir "$(echo /tmp/koboi_agent-*.whl)[api]"
COPY hr-screening/pyproject.toml ./
COPY hr-screening/src ./src
RUN pip install --no-cache-dir -e .
COPY hr-screening/config ./config
EXPOSE 8000
CMD ["python", "-m", "hr_ext.entrypoint"]
