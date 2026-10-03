ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE public.areas DROP CONSTRAINT IF EXISTS areas_name_key;
DROP INDEX IF EXISTS public.areas_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS areas_name_language_key ON public.areas(name, language);
ALTER TABLE public.areas ADD CONSTRAINT areas_name_language_unique UNIQUE USING INDEX areas_name_language_key;
-- Old cached messages were per-neighborhood and lacked the facts paragraph; clear them so main-area messages regenerate.
DELETE FROM public.areas WHERE language = 'en';