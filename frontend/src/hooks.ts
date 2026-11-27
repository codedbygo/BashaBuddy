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

// Minimal typing for the Web Speech API (not in TypeScript's DOM lib).
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
const SpeechRecognitionCtor: (new () => Recognition) | undefined =
  typeof window !== "undefined" ? ((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition) : undefined;

/**
 * Browser speech recognition, used when no Whisper server is available (e.g. Vercel-only hosting).
 * Chrome sends the audio to its own speech service; BhashaBuddy never stores it.
 */
export function useBrowserRecognition(onComplete: (text: string, error: MicError | null) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const rec = useRef<{ r: Recognition; cancelled: boolean; text: string; error: MicError | null } | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const start = useCallback((lang: Lang): MicError | null => {
    if (!SpeechRecognitionCtor) return "unsupported";
    const r = new SpeechRecognitionCtor();
    r.lang = LANGS.find((l) => l.code === lang)!.speech;
    r.interimResults = true;
    r.continuous = false;
    const state = { r, cancelled: false, text: "", error: null as MicError | null };
    r.onresult = (e) => {
      state.text = Array.from(e.results, (res) => res[0].transcript).join(" ").trim();
      setInterim(state.text);
    };
    r.onerror = (e) => {
      // "no-speech" and "aborted" just end with an empty transcript.
      if (e.error === "not-allowed" || e.error === "service-not-allowed") state.error = "denied";
      else if (e.error === "audio-capture") state.error = "missing";
      else if (e.error === "network") state.error = "generic";
    };
    r.onend = () => {
      rec.current = null;
      setListening(false);
      setInterim("");
      if (!state.cancelled) onCompleteRef.current(state.text, state.error);
    };
    rec.current = state;
    try {
      r.start();
    } catch {
      rec.current = null;
      return "generic";
    }
    setListening(true);
    return null;
  }, []);

  const stop = useCallback(() => rec.current?.r.stop(), []);
  const cancel = useCallback(() => {
    if (!rec.current) return;
    rec.current.cancelled = true;
    rec.current.r.abort();
  }, []);
  useEffect(() => cancel, [cancel]);

  return { supported: !!SpeechRecognitionCtor, listening, interim, start, stop, cancel };
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
