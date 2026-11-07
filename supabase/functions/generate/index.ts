// =====================================================================
// AI Workshop — "generate" edge function
// Holds the Anthropic API key (as a Supabase secret) and is the ONLY
// place that calls Claude. The browser never sees the key.
//
// Request kinds:
//   test      private practice run (one message)
//   final     first message of the participant's final chat
//   followup  another message in the final chat (revises the latest output)
//
// Deploy:  supabase functions deploy generate --no-verify-jwt
// Secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
// (JWT is verified inside this function, so --no-verify-jwt is safe and
//  lets the browser's CORS preflight through.)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_DOMAINS = ["usfca.edu", "dons.usfca.edu", "cs.usfca.edu"];
const MAX_PROMPT_CHARS = 8000;
const MAX_ATTACHMENTS = 5;
const MAX_TEXT_FILE_CHARS = 100_000;
const STALE_MINUTES = 10;

// The instructions every generation gets. Edit freely to change the
// "rules of the game" for the competition.
const SYSTEM_PROMPT = `You are an elite product designer and front-end engineer taking part in a one-shot build challenge.
The participant gets exactly ONE brief. Turn their brief (and any reference files they attached) into a complete, polished, working product.

Output rules — follow exactly:
- Return ONE self-contained HTML document and nothing else: start with <!DOCTYPE html> and end with </html>. No explanations, no markdown fences.
- Put all CSS in <style> and all JavaScript in <script> inside the document.
- You may load libraries only from https://cdn.jsdelivr.net, https://unpkg.com or https://cdnjs.cloudflare.com, and fonts from https://fonts.googleapis.com.
- The page runs in a sandboxed iframe: do NOT use localStorage, sessionStorage, cookies, IndexedDB or any backend/API that needs a key. Keep state in memory and use realistic sample data.
- Do not hotlink external images; use inline SVG, CSS, emoji or canvas for visuals.
- It must be responsive, accessible, visually distinctive, and every visible button or control should actually do something.
- Interpret the brief ambitiously but stay faithful to it. If something is ambiguous, make a confident, sensible choice.
- If the participant sends follow-up messages, apply them to the LATEST version of the page and return the complete updated HTML document (never a diff or a fragment). Keep everything they didn't ask to change.`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};

type Attachment = { name: string; path: string; url: string; mime: string };
type Turn = { id: string; n: number; prompt: string; attachments: Attachment[]; output_html: string | null; status: string };

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const now = () => new Date().toISOString();

// Runs in flight in this worker, so we can record a failure (and keep the
// partial output) if the platform shuts the worker down (wall-clock limit).
const active = new Map<string, (message: string) => unknown>();
addEventListener("beforeunload", () => {
  for (const fail of active.values()) fail("Generation was stopped by the server time limit before it finished.");
});

function extractHtml(raw: string): string {
  let t = raw.trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)(?:```|$)/i);
  if (fence && !/^<!doctype|^<html/i.test(t)) t = fence[1].trim();
  const start = t.search(/<!doctype html|<html/i);
  if (start > 0) t = t.slice(start);
  const end = t.toLowerCase().lastIndexOf("</html>");
  if (end >= 0) t = t.slice(0, end + 7);
  return t;
}

/** Storage paths → attachment records (or null if a type isn't allowed). */
function toAttachments(paths: string[]): Attachment[] | null {
  const list = paths.map((path) => {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const mime = MIME_BY_EXT[ext];
    const name = path.split("/").pop()!.replace(/^\d+-/, "");
    const url = admin.storage.from("references").getPublicUrl(path).data.publicUrl;
    return { name, path, url, mime };
  });
  return list.some((a) => !a.mime) ? null : list;
}

/** Attachment records → Claude content blocks. Throws on unreadable files. */
async function attachmentBlocks(attachments: Attachment[]): Promise<unknown[]> {
  const blocks: unknown[] = [];
  for (const a of attachments) {
    if (a.mime.startsWith("image/")) {
      blocks.push({ type: "image", source: { type: "url", url: a.url } });
    } else if (a.mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "url", url: a.url }, title: a.name });
    } else {
      const r = await fetch(a.url);
      if (!r.ok) throw new Error(`Couldn't read ${a.name}.`);
      const text = (await r.text()).slice(0, MAX_TEXT_FILE_CHARS);
      blocks.push({ type: "document", source: { type: "text", media_type: "text/plain", data: text }, title: a.name });
    }
  }
  return blocks;
}

