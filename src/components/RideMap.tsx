import { useEffect, useRef, useState } from "react";

type LatLng = { lat: number; lng: number };
declare global {
  interface Window {
    google?: any;
    __petraMapsReady?: () => void;
  }
}

let loader: Promise<void> | null = null;
function loadMaps() {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.maps?.Map) return Promise.resolve();
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      window.__petraMapsReady = () => resolve();
      const key = import.meta.env["VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY"];
      const channel = import.meta.env["VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_TRACKING_ID"];
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&loading=async&callback=__petraMapsReady&channel=${channel}`;
      s.async = true;
      s.onerror = () => reject(new Error("Map failed to load"));
      document.head.appendChild(s);
    });
  }
  return loader;
}

const NAVY = "#00174B";
const CAR_SVG = `<svg xmlns='http://www.w3.org/2000/svg' width='44' height='44' viewBox='0 0 44 44'><circle cx='22' cy='22' r='20' fill='${NAVY}' stroke='white' stroke-width='3'/><path d='M13 25l2-6a3 3 0 0 1 3-2h8a3 3 0 0 1 3 2l2 6v5h-3v-2H16v2h-3z' fill='white'/><circle cx='17' cy='25' r='1.6' fill='${NAVY}'/><circle cx='27' cy='25' r='1.6' fill='${NAVY}'/></svg>`;

export function RideMap({
  route,
  car,
  pickup,
  dropoff,
}: {
  route: LatLng[] | null;
  car: LatLng | null;
  pickup: LatLng | null;
  dropoff: LatLng | null;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const layers = useRef<{ line?: any; car?: any; a?: any; b?: any }>({});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    loadMaps()
      .then(() => {
        if (!el.current || map.current) return;
        const g = window.google.maps;
        map.current = new g.Map(el.current, {
          center: { lat: 31.9539, lng: 35.9106 },
          zoom: 12,
          disableDefaultUI: true,
          zoomControl: true,
          clickableIcons: false,
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            { featureType: "transit", stylers: [{ visibility: "off" }] },
            { elementType: "geometry", stylers: [{ saturation: -100 }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#6B7280" }] },
            { featureType: "water", stylers: [{ color: "#E5E5EA" }] },
          ],
        });
        setReady(true);
      })
      .catch(() => setFailed(true));
  }, []);

  // endpoints + route
  useEffect(() => {
    if (!ready) return;
    const g = window.google.maps;
    const L = layers.current;
    L.line?.setMap(null);
    L.a?.setMap(null);
    L.b?.setMap(null);
    const dot = (fill: string) => ({
      path: g.SymbolPath.CIRCLE, scale: 8, fillColor: fill, fillOpacity: 1, strokeColor: NAVY, strokeWeight: 3,
    });
    if (pickup) L.a = new g.Marker({ map: map.current, position: pickup, icon: dot("#FFFFFF"), title: "Pickup" });
    if (dropoff) L.b = new g.Marker({ map: map.current, position: dropoff, icon: dot(NAVY), title: "Drop-off" });
    if (route && route.length) {
      L.line = new g.Polyline({ map: map.current, path: route, strokeColor: NAVY, strokeWeight: 6, strokeOpacity: 0.95 });
      const b = new g.LatLngBounds();
      route.forEach((p) => b.extend(p));
      map.current.fitBounds(b, { top: 60, bottom: 60, left: 40, right: 40 });
    } else if (pickup || dropoff) {
      map.current.panTo(pickup ?? dropoff);
    }
  }, [ready, route, pickup, dropoff]);

  useEffect(() => {
    if (!ready) return;
    const g = window.google.maps;
    const L = layers.current;
    if (!car) {
      L.car?.setMap(null);
      L.car = undefined;
      return;
    }
    if (!L.car) {
      L.car = new g.Marker({
        map: map.current,
        position: car,
        zIndex: 999,
        icon: {
          url: "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(CAR_SVG),
          scaledSize: new g.Size(44, 44),
          anchor: new g.Point(22, 22),
        },
      });
    } else L.car.setPosition(car);
  }, [ready, car]);

  return (
    <div className="relative h-full w-full bg-muted">
      <div ref={el} className="h-full w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          The map couldn't load. Refresh to try again.
        </div>
      )}
    </div>
  );
}
