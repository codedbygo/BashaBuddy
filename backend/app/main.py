import io
import logging
import os
import threading
from collections import Counter
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from . import assistant

log = logging.getLogger("bhashabuddy")
logging.basicConfig(level=logging.INFO)

WHISPER_ENABLED = os.getenv("WHISPER_ENABLED", "true").lower() == "true"
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
MAX_AUDIO_BYTES = int(os.getenv("MAX_AUDIO_MB", "10")) * 1024 * 1024
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",") if o.strip()]
ALLOWED_ORIGIN_REGEX = os.getenv("ALLOWED_ORIGIN_REGEX") or None  # e.g. https://bhashabuddy.*\.vercel\.app

stt = {"status": "disabled" if not WHISPER_ENABLED else "loading", "model": None}
# ponytail: one transcription at a time keeps memory flat on a small free host; use a worker pool if traffic grows.
stt_lock = threading.Lock()
feedback_counts: Counter = Counter()


def load_whisper() -> None:
    try:
        from faster_whisper import WhisperModel

        stt["model"] = WhisperModel(WHISPER_MODEL, device=WHISPER_DEVICE, compute_type=WHISPER_COMPUTE)
        stt["status"] = "ready"
        log.info("Whisper model '%s' loaded", WHISPER_MODEL)
    except Exception:  # model download failed, out of memory, missing libs: keep text chat alive
        log.exception("Whisper model failed to load; voice input disabled")
        stt["status"] = "error"


@asynccontextmanager
async def lifespan(_: FastAPI):
    if WHISPER_ENABLED:
        threading.Thread(target=load_whisper, daemon=True).start()
    yield


app = FastAPI(title="BhashaBuddy API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

Lang = Literal["en", "hi", "te"]


class ChatContext(BaseModel):
    last_scheme_id: str | None = Field(default=None, max_length=64)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=1000)
    language: Lang = "en"
    context: ChatContext | None = None

    @field_validator("message")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be empty")
        return v.strip()


class FeedbackRequest(BaseModel):
    helpful: bool
    intent: str | None = Field(default=None, max_length=40)
    scheme_id: str | None = Field(default=None, max_length=64)


@app.get("/health")
def health():
    return {"status": "ok", "speech_to_text": stt["status"], "whisper_model": WHISPER_MODEL if WHISPER_ENABLED else None,
            "schemes": len(assistant.SCHEMES)}


@app.get("/api/schemes")
def list_schemes(language: Lang = "en"):
    return [assistant.localize(s, language) for s in assistant.SCHEMES]


@app.get("/api/schemes/{scheme_id}")
def get_scheme(scheme_id: str, language: Lang = "en"):
    scheme = assistant.BY_ID.get(scheme_id)
    if scheme is None:
        raise HTTPException(404, "Scheme not found")
    return assistant.localize(scheme, language)


@app.post("/api/chat")
def chat(req: ChatRequest):
    last = req.context.last_scheme_id if req.context else None
    return assistant.respond(req.message, req.language, last)


def _transcribe(data: bytes, language: str) -> dict:
    with stt_lock:
        segments, info = stt["model"].transcribe(io.BytesIO(data), language=language, beam_size=1, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"transcript": text, "detected_language": info.language, "status": "ok" if text else "empty"}


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...), language: Lang = Form("en")):
    if stt["status"] != "ready":
        detail = {"loading": "Speech model is still loading. Please try again in a minute or type your question.",
                  "disabled": "Voice input is turned off on this server. Please type your question.",
                  "error": "Voice input is unavailable on this server. Please type your question."}[stt["status"]]
        raise HTTPException(503, detail)
    ctype = (audio.content_type or "").split(";")[0].strip()
    if not (ctype.startswith("audio/") or ctype in ("video/webm", "video/mp4")):
        raise HTTPException(415, "Unsupported file type. Please upload an audio recording.")
    # Read one byte past the limit so oversize uploads are rejected without buffering them fully.
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, f"Recording is too large (max {MAX_AUDIO_BYTES // (1024 * 1024)} MB).")
    if not data:
        raise HTTPException(400, "The recording is empty.")
    try:
        # Audio stays in memory only; nothing is written to disk or kept after the request.
        return await run_in_threadpool(_transcribe, data, language)
    except Exception:
        log.exception("Transcription failed")
        raise HTTPException(422, "Could not understand the recording. Please try again or type your question.")


@app.post("/api/feedback")
def feedback(req: FeedbackRequest):
    # Only counts are kept, in memory. No message text or personal data is stored.
    feedback_counts["helpful" if req.helpful else "not_helpful"] += 1
    return {"status": "received"}
