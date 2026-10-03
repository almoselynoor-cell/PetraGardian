import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { PlacePicker, type PickedPlace } from "@/components/PlacePicker";
import { RideMap } from "@/components/RideMap";
import { RideGuardian } from "@/components/RideGuardian";
import { startTrip, tickTrip, localizeArea } from "@/lib/petra.functions";
import { LANG_OPTIONS, type Lang, t } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PetraRide — Safety Companion for rides in Jordan" },
      { name: "description", content: "Pick a pickup and drop-off in Jordan and get verified safety info for each neighborhood as your car drives the real route." },
      { property: "og:title", content: "PetraRide — Safety Companion for rides in Jordan" },
      { property: "og:description", content: "Verified hospitals, pharmacies, bus stops and mosques for every neighborhood along your ride." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: RiderScreen,
});

type LatLng = { lat: number; lng: number };
type TripEvent = { id: string; area_name: string; message: string; sequence_index: number; sent_at: string };
type Phase = "idle" | "starting" | "riding" | "arrived";

const STEP_MS = 2500;
const STEP_METERS = 250;

function dist(a: LatLng, b: LatLng) {
  const R = 6371000, r = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Pick real route vertices roughly every STEP_METERS along the polyline (never invented points).
function sampleRoute(pts: LatLng[]) {
  if (pts.length < 2) return pts;
  const out: LatLng[] = [pts[0]!];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1]!, pts[i]!);
    if (acc >= STEP_METERS) {
      out.push(pts[i]!);
      acc = 0;
    }
  }
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]!);
  return out;
}

