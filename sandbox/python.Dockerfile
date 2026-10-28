# Optional richer sandbox image for Python repos (pytest + ruff).
#   docker build -f sandbox/python.Dockerfile -t aegis-sandbox-python .
#   AEGIS_SANDBOX_IMAGE_PYTHON=aegis-sandbox-python
# Without it, Aegis uses python:3.12-alpine with unittest + a syntax check.
FROM python:3.12-alpine
RUN pip install --no-cache-dir pytest ruff
