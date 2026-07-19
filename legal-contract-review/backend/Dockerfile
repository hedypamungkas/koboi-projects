FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir "koboi-agent[api]==0.18.2"
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e .
COPY config ./config
COPY playbook_skills ./playbook_skills
RUN useradd --create-home --uid 1000 app && mkdir -p /data && touch /data/.dockerkeep && chown -R app:app /app /data
USER app
EXPOSE 8000
CMD ["koboi", "serve", "config/agent.yaml", "--host", "0.0.0.0", "--port", "8000"]
