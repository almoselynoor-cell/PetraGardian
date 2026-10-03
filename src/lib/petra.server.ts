// Server-only helpers: Google Maps (via connector gateway), Wikipedia, Claude agent loop.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_maps";
const AI_URL = "https://ai.gateway.lovable.dev/v1/messages";
const MODEL = "anthropic/claude-sonnet-5";

function mapsHeaders(extra: Record<string, string> = {}) {
  const lovable = process.env["LOVABLE_API_KEY"];
  const maps = process.env["GOOGLE_MAPS_API_KEY"];
  if (!lovable || !maps) throw new Error("Missing Google Maps connector credentials");
  return {
    Authorization: `Bearer ${lovable}`,
    "X-Connection-Api-Key": maps,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function mapsFetch(path: string, init: RequestInit & { fieldMask?: string } = {}) {
  const headers = mapsHeaders(init.fieldMask ? { "X-Goog-FieldMask": init.fieldMask } : {});
  const res = await fetch(`${GATEWAY_URL}/${path}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[maps] ${path} failed [${res.status}]: ${body}`);
    throw new Error(`Google Maps request failed [${res.status}]`);
  }
  return res.json();
}

// ---------- Places autocomplete / details ----------
export async function autocomplete(input: string, sessionToken: string) {
  const data = await mapsFetch("places/v1/places:autocomplete", {
    method: "POST",
    fieldMask:
      "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text",
    body: JSON.stringify({
      input,
      sessionToken,
      includedRegionCodes: ["jo"],
      languageCode: "en",
      locationBias: { circle: { center: { latitude: 31.95, longitude: 35.91 }, radius: 50000 } },
    }),
  });
  return ((data.suggestions ?? []) as any[])
    .filter((s) => s.placePrediction)
    .map((s) => ({
      placeId: s.placePrediction.placeId as string,
      main: s.placePrediction.structuredFormat?.mainText?.text ?? "",
      secondary: s.placePrediction.structuredFormat?.secondaryText?.text ?? "",
    }));
}

export async function placeDetails(placeId: string, sessionToken?: string) {
  const qs = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
  const data = await mapsFetch(`places/v1/places/${encodeURIComponent(placeId)}${qs}`, {
    method: "GET",
    fieldMask: "id,displayName,formattedAddress,location",
  });
  return {
    address: `${data.displayName?.text ?? ""}${data.formattedAddress ? ", " + data.formattedAddress : ""}`,
    lat: data.location.latitude as number,
    lng: data.location.longitude as number,
  };
}

// ---------- Routes ----------
export async function computeRoute(o: { lat: number; lng: number }, d: { lat: number; lng: number }) {
  const data = await mapsFetch("routes/directions/v2:computeRoutes", {
    method: "POST",
    fieldMask: "routes.polyline.encodedPolyline,routes.duration,routes.distanceMeters",
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: o.lat, longitude: o.lng } } },
      destination: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
      travelMode: "DRIVE",
    }),
  });
  const r = data.routes?.[0];
  if (!r?.polyline?.encodedPolyline) throw new Error("No drivable route found between these locations");
  return {
    polyline: r.polyline.encodedPolyline as string,
    durationSec: parseInt(String(r.duration ?? "0").replace("s", ""), 10),
    distanceMeters: r.distanceMeters as number,
  };
}

