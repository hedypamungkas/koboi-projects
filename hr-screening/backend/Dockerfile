FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
EXPOSE 8000
CMD ["python", "-m", "hr_ext.entrypoint"]
