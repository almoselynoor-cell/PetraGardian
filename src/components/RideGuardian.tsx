import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { askGuardian, speakText, transcribeVoice } from "@/lib/petra.functions";
import { type Lang, t } from "@/lib/i18n";

type LatLng = { lat: number; lng: number };
type Msg = { role: "user" | "assistant"; content: string };

function blobToBase64(b: Blob) {
  return new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] ?? "");
    r.onerror = rej;
    r.readAsDataURL(b);
  });
}

export function RideGuardian({
  lang,
  tripId,
  getPosition,
}: {
  lang: Lang;
  tripId: string | null;
  getPosition: () => { position: LatLng | null; previous: LatLng | null };
}) {
  const ask = useServerFn(askGuardian);
  const stt = useServerFn(transcribeVoice);
  const tts = useServerFn(speakText);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const L = t(lang);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);
  useEffect(() => {
    setMsgs([]);
  }, [tripId]);

  async function play(text: string, idx: number) {
    audio.current?.pause();
    setSpeakingIdx(idx);
    try {
      const a = await tts({ data: { text } });
      const el = new Audio(`data:${a.mime};base64,${a.base64}`);
      audio.current = el;
      el.onended = () => setSpeakingIdx(null);
      await el.play();
    } catch (e) {
      setErr((e as Error).message);
      setSpeakingIdx(null);
    }
  }

  async function send(text: string, speak = false) {
    const q = text.trim();
    if (!q || busy) return;
    setErr(null);
    const next = [...msgs, { role: "user" as const, content: q }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const { position, previous } = getPosition();
      const r = await ask({ data: { lang, tripId, position, previous, messages: next.slice(-20) } });
      const all = [...next, { role: "assistant" as const, content: r.reply }];
      setMsgs(all);
      if (speak) play(r.reply, all.length - 1);
    } catch (e) {
      setErr((e as Error).message || L.guardianError);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function toggleMic() {
    if (recording) {
      rec.current?.stop();
      return;
    }
    setErr(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: "audio/webm" });
        if (!blob.size) return;
        setBusy(true);
        try {
          const { text } = await stt({ data: { audio: await blobToBase64(blob), mime: "audio/webm", lang } });
          setBusy(false);
          if (text) await send(text, true);
          else setErr(L.noSpeech);
        } catch (e) {
          setErr((e as Error).message);
          setBusy(false);
        }
      };
      rec.current = r;
      r.start();
      setRecording(true);
    } catch {
      setErr(L.micDenied);
    }
  }

  const dir = lang === "ar" ? "rtl" : "ltr";

  return (
    <div className="flex h-full min-h-0 flex-col" dir={dir}>
      <div className="mb-3 rounded-xl bg-card p-4 shadow-card">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></svg>
          </div>
          <div>
            <div className="font-extrabold text-primary">Ride Guardian</div>
            <div className="text-xs text-muted-foreground">{L.guardianTag}</div>
          </div>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{L.guardianIntro}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-2">
        {msgs.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {L.suggestions.map((s) => (
              <button key={s} onClick={() => send(s)} className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-primary hover:bg-background">
                {s}
              </button>
            ))}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ms-auto max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground">{m.content}</div>
          ) : (
            <div key={i} className="max-w-[92%] text-sm leading-relaxed text-foreground">
              <p className="whitespace-pre-line">{m.content}</p>
              <button onClick={() => play(m.content, i)} disabled={speakingIdx === i} className="mt-1 text-xs font-semibold text-primary underline-offset-2 hover:underline disabled:text-muted-foreground">
                {speakingIdx === i ? L.playing : L.listen}
              </button>
            </div>
          ),
        )}
        {busy && <div className="text-xs font-medium text-muted-foreground">{recording ? "" : L.thinking}</div>}
        {err && <p className="rounded-xl bg-card px-3 py-2 text-xs text-foreground">{err}</p>}
        <div ref={endRef} />
      </div>

      <div className="mt-2 flex items-end gap-2 rounded-2xl border border-border bg-card p-2">
        <textarea
          ref={inputRef}
          autoFocus
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          placeholder={recording ? L.recording : L.askPlaceholder}
          className="max-h-28 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <button
          onClick={toggleMic}
          disabled={busy && !recording}
          aria-label={recording ? L.stopRecording : L.voice}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${recording ? "animate-pulse bg-primary text-primary-foreground" : "bg-muted text-primary"} disabled:opacity-50`}
        >
          {recording ? (
            <span className="h-3 w-3 rounded-sm bg-primary-foreground" />
          ) : (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
          )}
        </button>
        <button
          onClick={() => send(input)}
          disabled={busy || !input.trim()}
          aria-label={L.send}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:bg-muted disabled:text-muted-foreground"
        >
          <svg viewBox="0 0 24 24" className={`h-5 w-5 ${dir === "rtl" ? "-scale-x-100" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
      </div>
    </div>
  );
}