export function decodePolyline(str: string) {
  const pts: { lat: number; lng: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let b, shift = 0, result = 0;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta; else lng += delta;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

export function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000, toR = (x: number) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Reverse geocoding ----------
export async function reverseGeocodeArea(lat: number, lng: number): Promise<string | null> {
  // Main area only (e.g. Abu Nseir, Al Jubeiha, Sweileh) — never the small neighborhood inside it.
  // Ask Google only for area results that CONTAIN this exact point, in order of preference, so a
  // neighbouring district near the road is never picked up.
  for (const type of ["sublocality_level_1", "locality"]) {
    const data = await mapsFetch(`maps/api/geocode/json?latlng=${lat},${lng}&language=en&result_type=${type}`, { method: "GET" });
    const r = ((data.results ?? []) as any[])[0];
    const c = (r?.address_components ?? []).find((x: any) => x.types?.includes(type));
    if (c?.long_name) return c.long_name as string;
  }
  return null;
}

// ---------- Tools ----------
const CATEGORY_TYPE: Record<string, string> = {
  hospital: "hospital",
  pharmacy: "pharmacy",
  bus_stop: "bus_stop",
  mosque: "mosque",
};

export async function getNearbyPlaces(lat: number, lng: number, category: string) {
  const type = CATEGORY_TYPE[category];
  if (!type) return { category, results: [], note: "unknown category" };
  const data = await mapsFetch("places/v1/places:searchNearby", {
    method: "POST",
    fieldMask: "places.displayName,places.shortFormattedAddress,places.location",
    body: JSON.stringify({
      includedTypes: [type],
      maxResultCount: 2,
      rankPreference: "DISTANCE",
      languageCode: "en",
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 3000 } },
    }),
  });
  const results = ((data.places ?? []) as any[]).map((p) => ({
    name: p.displayName?.text,
    vicinity: p.shortFormattedAddress ?? null,
    distance_m: Math.round(haversine({ lat, lng }, { lat: p.location.latitude, lng: p.location.longitude })),
  }));
  return results.length ? { category, results } : { category, results: [], note: "no verified place found nearby" };
}

const WIKI_HEADERS = { "User-Agent": "PetraRide/1.0 (safety companion MVP)", Accept: "application/json" };
const JORDAN_RE = /jordan|amman|zarqa|irbid|aqaba|balqa|madaba|karak|jerash|salt|mafraq|ma'an|الأردن|عمان|عمّان|الزرقاء|إربد|البلقاء/i;
const norm = (s: string) => s.toLowerCase().replace(/^(al|el|umm?|tla'?)[-\s]/, "").replace(/[^a-z\u0600-\u06ff]/g, "");

async function wikiSummary(host: string, title: string) {
  const res = await fetch(`https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, { headers: WIKI_HEADERS });
  if (!res.ok) return null;
  const j: any = await res.json();
  if (j.type === "disambiguation" || !j.extract) return null;
  if (!JORDAN_RE.test(`${j.extract} ${j.description ?? ""}`)) return null;
  return { found: true, title: j.title as string, summary: j.extract as string, url: (j.content_urls?.desktop?.page ?? null) as string | null };
}

export async function getAreaBackground(areaName: string) {
  // 1) Direct Jordan-qualified titles; only accept articles that are actually about Jordan.
  for (const title of [`${areaName}, Jordan`, `${areaName}, Amman`, areaName]) {
    const s = await wikiSummary("en.wikipedia.org", title);
    if (s) return s;
  }
  // 2) Wikipedia search (spelling variants like Al-Jubeiha / Abu Nsair); the title must match the area name.
  const key = norm(areaName).slice(0, 5);
  for (const host of ["en.wikipedia.org", "ar.wikipedia.org"]) {
    try {
      const q = host.startsWith("ar") ? `${areaName} عمان الأردن` : `${areaName} Amman Jordan`;
      const r = await fetch(`https://${host}/w/api.php?action=query&list=search&format=json&srlimit=4&srsearch=${encodeURIComponent(q)}`, { headers: WIKI_HEADERS });
      if (!r.ok) continue;
      const hits = ((await r.json())?.query?.search ?? []) as { title: string }[];
      for (const h of hits) {
        if (host.startsWith("en") && key && !norm(h.title).includes(key)) continue;
        const s = await wikiSummary(host, h.title);
        if (s) return s;
      }
    } catch {
      /* try next source */
    }
  }
  return { found: false, result: "no article found" };
}

// ---------- Agent (Claude via native Messages, streamed) ----------
export const LANGUAGES: Record<string, string> = {
  en: "English", ar: "Arabic",
};

function areaSystem(lang: string) {
  return `You are a local guide for PetraRide, a ride-hailing app in Jordan. You will be given the name of the MAIN area (district) the car is passing through and its coordinates. You MUST call get_area_background once and get_nearby_places once per category (hospital, pharmacy, bus_stop, mosque) before writing anything. Using ONLY the real data these tools return, write a rider-facing message about the area as a whole with this structure:
1. A first line naming the area (in the output language).
2. One paragraph (3-5 sentences) with the most important facts about the area and its historical value if the article mentions any, drawn only from get_area_background. If no article was found, skip this paragraph entirely rather than inventing anything, and do not mention that it is missing.
3. A short line like "Nearby essentials:" then a compact list of the closest hospital/medical center, pharmacy, bus stop, and mosque, using only names and distances actually returned by the tool, each on its own line starting with "- ". Omit any category the tool found nothing for — never write a placeholder name. If every category is empty, say honestly that no verified landmark was found nearby.
Write the ENTIRE message in ${LANGUAGES[lang] ?? "English"}. Place names may be transliterated naturally. Keep the tone warm and reassuring, suitable for both Jordanian locals and tourists. Output plain text only: no markdown, no asterisks, no emoji.`;
}

const TOOLS = [
  {
    name: "get_area_background",
    description: "Fetch the real Wikipedia summary for an area/place name in Jordan. Returns found:false if no article exists.",
    input_schema: { type: "object", properties: { area_name: { type: "string" } }, required: ["area_name"] },
  },
  {
    name: "get_nearby_places",
    description: "Find up to 2 real nearby places of a category around a coordinate using Google Places.",
    input_schema: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        category: { type: "string", enum: ["hospital", "pharmacy", "bus_stop", "mosque"] },
      },
      required: ["lat", "lng", "category"],
    },
  },
];

