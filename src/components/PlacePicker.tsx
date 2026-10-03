import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { searchPlaces, resolvePlace } from "@/lib/petra.functions";

export type PickedPlace = { address: string; lat: number; lng: number };

export function PlacePicker({
  label,
  placeholder,
  dotClass,
  value,
  onPick,
  disabled,
}: {
  label: string;
  placeholder: string;
  dotClass: string;
  value: PickedPlace | null;
  onPick: (p: PickedPlace | null) => void;
  disabled?: boolean;
}) {
  const search = useServerFn(searchPlaces);
  const resolve = useServerFn(resolvePlace);
  const [text, setText] = useState(value?.address ?? "");
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<{ placeId: string; main: string; secondary: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string>("");
  const reqId = useRef(0);

  useEffect(() => {
    if (!open || text.trim().length < 2) {
      setItems([]);
      return;
    }
    if (!token.current) token.current = crypto.randomUUID();
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const res = await search({ data: { input: text.trim(), sessionToken: token.current } });
        if (id === reqId.current) {
          setItems(res);
          setError(null);
        }
      } catch {
        if (id === reqId.current) setError("Couldn't load suggestions");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [text, open, search]);

  async function choose(item: { placeId: string; main: string }) {
    setOpen(false);
    setText(item.main);
    try {
      const p = await resolve({ data: { placeId: item.placeId, sessionToken: token.current || undefined } });
      token.current = "";
      setText(item.main);
      onPick({ ...p, address: p.address || item.main });
    } catch {
      setError("Couldn't load that place");
    }
  }

  return (
    <div className="relative">
      <label className="flex items-center gap-3 rounded-xl bg-muted px-4 py-3 focus-within:ring-2 focus-within:ring-ring">
        <span className={dotClass} aria-hidden />
        <span className="flex-1">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</span>
          <input
            className="w-full bg-transparent text-[15px] font-semibold text-foreground outline-none placeholder:font-medium placeholder:text-muted-foreground"
            placeholder={placeholder}
            value={text}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
              if (value) onPick(null);
            }}
          />
        </span>
      </label>
      {open && (items.length > 0 || error) && (
        <ul className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-border bg-popover shadow-card">
          {error && <li className="px-4 py-3 text-sm text-muted-foreground">{error}</li>}
          {items.map((it) => (
            <li key={it.placeId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(it)}
                className="block w-full px-4 py-3 text-left hover:bg-muted"
              >
                <span className="block text-sm font-semibold text-foreground">{it.main}</span>
                <span className="block truncate text-xs text-muted-foreground">{it.secondary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
