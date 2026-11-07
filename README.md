# AI Workshop — One-Shot Build Challenge

Participants sign in with a USF email, pick a username, practice as much as they want, then submit **one** final input. Claude turns each final into a working web product that gets its own page. The dashboard shows everyone's products.

```
GitHub Pages (your events site)            Supabase (free tier OK to start)
┌──────────────────────────────┐           ┌───────────────────────────────────┐
│ /ai-workshop/  (static site) │ ─login──▶ │ Auth: email code, USF-only        │
│  • sign in + username        │ ─read───▶ │ Database: profiles, runs, settings│
│  • practice + final submit   │ ─upload─▶ │ Storage: reference files          │
│  • dashboard + user pages    │ ─POST───▶ │ Edge function "generate"          │──▶ Claude API
└──────────────────────────────┘           │   (holds ANTHROPIC_API_KEY)       │   (your key)
                                           └───────────────────────────────────┘
```

GitHub Pages only serves static files, so it can't keep a secret. That's why the Anthropic key is stored in Supabase and only the edge function uses it. The browser never sees it.

## What's in here

| Path | What it is |
|---|---|
| `site/ai-workshop/` | The website. Copy this folder into your GitHub Pages repo. |
| `site/ai-workshop/config.js` | The only file you edit on the site side (Supabase URL + anon key). |
| `supabase/migrations/0001_init.sql` | Database tables, security rules, USF-only signup, file bucket. |
| `supabase/functions/generate/index.ts` | Server function that calls Claude with your key. The competition system prompt is at the top. |

---

## Fast setup (one command, ~5 minutes)

```bash
./setup.sh
```
It asks for a Supabase access token (supabase.com/dashboard/account/tokens), your Anthropic key and, optionally, SMTP details. Then it creates or uses a project and runs the SQL, configures email-code sign-in, stores the key as a secret, deploys the function and fills in `config.js`. Last, it runs an end-to-end smoke test: a gmail account is rejected, a USF account can sign in and upload a file, and Claude generates a run that gets saved. You can run it again at any time; `./setup.sh --test` runs only the smoke test. After that, do step 5 below (publish the site).

The manual steps below do the same thing by hand.

## Setup (about 30–45 minutes)

### 1. Anthropic API key
1. Go to **console.anthropic.com → Settings → API Keys** and create a key named `ai-workshop`.
2. **Billing → Limits:** set a spend limit for the event. Add credits if needed.
3. Keep the key handy for step 4. Don't paste it into any website file or into chat.

### 2. Supabase project
1. Create a project at **supabase.com** (the free plan is fine for setup; see the *Time limits* note below).
2. **SQL Editor → New query →** paste all of `supabase/migrations/0001_init.sql` **→ Run.**
3. **Project Settings → API:** copy the **Project URL** and the **anon / publishable key**. They go into `config.js` in step 5.

### 3. Email sign-in (important)
1. **Authentication → Sign In / Providers → Email:** make sure it's enabled.
2. **Authentication → Emails → Templates:** in **both** "Magic Link" and "Confirm signup", replace the body with something like:
   ```html
   <h2>Your AI Workshop sign-in code</h2>
   <p>Enter this code on the site: <strong>{{ .Token }}</strong></p>
   ```
   The site uses a code you type in, not a link, so it works on any device.
3. **Authentication → Emails → SMTP Settings → enable custom SMTP.** ⚠️ Supabase's built-in email sender only allows a few emails per hour, which isn't enough for a room of people. Any SMTP provider works:
   - **Resend** (free tier, needs a domain you control; your GoDaddy domain works here), or
   - **Gmail / Google Workspace SMTP** with an app password (`smtp.gmail.com`, port 465).
   Then raise **Authentication → Rate Limits → emails per hour** (e.g. 200).
4. **Authentication → URL Configuration → Site URL:** set it to your workshop page, e.g. `https://YOUR-ORG.github.io/ai-workshop/`.

Only `@usfca.edu`, `@dons.usfca.edu` and `@cs.usfca.edu` accounts can be created. The database itself rejects any other domain, so it can't be bypassed from the browser.

