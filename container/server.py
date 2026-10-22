"""Bounce processing container: time-stretch / pitch-shift WAV files with the Rubber Band CLI.

One job per container instance. API (port 8080):
  POST /jobs?tempo=1.05&pitch=-2&formant=1   body: WAV  -> 202 {"state": "running"}
  GET  /jobs                                           -> {"state", "progress", "error"?}
  GET  /jobs/result                                    -> 200 audio/wav (when state == "done"; repeatable)
  DELETE /jobs                                         -> 204, kills the job and deletes files
  GET  /health                                         -> 200
Audio is kept only in a private temp directory, deleted on DELETE or when the instance stops.
"""
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8080"))
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(100 * 1000 * 1000)))
MAX_SECONDS = float(os.environ.get("MAX_SECONDS", "510"))
JOB_TIMEOUT = float(os.environ.get("JOB_TIMEOUT", "900"))
RUBBERBAND = os.environ.get("RUBBERBAND", "rubberband")

TEMPO_MIN, TEMPO_MAX = 0.5, 2.0
PITCH_MIN, PITCH_MAX = -12.0, 12.0


class Job:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"  # idle | receiving | running | done | error
        self.progress = 0.0
        self.error = None
        self.dir = None
        self.proc = None


job = Job()


def wav_duration(path):
    """Duration in seconds from a RIFF/WAVE header, or raise ValueError."""
    with open(path, "rb") as f:
        head = f.read(12)
        if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
            raise ValueError("not a WAV file")
        byte_rate = None
        while True:
            hdr = f.read(8)
            if len(hdr) < 8:
                break
            cid, size = hdr[0:4], struct.unpack("<I", hdr[4:8])[0]
            if cid == b"fmt ":
                fmt = f.read(size)
                byte_rate = struct.unpack("<I", fmt[8:12])[0]
                if size & 1:
                    f.read(1)
            elif cid == b"data":
                if not byte_rate:
                    raise ValueError("WAV data before fmt chunk")
                total = os.path.getsize(path) - f.tell()
                return min(size, total) / byte_rate
            else:
                f.seek(size + (size & 1), 1)
    raise ValueError("WAV file has no audio data")


def parse_params(query):
    q = parse_qs(query)

    def num(name, default):
        try:
            return float(q.get(name, [default])[0])
        except ValueError:
            raise ValueError(f"{name} must be a number")

    tempo = num("tempo", "1")
    pitch = num("pitch", "0")
    formant = q.get("formant", ["0"])[0] in ("1", "true")
    if not (TEMPO_MIN <= tempo <= TEMPO_MAX):
        raise ValueError(f"tempo must be between {TEMPO_MIN} and {TEMPO_MAX}")
    if not (PITCH_MIN <= pitch <= PITCH_MAX):
        raise ValueError(f"pitch must be between {PITCH_MIN} and {PITCH_MAX} semitones")
    if abs(tempo - 1) < 1e-6 and abs(pitch) < 1e-6:
        raise ValueError("nothing to do: tempo is 1 and pitch is 0")
    return tempo, pitch, formant


def rubberband_args(tempo, pitch, formant, src, dst):
    # --fine selects the R3 engine (Rubber Band 3+), the higher-quality engine for mixed music.
    args = [RUBBERBAND, "--fine"]
    if abs(tempo - 1) >= 1e-6:
        args += ["--tempo", f"{tempo:.6f}"]
    if abs(pitch) >= 1e-6:
        args += ["--pitch", f"{pitch:.4f}"]
    if formant:
        args += ["--formant"]
    return args + [src, dst]


PROGRESS_RE = re.compile(rb"(\d{1,3})%")


def run_job(tempo, pitch, formant):
    src = os.path.join(job.dir, "in.wav")
    dst = os.path.join(job.dir, "out.wav")
    try:
        proc = subprocess.Popen(
            rubberband_args(tempo, pitch, formant, src, dst),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        with job.lock:
            job.proc = proc
        started = time.monotonic()
        buf = b""
        while True:
            chunk = proc.stderr.read1(4096) if hasattr(proc.stderr, "read1") else proc.stderr.read(256)
            if not chunk:
                break
            buf = (buf + chunk)[-4096:]
            m = None
            for m in PROGRESS_RE.finditer(chunk):
                pass
            if m:
                with job.lock:
                    job.progress = min(0.99, int(m.group(1)) / 100)
            if time.monotonic() - started > JOB_TIMEOUT:
                proc.kill()
                raise RuntimeError("processing took too long")
        code = proc.wait()
        if code != 0 or not os.path.exists(dst):
            tail = buf.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
            raise RuntimeError(f"rubberband failed ({code}) {tail[0][:200]}")
        os.remove(src)
        with job.lock:
            job.state, job.progress, job.proc = "done", 1.0, None
    except Exception as e:  # noqa: BLE001 - report any failure to the client
        with job.lock:
            if job.state != "idle":
                job.state, job.error, job.proc = "error", str(e), None


def reset():
    with job.lock:
        if job.proc and job.proc.poll() is None:
            job.proc.kill()
        if job.dir:
            shutil.rmtree(job.dir, ignore_errors=True)
        job.state, job.progress, job.error, job.dir, job.proc = "idle", 0.0, None, None, None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "bounce-stretch"

    def log_message(self, fmt, *args):  # status line only; never request content
        print(f"{self.command} {urlparse(self.path).path} {args[1] if len(args) > 1 else ''}", flush=True)

    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self.send_json(200, {"ok": True})
        if path == "/jobs":
            with job.lock:
                body = {"state": job.state, "progress": round(job.progress, 3)}
                if job.error:
                    body["error"] = job.error
            return self.send_json(200, body)
        if path == "/jobs/result":
            with job.lock:
                if job.state != "done":
                    return self.send_json(409, {"error": f"job is {job.state}"})
                out = os.path.join(job.dir, "out.wav")
            size = os.path.getsize(out)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            # Kept until DELETE (or until the instance sleeps and its disk is discarded) so an
            # interrupted download can be retried.
            with open(out, "rb") as f:
                shutil.copyfileobj(f, self.wfile, 1 << 20)
            return None
        return self.send_json(404, {"error": "not found"})

    def do_DELETE(self):
        if urlparse(self.path).path != "/jobs":
            return self.send_json(404, {"error": "not found"})
        reset()
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()
        return None

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/jobs":
            return self.send_json(404, {"error": "not found"})
        try:
            tempo, pitch, formant = parse_params(url.query)
        except ValueError as e:
            return self.send_json(400, {"error": str(e)})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 44:
            return self.send_json(411, {"error": "a WAV body with Content-Length is required"})
        if length > MAX_BYTES:
            return self.send_json(413, {"error": "file too large"})
        with job.lock:
            if job.state not in ("idle", "done", "error"):
                return self.send_json(409, {"error": f"job is {job.state}"})
        reset()
        with job.lock:
            job.state = "receiving"
            job.dir = tempfile.mkdtemp(prefix="job-")
        src = os.path.join(job.dir, "in.wav")
        remaining = length
        with open(src, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        if remaining:
            reset()
            return self.send_json(400, {"error": "upload incomplete"})
        try:
            seconds = wav_duration(src)
        except ValueError as e:
            reset()
            return self.send_json(415, {"error": str(e)})
        if seconds > MAX_SECONDS:
            reset()
            return self.send_json(413, {"error": f"audio longer than {int(MAX_SECONDS)} s"})
        with job.lock:
            job.state = "running"
        threading.Thread(target=run_job, args=(tempo, pitch, formant), daemon=True).start()
        return self.send_json(202, {"state": "running", "seconds": round(seconds, 2)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