type Block = any;

async function callClaude(messages: any[], system: string, tools: any[]): Promise<{ content: Block[]; stop_reason: string }> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      Authorization: `Bearer ${key}`,
      "anthropic-version": "2023-06-01",
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools, messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text();
    console.error(`[agent] AI gateway failed [${res.status}]: ${body}`);
    throw new Error(`AI request failed [${res.status}]`);
  }
  const content: Block[] = [];
  const partialJson: Record<number, string> = {};
  let stop_reason = "end_turn";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const ev = JSON.parse(payload);
      if (ev.type === "content_block_start") {
        content[ev.index] = { ...ev.content_block };
        if (ev.content_block.type === "tool_use") partialJson[ev.index] = "";
      } else if (ev.type === "content_block_delta") {
        const b: any = content[ev.index];
        if (ev.delta.type === "text_delta") b.text = (b.text ?? "") + ev.delta.text;
        else if (ev.delta.type === "input_json_delta") partialJson[ev.index] += ev.delta.partial_json;
        else if (ev.delta.type === "thinking_delta") b.thinking = (b.thinking ?? "") + ev.delta.thinking;
        else if (ev.delta.type === "signature_delta") b.signature = ev.delta.signature;
      } else if (ev.type === "content_block_stop") {
        const b: any = content[ev.index];
        if (b?.type === "tool_use") b.input = partialJson[ev.index] ? JSON.parse(partialJson[ev.index]!) : {};
      } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
        stop_reason = ev.delta.stop_reason;
      } else if (ev.type === "error") {
        throw new Error(`AI stream error: ${JSON.stringify(ev.error)}`);
      }
    }
  }
  return { content: content.filter(Boolean), stop_reason };
}

