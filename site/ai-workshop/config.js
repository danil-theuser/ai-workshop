// Fill these in from Supabase → Project Settings → API (or "API Keys").
// The anon / publishable key is SAFE to put on a public website — it only
// allows what the database security rules allow. NEVER put your Anthropic
// key or the service_role key here.
export const SUPABASE_URL = "https://YOUR-PROJECT-REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR-SUPABASE-ANON-OR-PUBLISHABLE-KEY";

export const EVENT_NAME = "AI Workshop";
export const EVENT_TAGLINE = "One input. One shot. Build the best product.";

// Keep in sync with the SQL migration and the edge function.
export const ALLOWED_DOMAINS = ["usfca.edu", "dons.usfca.edu", "cs.usfca.edu"];

// Where the "← Events" link in the header goes (your main events page).
export const EVENTS_HOME_URL = "https://compsigh.club/events";
