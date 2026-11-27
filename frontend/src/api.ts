import type { Lang } from "./i18n";

// Production must set VITE_API_BASE_URL; localhost is only a dev fallback.
const BASE = (import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:8000" : "")).replace(/\/$/, "");

export type SttStatus = "ready" | "loading" | "disabled" | "error";

export interface ChatResponse {
  answer: string;
  intent: string;
  language: Lang;
  scheme: { id: string; name: string; category: string; official_source: string | null; verification_status: string } | null;
  verification_status: string | null;
  follow_up: string | null;
  suggestions: string[];
  disclaimer: string;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 70_000): Promise<T> {
  let res: Response;
  try {
    // Long timeout: a free backend host can take ~50s to wake from a cold start.
    res = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ApiError("offline", 0);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : "";
    throw new ApiError(detail, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string; speech_to_text: SttStatus }>("/health", {}, 15_000),
  chat: (message: string, language: Lang, lastSchemeId?: string) =>
    request<ChatResponse>("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, language, context: { last_scheme_id: lastSchemeId ?? null } }),
    }),
  transcribe: (audio: Blob, language: Lang) => {
    const form = new FormData();
    form.append("audio", audio, "recording." + (audio.type.includes("mp4") ? "mp4" : audio.type.includes("ogg") ? "ogg" : "webm"));
    form.append("language", language);
    return request<{ transcript: string; detected_language: string | null; status: string }>("/api/transcribe", { method: "POST", body: form }, 120_000);
  },
  feedback: (helpful: boolean, intent?: string, schemeId?: string) =>
    request("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ helpful, intent, scheme_id: schemeId }),
    }).catch(() => undefined), // feedback is best-effort
};
