import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle, Check, Copy, ExternalLink, FileText, GraduationCap, HandHeart, Info, Loader2, Lock, Mic, MicOff,
  RefreshCw, RotateCcw, SendHorizontal, ShieldCheck, ShoppingBasket, Sprout, Square, ThumbsDown, ThumbsUp, Trash2,
  Volume2, WifiOff, X,
} from "lucide-react";
import { api, ApiError, type ChatResponse, type SttStatus } from "./api";
import { useBrowserRecognition, useRecorder, useSpeech, type MicError } from "./hooks";
import { LANGS, STRINGS, type Lang, type Strings } from "./i18n";

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; data: ChatResponse; feedback?: boolean }
  | { id: string; role: "error"; text: string; retry: string; userId: string };
type AssistantMsg = Extract<Msg, { role: "assistant" }>;
type Phase = "idle" | "recording" | "transcribing" | "review" | "thinking";
type ServerState = SttStatus | "checking" | "offline";

const uid = () => Math.random().toString(36).slice(2);
const TOPICS = [
  { key: "income", icon: FileText },
  { key: "scholarship", icon: GraduationCap },
  { key: "ration", icon: ShoppingBasket },
  { key: "farmer", icon: Sprout },
  { key: "pension", icon: HandHeart },
  { key: "documents", icon: FileText },
] as const;

