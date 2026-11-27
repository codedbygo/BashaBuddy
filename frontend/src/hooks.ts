import { useCallback, useEffect, useRef, useState } from "react";
import { LANGS, type Lang } from "./i18n";

export type MicError = "denied" | "missing" | "unsupported" | "generic";
const MAX_SECONDS = 60;
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

/** Records one clip on demand. Never records without an explicit start() call. */
export function useRecorder(onComplete: (blob: Blob) => void) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; ctx: AudioContext; timer: number; cancelled: boolean } | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const cleanup = useCallback(() => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    r.stream.getTracks().forEach((t) => t.stop()); // releases the mic indicator
    r.ctx.close().catch(() => {});
    rec.current = null;
    setRecording(false);
    setAnalyser(null);
  }, []);

  const start = useCallback(async (): Promise<MicError | null> => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return "unsupported";
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      const name = (e as DOMException).name;
      return name === "NotAllowedError" || name === "SecurityError" ? "denied" : name === "NotFoundError" ? "missing" : "generic";
    }
    const mimeType = MIME_TYPES.find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const ctx = new AudioContext();
    const node = ctx.createAnalyser();
    node.fftSize = 64;
    ctx.createMediaStreamSource(stream).connect(node);

    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      const cancelled = rec.current?.cancelled;
      cleanup();
      if (!cancelled) onCompleteRef.current(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= MAX_SECONDS && recorder.state === "recording") recorder.stop();
    }, 250);
    rec.current = { recorder, stream, ctx, timer, cancelled: false };
    recorder.start();
    setSeconds(0);
    setAnalyser(node);
    setRecording(true);
    return null;
  }, [cleanup]);

  const stop = useCallback(() => {
    if (rec.current?.recorder.state === "recording") rec.current.recorder.stop();
  }, []);

  const cancel = useCallback(() => {
    if (!rec.current) return;
    rec.current.cancelled = true;
    if (rec.current.recorder.state === "recording") rec.current.recorder.stop();
    else cleanup();
  }, [cleanup]);

  useEffect(() => cancel, [cancel]);
  return { recording, seconds, analyser, start, stop, cancel };
}

export type SpeakResult = "ok" | "no-voice" | "unsupported";

/** Browser SpeechSynthesis, picking a voice that matches the selected language. */
export function useSpeech() {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  const [speakingId, setSpeakingId] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    // Chrome fills the voice list asynchronously; touching it early triggers the load.
    speechSynthesis.getVoices();
    const noop = () => {};
    speechSynthesis.addEventListener("voiceschanged", noop);
    return () => {
      speechSynthesis.removeEventListener("voiceschanged", noop);
      speechSynthesis.cancel();
    };
  }, [supported]);

  const stop = useCallback(() => {
    if (supported) speechSynthesis.cancel();
    setSpeakingId(null);
  }, [supported]);

  const speak = useCallback(
    (id: string, text: string, lang: Lang): SpeakResult => {
      if (!supported) return "unsupported";
      const voices = speechSynthesis.getVoices();
      const target = LANGS.find((l) => l.code === lang)!.speech.toLowerCase();
      const norm = (v: SpeechSynthesisVoice) => v.lang.replace("_", "-").toLowerCase();
      const voice = voices.find((v) => norm(v) === target) ?? voices.find((v) => norm(v).startsWith(lang));
      // Never read Telugu or Hindi text with an English voice; it would be gibberish.
      if (!voice && (lang !== "en" || voices.length === 0)) return "no-voice";

      speechSynthesis.cancel();
      // Speak line by line: Chrome cuts off single utterances longer than ~15 seconds.
      const lines = text
        .replace(/https?:\/\/\S+/g, "")
        .split("\n")
        .map((l) => l.replace(/^[•\-\s]+/, "").trim())
        .filter(Boolean);
      lines.forEach((line, i) => {
        const u = new SpeechSynthesisUtterance(line);
        if (voice) u.voice = voice;
        u.lang = voice?.lang ?? target;
        u.rate = 0.95;
        if (i === lines.length - 1) u.onend = () => setSpeakingId((cur) => (cur === id ? null : cur));
        u.onerror = () => setSpeakingId((cur) => (cur === id ? null : cur));
        speechSynthesis.speak(u);
      });
      setSpeakingId(id);
      return "ok";
    },
    [supported],
  );

  return { supported, speakingId, speak, stop };
}