function RiderScreen() {
  const start = useServerFn(startTrip);
  const tick = useServerFn(tickTrip);
  const [pickup, setPickup] = useState<PickedPlace | null>(null);
  const [dropoff, setDropoff] = useState<PickedPlace | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [route, setRoute] = useState<LatLng[] | null>(null);
  const [car, setCar] = useState<LatLng | null>(null);
  const [events, setEvents] = useState<TripEvent[]>([]);
  const [sheet, setSheet] = useState<TripEvent | null>(null);
  const [meta, setMeta] = useState<{ km: number; min: number } | null>(null);
  const [progress, setProgress] = useState(0);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef(false);
  const [lang, setLang] = useState<Lang>("en");
  const langRef = useRef<Lang>("en");
  langRef.current = lang;
  const [tripId, setTripId] = useState<string | null>(null);
  const [tab, setTab] = useState<"timeline" | "guardian">("timeline");
  const pos = useRef<{ position: LatLng | null; previous: LatLng | null; at: number }>({ position: null, previous: null, at: 0 });
  useEffect(() => {
    if (!car) return;
    const p = pos.current, now = Date.now();
    if (!p.position || now - p.at > 5000) { p.previous = p.position; p.at = now; }
    p.position = car;
  }, [car]);
  const L = t(lang);
  const localize = useServerFn(localizeArea);
  const eventsRef = useRef<TripEvent[]>([]);
  eventsRef.current = events;
  const [translating, setTranslating] = useState(false);

  useEffect(() => () => { cancel.current = true; }, []);

  // When the rider switches language, rewrite every past area message in that language too.
  useEffect(() => {
    const names = [...new Set(eventsRef.current.map((e) => e.area_name))];
    if (!names.length) return;
    let alive = true;
    setTranslating(true);
    (async () => {
      for (const name of names) {
        try {
          const r = await localize({ data: { areaName: name, lang } });
          if (!alive || !r.message) continue;
          const msg = r.message;
          setEvents((ev) => ev.map((e) => (e.area_name === name ? { ...e, message: msg } : e)));
          setSheet((s) => (s && s.area_name === name ? { ...s, message: msg } : s));
        } catch (e) {
          console.error(e);
        }
      }
      if (alive) setTranslating(false);
    })();
    return () => {
      alive = false;
      setTranslating(false);
    };
  }, [lang, localize]);

  async function begin() {
    if (!pickup || !dropoff) return;
    setError(null);
    setPhase("starting");
    setEvents([]);
    setSheet(null);
    try {
      const res = await start({ data: { pickup, dropoff } });
      setRoute(res.coordinates);
      setMeta({ km: res.distanceMeters / 1000, min: Math.round(res.durationSec / 60) });
      setTripId(res.tripId);
      setPhase("riding");
      run(res.tripId, sampleRoute(res.coordinates));
    } catch (e) {
      setError((e as Error).message || "Couldn't start the ride");
      setPhase("idle");
    }
  }

  function run(tripId: string, steps: LatLng[]) {
    cancel.current = false;
    // Sequential tick queue so no area is skipped while the guide is researching.
    const queue: { p: LatLng; final: boolean }[] = [];
    let draining = false;
    let finishedAnim = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      while (queue.length && !cancel.current) {
        const { p, final } = queue.shift()!;
        setChecking(true);
        try {
          const r = await tick({ data: { tripId, lat: p.lat, lng: p.lng, final, lang: langRef.current } });
          if (r.changed) {
            setEvents((ev) => [...ev, r.event]);
            setSheet(r.event);
          }
        } catch (e) {
          console.error(e);
        }
      }
      setChecking(false);
      draining = false;
      if (finishedAnim) setPhase("arrived");
    };

    let i = 0;
    const segStart = { t: performance.now() };
    setCar(steps[0]!);
    queue.push({ p: steps[0]!, final: steps.length === 1 });
    drain();

    const frame = (now: number) => {
      if (cancel.current) return;
      const k = Math.min(1, (now - segStart.t) / STEP_MS);
      const a = steps[i]!, b = steps[i + 1];
      if (b) setCar({ lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k });
      setProgress((i + k) / Math.max(1, steps.length - 1));
      if (k >= 1) {
        i++;
        segStart.t = now;
        const final = i >= steps.length - 1;
        queue.push({ p: steps[i]!, final });
        drain();
        if (final) {
          finishedAnim = true;
          if (!draining) setPhase("arrived");
          return;
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function reset() {
    cancel.current = true;
    setPhase("idle");
    setRoute(null);
    setCar(null);
    setEvents([]);
    setSheet(null);
    setMeta(null);
    setProgress(0);
    setTripId(null);
    pos.current = { position: null, previous: null, at: 0 };
  }

  const onTrip = phase === "riding" || phase === "arrived";

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex items-center justify-between bg-primary px-5 py-4 text-primary-foreground">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-foreground text-sm font-extrabold text-primary">P</div>
          <div className="leading-tight">
            <div className="text-lg font-extrabold tracking-tight">PetraRide</div>
            <div className="text-[11px] font-medium opacity-70">Safety Companion</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor="lang">{L.messagesLang}</label>
        <select id="lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="rounded-full border border-primary-foreground/30 bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground outline-none">
          {LANG_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        </select>
        {onTrip && (
          <span className="rounded-full border border-primary-foreground/30 px-3 py-1 text-xs font-semibold">
            {phase === "riding" ? "Trip in progress" : "Arrived"}
          </span>
        )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="relative min-h-[45vh] flex-1">
          <RideMap route={route} car={car} pickup={pickup} dropoff={dropoff} />
          {sheet && (
            <div key={sheet.id} className="animate-sheet-in absolute inset-x-3 bottom-3 z-20 mx-auto max-w-lg rounded-2xl bg-card p-5 shadow-sheet">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-border" />
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Now passing through</p>
                  <h2 className="text-xl font-extrabold tracking-tight text-primary">{sheet.area_name}</h2>
                </div>
                <button onClick={() => setSheet(null)} className="rounded-full bg-muted px-3 py-1 text-xs font-semibold text-muted-foreground hover:text-foreground">
                  Close
                </button>
              </div>
              <p dir="auto" className="mt-3 max-h-48 overflow-y-auto whitespace-pre-line text-sm leading-relaxed text-foreground">{sheet.message}</p>
            </div>
          )}
        </section>

        <aside className="flex w-full flex-col border-border bg-background lg:w-[420px] lg:border-l">
          <div className="space-y-3 p-5">
            {!onTrip && (
              <h1 className="pb-1 text-2xl font-extrabold tracking-tight text-primary">Where to?</h1>
            )}
            <div className="relative space-y-2">
              <PlacePicker label="Pickup location" placeholder="e.g. Abu Nseir" dotClass="h-3 w-3 rounded-full border-[3px] border-primary bg-background" value={pickup} onPick={setPickup} disabled={phase !== "idle"} />
              <PlacePicker label="Drop-off location" placeholder="e.g. Mecca Mall" dotClass="h-3 w-3 rounded-sm bg-primary" value={dropoff} onPick={setDropoff} disabled={phase !== "idle"} />
            </div>
            {error && <p className="rounded-xl bg-muted px-4 py-3 text-sm font-medium text-foreground">{error}</p>}
            {phase === "idle" || phase === "starting" ? (
              <button
                onClick={begin}
                disabled={!pickup || !dropoff || phase === "starting"}
                className="w-full rounded-xl bg-primary py-4 text-base font-bold text-primary-foreground transition hover:opacity-90 disabled:bg-muted disabled:text-muted-foreground"
              >
                {phase === "starting" ? "Finding your route…" : "Start Ride"}
              </button>
            ) : (
              <div className="rounded-xl bg-muted p-4">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-bold text-primary">
                    {phase === "arrived" ? "You've arrived" : `${Math.max(0, Math.round((meta?.min ?? 0) * (1 - progress)))} min to destination`}
                  </span>
                  <span className="text-xs font-medium text-muted-foreground">{meta?.km.toFixed(1)} km</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-border">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress * 100}%` }} />
                </div>
                {phase === "arrived" && (
                  <button onClick={reset} className="mt-4 w-full rounded-xl bg-primary py-3 text-sm font-bold text-primary-foreground hover:opacity-90">
                    Plan another ride
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-1 border-t border-border bg-muted px-5 pt-3">
            {(["timeline", "guardian"] as const).map((k) => (
              <button key={k} onClick={() => setTab(k)} className={`rounded-t-lg px-4 py-2 text-xs font-extrabold uppercase tracking-wider ${tab === k ? "bg-background text-primary" : "text-muted-foreground hover:text-primary"}`}>
                {k === "timeline" ? L.timeline : L.guardianTab}
              </button>
            ))}
          </div>
          {tab === "guardian" ? (
            <div className="flex min-h-[420px] flex-1 flex-col bg-background px-5 py-4 lg:min-h-0">
              <RideGuardian lang={lang} tripId={tripId} getPosition={() => ({ position: pos.current.position, previous: pos.current.previous })} />
            </div>
          ) : (
          <div className="min-h-0 flex-1 overflow-y-auto bg-background px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <span />
              {checking && <span className="text-xs font-medium text-muted-foreground">Checking area…</span>}
            </div>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {onTrip ? "Area updates will appear here as you ride." : "Pick your pickup and drop-off, then start the ride. You'll get verified info about each neighborhood you pass."}
              </p>
            ) : (
              <ol className="relative space-y-3 border-l-2 border-border pl-5">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[27px] top-4 h-3 w-3 rounded-full border-2 border-muted bg-primary" />
                    <button onClick={() => setSheet(e)} className="w-full rounded-xl bg-card p-4 text-left shadow-card">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-bold text-primary">{e.area_name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {new Date(e.sent_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                      <p dir="auto" className="mt-1 line-clamp-2 text-xs text-muted-foreground">{e.message}</p>
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          )}
        </aside>
      </main>
    </div>
  );
}
