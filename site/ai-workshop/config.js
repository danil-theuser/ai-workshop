// Fill these in from Supabase → Project Settings → API (or "API Keys").
// The anon / publishable key is SAFE to put on a public website — it only
// allows what the database security rules allow. NEVER put your Anthropic
// key or the service_role key here.
export const SUPABASE_URL = "https://gtfnixhoaiknlcwsfrrl.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd0Zm5peGhvYWlrbmxjd3NmcnJsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwMDcxNzQsImV4cCI6MjEwOTU4MzE3NH0.Q_XmIrNlM4S10BcEn9ELe8A_tczhpQGlfivvtsXI5dY";

export const EVENT_NAME = "AI Workshop";
export const EVENT_TAGLINE = "One input. One shot. Build the best product.";

// Keep in sync with the SQL migration and the edge function.
export const ALLOWED_DOMAINS = ["usfca.edu", "dons.usfca.edu", "cs.usfca.edu"];

// Where the "← Events" link in the header goes (your main events page).
export const EVENTS_HOME_URL = "https://compsigh.club/events";
