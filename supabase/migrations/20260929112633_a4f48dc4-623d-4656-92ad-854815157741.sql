CREATE TABLE public.areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  general_info text,
  historical_facts text,
  nearby_places jsonb,
  final_message text,
  last_updated timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pickup_address text NOT NULL,
  pickup_lat double precision NOT NULL,
  pickup_lng double precision NOT NULL,
  dropoff_address text NOT NULL,
  dropoff_lat double precision NOT NULL,
  dropoff_lng double precision NOT NULL,
  route_polyline text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.trip_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  area_name text NOT NULL,
  message text NOT NULL,
  sequence_index integer NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_events_trip_idx ON public.trip_events(trip_id, sequence_index);
GRANT ALL ON public.areas TO service_role;
GRANT ALL ON public.trips TO service_role;
GRANT ALL ON public.trip_events TO service_role;
ALTER TABLE public.areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trip_events ENABLE ROW LEVEL SECURITY;