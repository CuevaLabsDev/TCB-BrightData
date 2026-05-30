@AGENTS.md

## Claude Code notes

- Check memory at `/Users/cuevalabs/.claude/projects/-Users-cuevalabs-TCB-Bright-Data/memory/` for cross-session context on the Bright Data API recipe, cognee config, and scraper request shapes before adding new enrichment code.
- When the Vercel CLI is involved, use `vercel env pull` to sync env vars rather than editing `.env.local` manually.
- Before touching `supabase/schema.sql`, run `python -m pipeline.db ping` to confirm the live schema state matches the file.