async function userMessage(attachments: Attachment[], text: string) {
  return {
    role: "user",
    content: [
      ...(await attachmentBlocks(attachments)),
      { type: "text", text: `${attachments.length ? "The files above are my references.\n\n" : ""}${text}` },
    ],
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "Server is missing ANTHROPIC_API_KEY." }, 500);

    // ---- who is calling? ------------------------------------------------
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: authErr } = await admin.auth.getUser(jwt);
    if (authErr || !user) return json({ error: "Please sign in again." }, 401);

    const domain = (user.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    if (!ALLOWED_DOMAINS.includes(domain)) return json({ error: "USF email required." }, 403);

    const { data: profile } = await admin.from("profiles").select("id, username").eq("id", user.id).maybeSingle();
    if (!profile) return json({ error: "Choose a username first." }, 400);

    // ---- validate input -------------------------------------------------
    const body = await req.json().catch(() => ({}));
    const kind = ["test", "final", "followup"].includes(body.kind) ? body.kind as "test" | "final" | "followup" : null;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const paths: string[] = Array.isArray(body.attachments) ? body.attachments : [];

    if (!kind) return json({ error: "Invalid request." }, 400);
    if (!prompt) return json({ error: "Write your input first." }, 400);
    if (prompt.length > MAX_PROMPT_CHARS) return json({ error: `Input is too long (max ${MAX_PROMPT_CHARS} characters).` }, 400);
    if (paths.length > MAX_ATTACHMENTS) return json({ error: `Attach at most ${MAX_ATTACHMENTS} files.` }, 400);
    for (const p of paths) {
      if (typeof p !== "string" || !p.startsWith(`${user.id}/`) || p.includes("..")) {
        return json({ error: "Invalid attachment." }, 400);
      }
    }
    const attachments = toAttachments(paths);
    if (!attachments) return json({ error: "Unsupported file type." }, 400);

    const { data: settings } = await admin.from("settings").select("*").eq("id", 1).single();
    const model = settings?.model ?? "claude-sonnet-5-5";
    const maxTokens = settings?.max_tokens ?? 16000;

    // Clean up generations that died without finishing (so they don't block anyone)
    const staleBefore = new Date(Date.now() - STALE_MINUTES * 60_000).toISOString();
    const timedOut = { status: "error", error: "Generation timed out.", finished_at: now() };
    await admin.from("runs").update(timedOut).eq("user_id", user.id).eq("status", "generating").lt("created_at", staleBefore);
    await admin.from("chat_turns").update(timedOut).eq("user_id", user.id).eq("status", "generating").lt("created_at", staleBefore);

    // One generation at a time per person
    const [{ count: runningRuns }, { count: runningTurns }] = await Promise.all([
      admin.from("runs").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "generating"),
      admin.from("chat_turns").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "generating"),
    ]);
    if ((runningRuns ?? 0) + (runningTurns ?? 0) > 0) {
      return json({ error: "You already have a generation running — wait for it to finish." }, 429);
    }

    // ---- rules per kind + the conversation to send ----------------------
    let messages: unknown[];
    let finalRun: { id: string } | null = null;
    let turnNumber = 1;

    if (kind === "test") {
      const limit = settings?.test_limit ?? 25;
      if (limit > 0) {
        const { count } = await admin.from("runs").select("id", { count: "exact", head: true })
          .eq("user_id", user.id).eq("kind", "test");
        if ((count ?? 0) >= limit) return json({ error: `You've used all ${limit} practice runs.` }, 429);
      }
      messages = [await userMessage(attachments, `My brief:\n${prompt}`)];
    } else if (kind === "final") {
      if (settings && !settings.final_open) return json({ error: "Final submissions are closed." }, 403);
      const { count } = await admin.from("runs").select("id", { count: "exact", head: true })
        .eq("user_id", user.id).eq("kind", "final").neq("status", "error");
      if ((count ?? 0) > 0) return json({ error: "You have already submitted your final. Use the chat to refine it." }, 409);
      messages = [await userMessage(attachments, `My brief:\n${prompt}`)];
    } else {
      if (settings && !settings.final_open) return json({ error: "Final submissions are closed, so the chat is locked." }, 403);
      const { data: fin } = await admin.from("runs").select("id, status").eq("user_id", user.id)
        .eq("kind", "final").neq("status", "error").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!fin) return json({ error: "Submit your final first." }, 400);
      if (fin.status !== "done") return json({ error: "Wait for your first output to finish." }, 409);
      finalRun = fin;

      const { data: turns } = await admin.from("chat_turns")
        .select("id, n, prompt, attachments, output_html, status").eq("run_id", fin.id).order("n");
      const all = (turns ?? []) as Turn[];
      const counted = all.filter((t) => t.status !== "error").length;
      const chatLimit = settings?.chat_limit ?? 20;
      if (chatLimit > 0 && counted >= chatLimit) return json({ error: `This chat has reached its limit of ${chatLimit} messages.` }, 429);
      turnNumber = Math.max(0, ...all.map((t) => t.n)) + 1;

      // History: every successful turn. Only the latest output is sent in
      // full; earlier versions are replaced by a short note to save tokens.
      const done = all.filter((t) => t.status === "done" && t.output_html);
      if (!done.length) return json({ error: "Your final has no finished output yet." }, 409);
      messages = [];
      for (const [i, t] of done.entries()) {
        const text = i === 0 ? `My brief:\n${t.prompt}` : `Follow-up:\n${t.prompt}`;
        messages.push(await userMessage(t.attachments ?? [], text));
        messages.push({
          role: "assistant",
          content: i === done.length - 1 ? t.output_html : "[Earlier version of the page — replaced by the next version.]",
        });
      }
      messages.push(await userMessage(attachments,
        `Follow-up:\n${prompt}\n\nApply this to the latest version above and return the complete updated HTML document.`));
    }

    // ---- record the run / turn -------------------------------------------
    let runId: string;
    let turnId: string | null = null;

    if (kind === "followup") {
      runId = finalRun!.id;
      const { data: turn, error: tErr } = await admin.from("chat_turns").insert({
        run_id: runId, user_id: user.id, n: turnNumber, prompt, attachments, model, status: "generating",
      }).select("id").single();
      if (tErr || !turn) return json({ error: tErr?.code === "23505" ? "Another message is already being sent." : "Could not start the run." }, 409);
      turnId = turn.id;
    } else {
      // (the unique index is the final safety net against two finals)
      const { data: run, error: insErr } = await admin.from("runs").insert({
        user_id: user.id, kind, prompt, attachments, model, status: "generating",
      }).select("id").single();
      if (insErr || !run) {
        const dup = insErr?.code === "23505";
        return json({ error: dup ? "You have already submitted your final." : "Could not start the run." }, dup ? 409 : 500);
      }
      runId = run.id;
      if (kind === "final") {
        const { data: turn } = await admin.from("chat_turns").insert({
          run_id: runId, user_id: user.id, n: 1, prompt, attachments, model, status: "generating",
        }).select("id").single();
        turnId = turn?.id ?? null;
      }
    }

    // Where each outcome is saved
    const saveRun = (fields: Record<string, unknown>) => admin.from("runs").update(fields).eq("id", runId);
    const saveTurn = (fields: Record<string, unknown>) =>
      turnId ? admin.from("chat_turns").update(fields).eq("id", turnId) : Promise.resolve();

    const saveProgress = (html: string) => kind === "followup"
      ? saveTurn({ output_html: html })                       // keep showing the last finished version meanwhile
      : Promise.all([saveRun({ output_html: html }), saveTurn({ output_html: html })]);

    const saveDone = (html: string, inTok: number, outTok: number, warning: string | null) => {
      const result = { output_html: html, error: warning, finished_at: now() };
      const turnFields = { ...result, status: "done", input_tokens: inTok, output_tokens: outTok };
      if (kind === "followup") return Promise.all([saveTurn(turnFields), saveRun(result)]); // latest output = the product
      return Promise.all([saveRun({ ...turnFields }), saveTurn(turnFields)]);
    };

    const saveFailed = (html: string | null, message: string) => {
      const fields = { status: "error", output_html: html, error: message, finished_at: now() };
      if (kind === "followup") return saveTurn(fields);          // the product keeps its previous version
      return Promise.all([saveRun(fields), saveTurn(fields)]);
    };

    // ---- call Claude (streaming) ----------------------------------------
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: maxTokens, system: SYSTEM_PROMPT, stream: true, messages }),
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      console.error("Anthropic error", upstream.status, detail);
      let message = `Claude API error (${upstream.status}).`;
      try { message = JSON.parse(detail).error?.message ?? message; } catch { /* keep default */ }
      await saveFailed(null, message);
      return json({ error: message, runId, turnId }, 502);
    }

    // Stream progress to the browser as Server-Sent Events while also
    // saving to the database (so the result survives a closed tab).
    const enc = new TextEncoder();
    let client: ReadableStreamDefaultController<Uint8Array> | null = null;
    const out = new ReadableStream<Uint8Array>({
      start(c) { client = c; },
      cancel() { client = null; },
    });
    const send = (obj: unknown) => {
      if (!client) return;
      try { client.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { client = null; }
    };

    let text = "";
    const key = turnId ?? runId;
    active.set(key, (message) => saveFailed(extractHtml(text) || null, message));

    const work = (async () => {
      let inTok = 0, outTok = 0, stop = "", lastSave = Date.now(), buf = "";
      send({ type: "start", runId, turnId, n: turnNumber });
      try {
        const reader = upstream.body!.pipeThrough(new TextDecoderStream()).getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const evt = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = evt.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            const d = JSON.parse(line.slice(5));
            if (d.type === "message_start") inTok = d.message?.usage?.input_tokens ?? 0;
            else if (d.type === "content_block_delta" && d.delta?.type === "text_delta") {
              text += d.delta.text;
              send({ type: "delta", text: d.delta.text });
            } else if (d.type === "message_delta") {
              outTok = d.usage?.output_tokens ?? outTok;
              stop = d.delta?.stop_reason ?? stop;
            } else if (d.type === "error") {
              throw new Error(d.error?.message ?? "Claude stream error");
            }
          }
          if (Date.now() - lastSave > 5000) {
            lastSave = Date.now();
            await saveProgress(extractHtml(text));
          }
        }
        const html = extractHtml(text);
        if (!/<html|<!doctype/i.test(html)) throw new Error("Claude didn't return a web page. Try rephrasing.");
        const truncated = stop === "max_tokens";
        await saveDone(html, inTok, outTok, truncated ? "The output reached the length limit and may be cut off at the end." : null);
        send({ type: "done", runId, turnId, truncated });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("stream failed", message);
        await saveFailed(extractHtml(text) || null, message);
        send({ type: "error", runId, turnId, message });
      } finally {
        active.delete(key);
        try { (client as ReadableStreamDefaultController<Uint8Array> | null)?.close(); } catch { /* closed */ }
      }
    })();

    // Keep working even if the participant closes the tab.
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(work);

    return new Response(out, {
      headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    });
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
