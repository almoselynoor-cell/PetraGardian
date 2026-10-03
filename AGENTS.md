<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- All Google Maps (Routes, Geocoding, Places) and Claude calls live in src/lib/petra.server.ts and are reached only via src/lib/petra.functions.ts — keeps keys server-side.
- DB tables areas/trips/trip_events have RLS on with no policies; only server functions (admin client) touch them — the app has no user accounts.