### 4. Deploy the Claude function
Install the Supabase CLI (`brew install supabase/tap/supabase`, or `npx supabase ...`), then from this folder run:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...your-key...
supabase functions deploy generate --no-verify-jwt
```
(`--no-verify-jwt` is intentional: the function checks the user's login itself, and this lets the browser's CORS preflight through.)

### 5. Put the site on your GitHub Pages events site
1. Edit `site/ai-workshop/config.js` → paste `SUPABASE_URL` and `SUPABASE_ANON_KEY`. Adjust `EVENT_NAME`, and set `EVENTS_HOME_URL` to your events page.
2. Copy the whole `site/ai-workshop/` folder into your Pages repo, e.g. `events/ai-workshop/` or `ai-workshop/`.
3. On your events page, add the entry link:
   ```html
   <a class="event-card" href="ai-workshop/">AI Workshop: One-Shot Build Challenge →</a>
   ```
4. Commit and push. It's live at `https://YOUR-ORG.github.io/<path>/ai-workshop/`.

**Custom domain (optional):** to serve it from your GoDaddy domain, add a `CNAME` file with e.g. `events.yourdomain.com` in the Pages repo, and in GoDaddy DNS add a **CNAME** record `events → YOUR-ORG.github.io`. Then update the Site URL in step 3.4.

---

## Running the event

All controls are in **Supabase → Table Editor → `settings`** (one row):

| Column | Default | Meaning |
|---|---|---|
| `final_open` | `true` | Set `false` to close final submissions at the deadline. |
| `test_limit` | `25` | Practice runs per person. `0` = unlimited. |
| `model` | `claude-sonnet-5-5` | Model used for every run. `claude-haiku-5-5` is faster and cheaper; `claude-opus-5-5` is strongest and slowest. |
| `max_tokens` | `16000` | Maximum size of each generated product. |
| `chat_limit` | `20` | Max messages in a final chat, including the first. `0` = unlimited. |

Other things you can do:
- **Final chats:** each final is a chat. The first message builds the product; follow-ups revise it, and the latest version is what everyone sees. Inputs and outputs are counted (failed generations don't count) and shown on the dashboard, the Inputs & outputs page and each person's page. 1 input · 1 output is a one-shot; any number above 1 is red. The messages are in the `chat_turns` table.
- **Let someone resubmit:** in `runs`, set their final's `status` to `error` (this starts their chat over).
- **Change the rules of the game:** edit `SYSTEM_PROMPT` at the top of `supabase/functions/generate/index.ts` and redeploy.
- **Watch spend:** Anthropic Console → Usage. Each run's token counts are also in the `runs` table.

### Time limits (read before the event)
Generating a full product can take 1–3 minutes. Supabase limits how long a function may run: **150 s on the free plan, 400 s on Pro**. If a run hits the limit, whatever was generated so far is saved and the run is marked as failed (so a failed final can be retried). For the event, either:
- upgrade the Supabase project to **Pro** for that month (recommended), or
- stay on Free and keep `max_tokens` around `10000`, or use `claude-haiku-5-5`.

### Cost estimate
Do one practice run, look at its `input_tokens` / `output_tokens` in the `runs` table, and multiply by (people × expected runs each). Check current per-token prices on Anthropic's pricing page, and keep the Console spend limit as a hard cap.

## Test checklist (do this a day early)
- [ ] Sign in with a `@dons.usfca.edu` address → receive code → pick username
- [ ] A `@gmail.com` address is rejected
- [ ] Practice run streams a live preview and finishes
- [ ] Practice run with an image + a PDF attached works
- [ ] Final → "Are you sure you want to submit?" → Yes → lands on `#/u/<username>`
- [ ] Final button is gone afterwards; dashboard shows the tile; "Open full screen" works
- [ ] Set `final_open = false` → the final box shows "closed"

## Security notes
- The Anthropic key exists only as a Supabase secret.
- Generated products run in a sandboxed iframe with no access to the site's login session.
- Practice runs are private (database row-level security). Finals and usernames are public. Emails are never shown.
- Reference files are stored in a public bucket under random paths so they can be shown on user pages and read by Claude. Tell participants not to upload anything private.
