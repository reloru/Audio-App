# Bounce processing container: Rubber Band CLI behind a small HTTP server (see server.py).
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends rubberband-cli python3 \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --system --no-create-home --uid 10001 bounce
COPY server.py /app/server.py
USER bounce
ENV PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python3", "/app/server.py"]
