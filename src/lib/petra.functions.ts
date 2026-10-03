import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const lang = z.enum(["en", "ar"]);
const point = z.object({ lat: z.number().min(29).max(33.5), lng: z.number().min(34.8).max(39.5) });

export const searchPlaces = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ input: z.string().min(2).max(120), sessionToken: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { autocomplete } = await import("./petra.server");
    return autocomplete(data.input, data.sessionToken);
  });

export const resolvePlace = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ placeId: z.string().min(1).max(300), sessionToken: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data }) => {
    const { placeDetails } = await import("./petra.server");
    return placeDetails(data.placeId, data.sessionToken);
  });

export const startTrip = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      pickup: point.extend({ address: z.string().min(1).max(300) }),
      dropoff: point.extend({ address: z.string().min(1).max(300) }),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { computeRoute, decodePolyline } = await import("./petra.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const route = await computeRoute(data.pickup, data.dropoff);
    const { data: trip, error } = await supabaseAdmin
      .from("trips")
      .insert({
        pickup_address: data.pickup.address,
        pickup_lat: data.pickup.lat,
        pickup_lng: data.pickup.lng,
        dropoff_address: data.dropoff.address,
        dropoff_lat: data.dropoff.lat,
        dropoff_lng: data.dropoff.lng,
        route_polyline: route.polyline,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return {
      tripId: trip.id,
      coordinates: decodePolyline(route.polyline),
      durationSec: route.durationSec,
      distanceMeters: route.distanceMeters,
    };
  });

export const tickTrip = createServerFn({ method: "POST" })
  .inputValidator((d) => point.extend({ tripId: z.string().uuid(), final: z.boolean().optional(), lang: lang.default("en") }).parse(d))
  .handler(async ({ data }) => {
    const { reverseGeocodeArea, runAreaAgent } = await import("./petra.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin;

    if (data.final) await db.from("trips").update({ status: "completed" }).eq("id", data.tripId);

    const areaName = await reverseGeocodeArea(data.lat, data.lng);
    if (!areaName) return { changed: false as const };

    const { data: last } = await db
      .from("trip_events")
      .select("area_name, sequence_index")
      .eq("trip_id", data.tripId)
      .order("sequence_index", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last?.area_name === areaName) return { changed: false as const };
    // Don't re-announce an area this trip already covered (routes can zig-zag across borders).
    const { count } = await db
      .from("trip_events")
      .select("id", { count: "exact", head: true })
      .eq("trip_id", data.tripId)
      .eq("area_name", areaName);
    if ((count ?? 0) > 0) return { changed: false as const };

    let message: string;
    let cached = false;
    const { data: area } = await db.from("areas").select("final_message").eq("name", areaName).eq("language", data.lang).maybeSingle();
    if (area?.final_message) {
      cached = true;
      message = area.final_message;
      console.log(`[tick] cache hit for area "${areaName}"`);
    } else {
      console.log(`[tick] cache miss for area "${areaName}" — running agent`);
      const result = await runAreaAgent(areaName, data.lat, data.lng, data.lang);
      message = result.message;
      const bg = result.background;
      await db.from("areas").upsert(
        {
          name: areaName,
          language: data.lang,
          lat: data.lat,
          lng: data.lng,
          general_info: bg?.found ? bg.summary : null,
          historical_facts: bg?.found ? `Source: ${bg.url ?? "Wikipedia"}` : null,
          nearby_places: result.nearby,
          final_message: message,
          last_updated: new Date().toISOString(),
        },
        { onConflict: "name,language" },
      );
    }

    const seq = (last?.sequence_index ?? -1) + 1;
    const { data: ev, error } = await db
      .from("trip_events")
      .insert({ trip_id: data.tripId, area_name: areaName, message, sequence_index: seq })
      .select("id, area_name, message, sequence_index, sent_at")
      .single();
    if (error) throw new Error(error.message);
    return { changed: true as const, cached, event: ev };
  });

export const getTripEvents = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ tripId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows, error } = await supabaseAdmin
      .from("trip_events")
      .select("id, area_name, message, sequence_index, sent_at")
      .eq("trip_id", data.tripId)
      .order("sequence_index");
    if (error) throw new Error(error.message);
    return rows;
  });

export const askGuardian = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      lang,
      tripId: z.string().uuid().nullable(),
      position: point.nullable(),
      previous: point.nullable(),
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(2000) })).min(1).max(30),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { runGuardian, decodePolyline } = await import("./petra.server");
    let trip: any = null;
    if (data.tripId) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: t } = await supabaseAdmin.from("trips").select("*").eq("id", data.tripId).maybeSingle();
      trip = t;
    }
    const reply = await runGuardian({
      lang: data.lang,
      messages: data.messages,
      position: trip ? data.position : null,
      previous: data.previous,
      pickupAddress: trip?.pickup_address ?? null,
      destination: trip ? { lat: trip.dropoff_lat, lng: trip.dropoff_lng, address: trip.dropoff_address } : null,
      route: trip?.route_polyline ? decodePolyline(trip.route_polyline) : [],
    });
    return { reply };
  });

export const transcribeVoice = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ audio: z.string().min(10).max(14_000_000), mime: z.string().max(100), lang }).parse(d))
  .handler(async ({ data }) => {
    const { transcribeAudio } = await import("./petra.server");
    return { text: await transcribeAudio(data.audio, data.mime, data.lang) };
  });

export const speakText = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ text: z.string().min(1).max(3000) }).parse(d))
  .handler(async ({ data }) => {
    const { synthesizeSpeech } = await import("./petra.server");
    return synthesizeSpeech(data.text);
  });

// Returns the cached message for an already-visited area in another language, generating it from real data if needed.
export const localizeArea = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ areaName: z.string().min(1).max(200), lang }).parse(d))
  .handler(async ({ data }) => {
    const { runAreaAgent } = await import("./petra.server");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const { data: hit } = await db.from("areas").select("final_message").eq("name", data.areaName).eq("language", data.lang).maybeSingle();
    if (hit?.final_message) return { message: hit.final_message };
    const { data: any } = await db.from("areas").select("lat, lng").eq("name", data.areaName).limit(1).maybeSingle();
    if (!any) return { message: null };
    const result = await runAreaAgent(data.areaName, any.lat, any.lng, data.lang);
    const bg = result.background;
    await db.from("areas").upsert(
      {
        name: data.areaName, language: data.lang, lat: any.lat, lng: any.lng,
        general_info: bg?.found ? bg.summary : null,
        historical_facts: bg?.found ? `Source: ${bg.url ?? "Wikipedia"}` : null,
        nearby_places: result.nearby, final_message: result.message, last_updated: new Date().toISOString(),
      },
      { onConflict: "name,language" },
    );
    return { message: result.message };
  });
