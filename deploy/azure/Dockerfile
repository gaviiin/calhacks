# Pit Wall API for Azure Container Apps. Build from the repo root:
#   docker build -f deploy/azure/Dockerfile -t pitwall-api .
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8000 PITWALL_NOTIFY=dry
WORKDIR /app

COPY finance/requirements.txt finance/requirements.txt
COPY deploy/azure/requirements-azure.txt deploy/azure/requirements-azure.txt
RUN pip install --no-cache-dir -r finance/requirements.txt -r deploy/azure/requirements-azure.txt

# Code and read-only reference data. Runtime state (data/) is a mounted volume; keys/ is never shipped.
COPY finance finance
COPY world world
COPY policy policy
COPY integrations integrations
COPY ingestion/captures ingestion/captures
COPY ingestion/actor/src ingestion/actor/src

RUN useradd --uid 10001 --create-home pitwall && mkdir -p /app/data && chown pitwall /app/data
USER pitwall
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/accounts')"
CMD ["sh", "-c", "uvicorn finance.api:app --host 0.0.0.0 --port ${PORT}"]
