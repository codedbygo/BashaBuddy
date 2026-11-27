"""Vercel Python function: serves the FastAPI backend on the same domain as the frontend.

Whisper does not fit in a Vercel function (size and CPU limits), so speech-to-text is
turned off here and the frontend uses the browser's speech recognition instead.
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("WHISPER_ENABLED", "false")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.main import app  # noqa: E402,F401