export default function App() {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem("bb-lang") as Lang) || "te");
  const t = STRINGS[lang];
  const [messages, setMessages] = useState<Msg[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [draft, setDraft] = useState("");
  const [transcript, setTranscript] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [server, setServer] = useState<ServerState>("checking");
  const speech = useSpeech();
  const endRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    localStorage.setItem("bb-lang", lang);
    document.documentElement.lang = lang;
  }, [lang]);

  const checkHealth = useCallback(async () => {
    try {
      setServer((await api.health()).speech_to_text);
    } catch {
      setServer("offline");
    }
  }, []);

  // Poll while the speech model is still loading so the badge updates by itself.
  useEffect(() => {
    checkHealth();
  }, [checkHealth]);
  useEffect(() => {
    if (server !== "loading") return;
    const id = setInterval(checkHealth, 5000);
    return () => clearInterval(id);
  }, [server, checkHealth]);

  useEffect(() => {
    if (messages.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, phase]);

  // Remembered so follow-ups like "What documents are needed?" refer to the last service discussed.
  const lastSchemeId = messages.findLast((m): m is AssistantMsg => m.role === "assistant" && !!m.data.scheme)?.data.scheme?.id;

  const speakMsg = useCallback(
    (id: string, data: ChatResponse) => {
      const result = speech.speak(id, data.answer, data.language);
      setNotice(result === "ok" ? null : result === "no-voice" ? t.noVoice : t.noTts);
    },
    [speech, t],
  );

  const ask = useCallback(
    async (text: string, viaVoice = false) => {
      const q = text.trim();
      if (!q || phase === "thinking") return;
      speech.stop();
      setNotice(null);
      setMicError(null);
      const userId = uid();
      setMessages((m) => [...m, { id: userId, role: "user", text: q }]);
      setDraft("");
      setPhase("thinking");
      try {
        const data = await api.chat(q, lang, lastSchemeId);
        const id = uid();
        setMessages((m) => [...m, { id, role: "assistant", data }]);
        if (server === "offline") checkHealth();
        if (viaVoice) speakMsg(id, data);
      } catch (e) {
        const offline = e instanceof ApiError && e.status === 0;
        if (offline) setServer("offline");
        setMessages((m) => [...m, { id: uid(), role: "error", text: offline ? t.offlineHelp : (e as ApiError).message || t.errGeneric, retry: q, userId }]);
      } finally {
        setPhase("idle");
      }
    },
    [phase, lang, lastSchemeId, server, speech, speakMsg, checkHealth, t],
  );

  const onRecorded = useCallback(
    async (blob: Blob) => {
      setPhase("transcribing");
      try {
        const res = await api.transcribe(blob, lang);
        if (!res.transcript) {
          setMicError(t.errEmptyAudio);
          setPhase("idle");
          return;
        }
        setTranscript(res.transcript);
        setPhase("review");
        setTimeout(() => reviewRef.current?.focus(), 50);
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 0) setServer("offline");
        if (err.status === 503) checkHealth();
        setMicError(err.status === 0 ? t.offlineHelp : err.message || t.errGeneric);
        setPhase("idle");
      }
    },
    [lang, t, checkHealth],
  );
  const recorder = useRecorder(onRecorded);
  const micErrorText: Record<MicError, string> = { denied: t.errMicDenied, missing: t.errMicMissing, unsupported: t.errMicUnsupported, generic: t.errGeneric };
  const browserStt = useBrowserRecognition((text, err) => {
    if (err) setMicError(micErrorText[err]);
    else if (!text) setMicError(t.errEmptyAudio);
    if (err || !text) return setPhase("idle");
    setTranscript(text);
    setPhase("review");
    setTimeout(() => reviewRef.current?.focus(), 50);
  });
  // Whisper on our server when it is up (better for accents); otherwise the browser's recognizer (Vercel-only hosting).
  const voiceMode: "whisper" | "browser" | "none" = server === "ready" ? "whisper" : browserStt.supported ? "browser" : "none";

  const startRecording = async () => {
    speech.stop();
    setMicError(null);
    setNotice(null);
    const err = voiceMode === "whisper" ? await recorder.start() : browserStt.start(lang);
    if (err) setMicError(micErrorText[err]);
    else setPhase("recording");
  };
  const stopRecording = () => (voiceMode === "whisper" ? recorder.stop() : browserStt.stop());
  const cancelVoice = () => {
    recorder.cancel();
    browserStt.cancel();
    setTranscript("");
    setPhase("idle");
  };
  const clearChat = () => {
    speech.stop();
    setMessages([]);
    setNotice(null);
    setMicError(null);
  };

  const voiceAvailable = voiceMode !== "none";
  const micDisabled = phase === "thinking" || phase === "transcribing";
  const onMic = () => {
    if (speech.speakingId) return speech.stop();
    if (phase === "recording") return stopRecording();
    startRecording();
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <Header t={t} lang={lang} setLang={setLang} server={server === "offline" || server === "checking" || !voiceAvailable ? server : "ready"} onRetry={checkHealth} onClear={messages.length ? clearChat : undefined} />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pb-40 pt-4">
        <p role="note" className="flex items-start gap-2 rounded-2xl border border-saffron/30 bg-saffron-soft px-4 py-3 text-sm text-[#7a4510]">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t.demoBanner}
        </p>

        {messages.length === 0 ? (
          <Hero t={t} phase={phase} speaking={!!speech.speakingId} voiceAvailable={voiceAvailable} disabled={micDisabled} onMic={onMic} onAsk={ask} micError={micError} />
        ) : (
          <section aria-label="Conversation" aria-live="polite" className="mt-5 space-y-4">
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="animate-rise flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-line rounded-3xl rounded-br-md bg-brand px-4 py-3 text-white shadow-sm">{m.text}</p>
                </div>
              ) : m.role === "error" ? (
                <div key={m.id} role="alert" className="animate-rise flex max-w-[92%] items-start gap-3 rounded-3xl rounded-bl-md border border-red-200 bg-red-50 p-4 text-red-900">
                  {m.text === t.offlineHelp ? <WifiOff className="mt-0.5 size-5 shrink-0" aria-hidden /> : <AlertCircle className="mt-0.5 size-5 shrink-0" aria-hidden />}
                  <div className="space-y-2">
                    <p>{m.text}</p>
                    <button onClick={() => { setMessages((all) => all.filter((x) => x.id !== m.id && x.id !== m.userId)); ask(m.retry); }} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-red-200 hover:bg-red-100">
                      <RefreshCw className="size-4" aria-hidden /> {t.retry}
                    </button>
                  </div>
                </div>
              ) : (
                <AssistantCard
                  key={m.id}
                  msg={m}
                  t={t}
                  speaking={speech.speakingId === m.id}
                  onSpeak={() => (speech.speakingId === m.id ? speech.stop() : speakMsg(m.id, m.data))}
                  onAsk={ask}
                  onFeedback={(helpful) => {
                    api.feedback(helpful, m.data.intent, m.data.scheme?.id);
                    setMessages((all) => all.map((x) => (x.id === m.id ? { ...x, feedback: helpful } : x)));
                  }}
                />
              ),
            )}
            {phase === "thinking" && (
              <div className="flex items-center gap-3 text-muted" role="status">
                <span className="flex gap-1 rounded-3xl rounded-bl-md bg-white px-4 py-3 ring-1 ring-black/5">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="size-2 animate-bounce rounded-full bg-brand/60" style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </span>
                <span className="text-sm">{t.thinking}</span>
              </div>
            )}
            {notice && <p className="flex items-start gap-2 rounded-2xl bg-sand px-4 py-3 text-sm text-muted" role="status"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />{notice}</p>}
            <p className="pt-2 text-center text-xs leading-relaxed text-muted">{t.disclaimer}</p>
          </section>
        )}
        <div ref={endRef} />
      </main>

      <Dock>
        {phase === "recording" ? (
          <div className="flex items-center gap-3" role="status" aria-label={t.listening}>
            <span className="relative flex size-3"><span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-75" /><span className="relative size-3 rounded-full bg-red-600" /></span>
            <div className="min-w-0 flex-1">
              {voiceMode === "whisper" ? (
                <>
                  <p className="font-medium">{t.listening} <span className="tabular-nums text-muted">0:{String(recorder.seconds).padStart(2, "0")}</span></p>
                  <Waveform analyser={recorder.analyser} />
                </>
              ) : (
                <>
                  <p className="font-medium">{t.listening}</p>
                  <p className="truncate text-sm text-muted">{browserStt.interim || "…"}</p>
                </>
              )}
            </div>
            <button onClick={cancelVoice} className="grid size-12 place-items-center rounded-full bg-sand text-ink hover:bg-black/10" aria-label={t.cancel} title={t.cancel}><X className="size-5" /></button>
            <button onClick={stopRecording} className="flex h-12 items-center gap-2 rounded-full bg-red-600 px-5 font-semibold text-white hover:bg-red-700"><Square className="size-4 fill-current" aria-hidden />{t.stop}</button>
          </div>
        ) : phase === "transcribing" ? (
          <div className="flex items-center gap-3 py-2" role="status"><Loader2 className="size-5 animate-spin text-brand" aria-hidden /><p className="font-medium">{t.transcribing}</p></div>
        ) : phase === "review" ? (
          <form onSubmit={(e) => { e.preventDefault(); const q = transcript; setTranscript(""); ask(q, true); }} className="space-y-3">
            <div>
              <label htmlFor="transcript" className="font-semibold">{t.reviewTitle}</label>
              <p className="text-sm text-muted">{t.reviewHint}</p>
            </div>
            <textarea id="transcript" ref={reviewRef} value={transcript} onChange={(e) => setTranscript(e.target.value)} rows={2} maxLength={1000}
              className="w-full resize-none rounded-2xl border border-black/10 bg-cream px-4 py-3 text-lg focus:border-brand focus:outline-none" />
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={!transcript.trim()} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-brand px-5 font-semibold text-white hover:bg-brand-dark disabled:opacity-40"><SendHorizontal className="size-5" aria-hidden />{t.sendQuestion}</button>
              <button type="button" onClick={() => { setTranscript(""); startRecording(); }} className="flex h-12 items-center gap-2 rounded-full bg-brand-soft px-4 font-medium text-brand hover:bg-brand/15"><RotateCcw className="size-4" aria-hidden />{t.recordAgain}</button>
              <button type="button" onClick={cancelVoice} className="grid size-12 place-items-center rounded-full bg-sand hover:bg-black/10" aria-label={t.cancel} title={t.cancel}><X className="size-5" /></button>
            </div>
          </form>
        ) : (
          <>
            {micError && messages.length > 0 && <p role="alert" className="mb-2 flex items-start gap-2 text-sm text-red-800"><MicOff className="mt-0.5 size-4 shrink-0" aria-hidden />{micError}</p>}
            <form onSubmit={(e) => { e.preventDefault(); ask(draft); }} className="flex items-center gap-2">
              <button type="button" onClick={onMic} disabled={micDisabled || (!voiceAvailable && !speech.speakingId)}
                className="grid size-12 shrink-0 place-items-center rounded-full bg-brand text-white shadow-sm hover:bg-brand-dark disabled:bg-black/20"
                aria-label={speech.speakingId ? t.stopListening : t.tapToSpeak} title={voiceAvailable ? t.tapToSpeak : t.voiceOff}>
                {speech.speakingId ? <Square className="size-4 fill-current" /> : voiceAvailable ? <Mic className="size-5" /> : <MicOff className="size-5" />}
              </button>
              <label htmlFor="question" className="sr-only">{t.placeholder}</label>
              <input id="question" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t.placeholder} maxLength={1000} autoComplete="off" enterKeyHint="send"
                className="h-12 min-w-0 flex-1 rounded-full border border-black/10 bg-cream px-5 text-base focus:border-brand focus:outline-none" />
              <button type="submit" disabled={!draft.trim() || phase === "thinking"} className="grid size-12 shrink-0 place-items-center rounded-full bg-saffron text-white hover:brightness-95 disabled:opacity-40" aria-label={t.send}>
                {phase === "thinking" ? <Loader2 className="size-5 animate-spin" /> : <SendHorizontal className="size-5" />}
              </button>
            </form>
          </>
        )}
      </Dock>
    </div>
  );
}

