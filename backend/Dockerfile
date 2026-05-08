FROM python:3.12-slim

# Build deps (gcc needed to compile pyvips cffi extension) + libvips runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libvips-dev \
    libvips-tools \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

ENV DATA_ROOT=/data
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--timeout-graceful-shutdown", "300"]