export async function runAreaAgent(areaName: string, lat: number, lng: number, lang = "en") {
  const messages: any[] = [
    { role: "user", content: `Area name: ${areaName}\nCoordinates: lat ${lat}, lng ${lng}` },
  ];
  let background: any = null;
  const nearby: Record<string, any> = {};
  for (let step = 0; step < 12; step++) {
    const { content, stop_reason } = await callClaude(messages, areaSystem(lang), TOOLS);
    messages.push({ role: "assistant", content });
    if (stop_reason !== "tool_use") {
      const text = content.filter((b) => b.type === "text").map((b) => b["text"]).join("").replace(/\*\*|__|^#+\s*/gm, "").trim();
      return { message: text || "No verified landmark found nearby.", background, nearby };
    }
    const results = [];
    for (const b of content.filter((b) => b.type === "tool_use")) {
      console.log(`[agent] tool_use ${b.name} ${JSON.stringify(b.input)}`);
      let out: any;
      try {
        out = b.name === "get_area_background"
          ? await getAreaBackground(String(b.input.area_name))
          : await getNearbyPlaces(Number(b.input.lat), Number(b.input.lng), String(b.input.category));
      } catch (e) {
        out = { error: (e as Error).message };
      }
      if (b.name === "get_area_background") background = out;
      else nearby[b.input.category] = out;
      console.log(`[agent] tool_result ${b.name} ${JSON.stringify(out).slice(0, 500)}`);
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Agent did not finish");
}

// ---------- Ride Guardian (chat about the current ride) ----------
type P = { lat: number; lng: number };

function distToRoute(p: P, route: P[]) {
  let best = Infinity, idx = 0;
  route.forEach((q, i) => { const d = haversine(p, q); if (d < best) { best = d; idx = i; } });
  let remaining = 0;
  for (let i = idx; i < route.length - 1; i++) remaining += haversine(route[i]!, route[i + 1]!);
  return { offBy: Math.round(best), remaining: Math.round(remaining) };
}

export async function describeLocation(lat: number, lng: number, lang: string) {
  const data = await mapsFetch(`maps/api/geocode/json?latlng=${lat},${lng}&language=${lang}`, { method: "GET" });
  const r = (data.results ?? [])[0];
  const area = await reverseGeocodeArea(lat, lng);
  return { address: r?.formatted_address ?? null, main_area: area };
}

export async function findNearest(lat: number, lng: number, query: string, lang: string) {
  const data = await mapsFetch("places/v1/places:searchText", {
    method: "POST",
    fieldMask: "places.displayName,places.shortFormattedAddress,places.location",
    body: JSON.stringify({
      textQuery: query,
      languageCode: lang,
      rankPreference: "DISTANCE",
      maxResultCount: 3,
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 5000 } },
    }),
  });
  const results = ((data.places ?? []) as any[]).map((p) => ({
    name: p.displayName?.text,
    address: p.shortFormattedAddress ?? null,
    distance_m: Math.round(haversine({ lat, lng }, { lat: p.location.latitude, lng: p.location.longitude })),
  })).sort((a, b) => a.distance_m - b.distance_m);
  return results.length ? { query, results } : { query, results: [], note: "nothing verified found nearby" };
}

export async function checkRoute(ctx: { position: P; previous: P | null; destination: P & { address: string }; route: P[] }) {
  const now = distToRoute(ctx.position, ctx.route);
  const onRoute = now.offBy <= 150;
  const out: any = {
    on_planned_route: onRoute,
    meters_from_planned_route: now.offBy,
    remaining_planned_km: +(now.remaining / 1000).toFixed(1),
    destination: ctx.destination.address,
  };
  if (!onRoute) {
    const fresh = await computeRoute(ctx.position, ctx.destination);
    out.fresh_route_from_here = { km: +(fresh.distanceMeters / 1000).toFixed(1), minutes: Math.round(fresh.durationSec / 60) };
    if (ctx.previous) {
      const before = haversine(ctx.previous, ctx.destination), after = haversine(ctx.position, ctx.destination);
      out.moving_toward_destination = after < before;
    }
  }
  return out;
}

const GUARDIAN_TOOLS = [
  { name: "where_am_i", description: "Real current street address and main area of the car (Google reverse geocoding).", input_schema: { type: "object", properties: {}, required: [] } },
  {
    name: "find_nearest_place",
    description: "Find the real nearest places matching a search like 'pharmacy', 'ATM', 'hospital', 'police station', 'gas station' around the car's current position (Google Places).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  { name: "check_route", description: "Check whether the car is on the planned route to the destination, how far is left, and, if it has left the route, whether it is still heading toward the destination.", input_schema: { type: "object", properties: {}, required: [] } },
];

export async function runGuardian(ctx: {
  lang: string;
  messages: { role: "user" | "assistant"; content: string }[];
  position: P | null;
  previous: P | null;
  destination: (P & { address: string }) | null;
  pickupAddress: string | null;
  route: P[];
}) {
  const langName = LANGUAGES[ctx.lang] ?? "English";
  const system = `You are "Ride Guardian", the in-ride safety assistant of PetraRide, a ride-hailing app in Jordan. You help the rider with anything about their CURRENT ride: where they are, the nearest places of any kind, whether the road leads to their destination, time and distance left, and general reassurance.
Rules:
- Always use your tools for facts about location, places, and the route. Never invent names, addresses, distances or times.
- If the rider feels the road is unfamiliar: call check_route. If the car is on the planned route (or off it but moving toward the destination), calmly reassure them that the road does lead to their destination and say how much is left. If the car has left the route and is NOT moving toward the destination, clearly but calmly warn them, suggest they politely ask the driver, and remind them they can share their trip or call 911 (Jordan emergency) if they feel unsafe.
- If no ride is in progress, say so and help with general questions only.
- Politely decline questions unrelated to the ride.
- Reply in ${langName} only, even if the rider writes in another language. Keep replies short (2-5 sentences), warm and calm, plain text without markdown, since replies may be read aloud.
Ride context: ${ctx.position ? `ride in progress. Pickup: ${ctx.pickupAddress}. Destination: ${ctx.destination?.address}.` : "no ride in progress."}`;
  const messages: any[] = ctx.messages.map((m) => ({ role: m.role, content: m.content }));
  for (let step = 0; step < 8; step++) {
    const { content, stop_reason } = await callClaude(messages, system, GUARDIAN_TOOLS);
    messages.push({ role: "assistant", content });
    if (stop_reason !== "tool_use") {
      return content.filter((b) => b.type === "text").map((b) => b["text"]).join("").replace(/\*\*|__|^#+\s*/gm, "").trim();
    }
    const results = [];
    for (const b of content.filter((b) => b.type === "tool_use")) {
      console.log(`[guardian] tool_use ${b.name} ${JSON.stringify(b.input)}`);
      let out: any;
      try {
        if (!ctx.position) out = { error: "no ride in progress, GPS position unknown" };
        else if (b.name === "where_am_i") out = await describeLocation(ctx.position.lat, ctx.position.lng, ctx.lang);
        else if (b.name === "find_nearest_place") out = await findNearest(ctx.position.lat, ctx.position.lng, String(b.input.query), ctx.lang);
        else out = ctx.destination ? await checkRoute({ position: ctx.position, previous: ctx.previous, destination: ctx.destination, route: ctx.route }) : { error: "no destination" };
      } catch (e) {
        out = { error: (e as Error).message };
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("Guardian did not finish");
}

// ---------- Voice ----------
const AIG = "https://ai.gateway.lovable.dev/v1";

export async function transcribeAudio(base64: string, mime: string, lang: string) {
  const key = process.env["LOVABLE_API_KEY"]!;
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > 10_000_000) throw new Error("Voice message is empty or too long");
  const form = new FormData();
  form.append("model", "google/gemini-3.5-transcribe");
  form.append("file", new Blob([bytes], { type: mime.startsWith("audio/") ? mime : "audio/webm" }), "voice.webm");
  form.append("response_format", "json");
  form.append("language", lang);
  const res = await fetch(`${AIG}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) {
    console.error(`[stt] failed [${res.status}]: ${await res.text()}`);
    throw new Error(res.status === 402 ? "AI credits are used up." : "Couldn't understand the voice message");
  }
  const j: any = await res.json();
  return String(j.text ?? "").trim();
}

export async function synthesizeSpeech(text: string) {
  const key = process.env["LOVABLE_API_KEY"]!;
  const res = await fetch(`${AIG}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-3.1-flash-tts-preview",
      contents: [{ role: "user", parts: [{ text: `Say calmly and warmly: ${text}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } } },
      stream_format: "audio",
    }),
  });
  if (!res.ok) {
    console.error(`[tts] failed [${res.status}]: ${await res.text()}`);
    throw new Error("Couldn't play the answer aloud");
  }
  return { mime: res.headers.get("content-type") ?? "audio/wav", base64: Buffer.from(await res.arrayBuffer()).toString("base64") };
}