function Header({ t, lang, setLang, server, onRetry, onClear }: { t: Strings; lang: Lang; setLang: (l: Lang) => void; server: ServerState; onRetry: () => void; onClear?: () => void }) {
  const badge = {
    ready: { text: t.voiceReady, cls: "bg-emerald-50 text-emerald-800 ring-emerald-200", dot: "bg-emerald-500" },
    loading: { text: t.voiceLoading, cls: "bg-amber-50 text-amber-800 ring-amber-200", dot: "bg-amber-500 animate-pulse" },
    checking: { text: "…", cls: "bg-sand text-muted ring-black/5", dot: "bg-black/30 animate-pulse" },
    disabled: { text: t.voiceOff, cls: "bg-sand text-muted ring-black/5", dot: "bg-black/30" },
    error: { text: t.voiceOff, cls: "bg-sand text-muted ring-black/5", dot: "bg-black/30" },
    offline: { text: t.offline, cls: "bg-red-50 text-red-800 ring-red-200", dot: "bg-red-500" },
  }[server];
  return (
    <header className="sticky top-0 z-20 border-b border-black/5 bg-cream/90 backdrop-blur">
      <div className="mx-auto max-w-2xl space-y-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-10 rounded-xl" />
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-bold leading-tight tracking-tight">BhashaBuddy</h1>
            <p className="truncate text-xs text-muted">{t.tagline}</p>
          </div>
          <button onClick={server === "offline" ? onRetry : undefined} className={`inline-flex shrink-0 items-center gap-1.5 rounded-full p-2 text-xs font-medium ring-1 sm:px-2.5 sm:py-1 ${badge.cls}`} title={badge.text} aria-live="polite" tabIndex={server === "offline" ? 0 : -1}>
            <span className={`size-2 rounded-full ${badge.dot}`} aria-hidden />
            {/* Phones: dot only (the hero and mic button already say when voice is off). */}
            <span className="sr-only sm:not-sr-only">{badge.text}</span>
          </button>
          {onClear && (
            <button onClick={onClear} className="grid size-10 place-items-center rounded-full text-muted hover:bg-black/5" aria-label={t.clear} title={t.clear}>
              <Trash2 className="size-5" />
            </button>
          )}
        </div>
        <div role="radiogroup" aria-label="Language / భాష / भाषा" className="grid grid-cols-3 gap-1 rounded-full bg-sand p-1">
          {LANGS.map((l) => (
            <button key={l.code} role="radio" aria-checked={lang === l.code} onClick={() => setLang(l.code)}
              className={`h-10 rounded-full text-[15px] font-semibold transition ${lang === l.code ? "bg-white text-brand shadow-sm" : "text-muted hover:text-ink"}`}>
              {l.label}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function Hero({ t, phase, speaking, voiceAvailable, disabled, onMic, onAsk, micError }: { t: Strings; phase: Phase; speaking: boolean; voiceAvailable: boolean; disabled: boolean; onMic: () => void; onAsk: (q: string) => void; micError: string | null }) {
  const recording = phase === "recording";
  return (
    <div className="animate-rise">
      <section className="pb-6 pt-8 text-center">
        <h2 className="text-balance text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{t.headline}</h2>
        <p className="mx-auto mt-3 max-w-md text-pretty text-muted">{t.subtitle}</p>

        <div className="mt-8 flex flex-col items-center gap-3">
          <button onClick={onMic} disabled={disabled || (!voiceAvailable && !speaking && !recording)}
            aria-label={recording ? t.stop : t.tapToSpeak}
            className={`grid size-28 place-items-center rounded-full text-white shadow-lg transition active:scale-95 disabled:bg-black/20 disabled:shadow-none ${recording ? "animate-ring bg-red-600" : "bg-brand hover:bg-brand-dark"}`}>
            {phase === "transcribing" ? <Loader2 className="size-11 animate-spin" /> : recording || speaking ? <Square className="size-9 fill-current" /> : voiceAvailable ? <Mic className="size-12" strokeWidth={1.75} /> : <MicOff className="size-11" />}
          </button>
          <p className="font-semibold text-brand">{recording ? t.listening : phase === "transcribing" ? t.transcribing : voiceAvailable ? t.tapToSpeak : t.voiceOff}</p>
          <p className="text-sm text-muted">{t.orType} ↓</p>
          {micError && <p role="alert" className="flex max-w-sm items-start gap-2 rounded-2xl bg-red-50 px-4 py-3 text-left text-sm text-red-800 ring-1 ring-red-200"><MicOff className="mt-0.5 size-4 shrink-0" aria-hidden />{micError}</p>}
        </div>
      </section>

      <section aria-labelledby="try" className="mt-2">
        <h3 id="try" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted">{t.tryAsking}</h3>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {TOPICS.map(({ key, icon: Icon }) => (
            <button key={key} onClick={() => onAsk(t.topicQuestions[key])}
              className="group flex min-h-20 flex-col items-start gap-2 rounded-2xl bg-white p-3.5 text-left ring-1 ring-black/5 transition hover:-translate-y-0.5 hover:shadow-md hover:ring-brand/30">
              <span className="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand"><Icon className="size-5" aria-hidden /></span>
              <span className="text-[15px] font-medium leading-snug">{t.topics[key]}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-3xl bg-white p-5 ring-1 ring-black/5">
        <h3 className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-5 text-brand" aria-hidden />{t.trustTitle}</h3>
        <ul className="mt-3 space-y-2.5 text-sm text-muted">
          {[{ i: Lock, s: t.trust1 }, { i: MicOff, s: t.trust2 }, { i: Info, s: t.trust3 }].map(({ i: I, s }) => (
            <li key={s} className="flex items-start gap-2.5"><I className="mt-0.5 size-4 shrink-0 text-brand/70" aria-hidden />{s}</li>
          ))}
        </ul>
        <p className="mt-4 border-t border-black/5 pt-4 text-xs leading-relaxed text-muted">{t.disclaimer}</p>
      </section>
    </div>
  );
}

function AssistantCard({ msg, t, speaking, onSpeak, onAsk, onFeedback }: { msg: AssistantMsg; t: Strings; speaking: boolean; onSpeak: () => void; onAsk: (q: string) => void; onFeedback: (h: boolean) => void }) {
  const { data } = msg;
  const [copied, setCopied] = useState(false);
  // Source is shown as a link below, so drop the plain-text line from the body.
  const body = data.answer.split("\n").filter((l) => !/https?:\/\//.test(l)).join("\n").trim();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.answer);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: nothing useful to do */ }
  };
  return (
    <article className="animate-rise max-w-[95%] rounded-3xl rounded-bl-md bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5" lang={data.language}>
      {data.scheme && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand">{data.scheme.name}</span>
          <span className="rounded-full bg-saffron-soft px-2.5 py-1 text-xs font-medium text-[#7a4510]">{t.demoUnverified}</span>
        </div>
      )}
      <p className="whitespace-pre-line text-[16px] leading-relaxed">{body}</p>
      {/* With no verified URL, the answer text already ends with "Please verify through the official portal". */}
      {data.scheme?.official_source && (
        <p className="mt-3 text-sm">
          <a href={data.scheme.official_source} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-brand underline underline-offset-2">
            {t.source}: {new URL(data.scheme.official_source).hostname} <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-1 border-t border-black/5 pt-3">
        <Action onClick={onSpeak} label={speaking ? t.stopListening : t.listen} active={speaking}>{speaking ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-4" />}</Action>
        <Action onClick={copy} label={copied ? t.copied : t.copy}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Action>
        <span className="ml-auto flex gap-1">
          {msg.feedback === undefined ? (
            <>
              <IconAction onClick={() => onFeedback(true)} label={t.helpful}><ThumbsUp className="size-4" /></IconAction>
              <IconAction onClick={() => onFeedback(false)} label={t.notHelpful}><ThumbsDown className="size-4" /></IconAction>
            </>
          ) : (
            <span className="px-2 text-xs text-muted" role="status">{t.thanks}</span>
          )}
        </span>
      </div>
      {data.suggestions.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {data.suggestions.map((s) => (
            <button key={s} onClick={() => onAsk(s)} className="rounded-full border border-brand/25 bg-brand-soft/50 px-3.5 py-2 text-left text-sm font-medium text-brand hover:bg-brand-soft">
              {s}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

function Action({ onClick, label, active, children }: { onClick: () => void; label: string; active?: boolean; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium transition ${active ? "bg-brand text-white" : "text-muted hover:bg-black/5 hover:text-ink"}`}>
      {children}
      {label}
    </button>
  );
}

function IconAction({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className="grid size-9 place-items-center rounded-full text-muted hover:bg-black/5 hover:text-ink">
      {children}
    </button>
  );
}

function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-black/5 bg-white/95 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.15)] backdrop-blur">
      <div className="mx-auto max-w-2xl px-4">{children}</div>
    </div>
  );
}

function Waveform({ analyser }: { analyser: AnalyserNode | null }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const draw = () => {
      analyser.getByteFrequencyData(data);
      bars.current.forEach((el, i) => {
        if (el) el.style.transform = `scaleY(${Math.max(0.12, data[i + 1] / 255)})`;
      });
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser]);
  return (
    <div className="mt-1 flex h-6 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: 24 }, (_, i) => (
        <span key={i} ref={(el) => { bars.current[i] = el; }} className="h-full w-1 origin-center rounded-full bg-red-500/80 transition-transform duration-75" style={{ transform: "scaleY(0.12)" }} />
      ))}
    </div>
  );
}
