import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, EVENT_NAME, EVENT_TAGLINE, ALLOWED_DOMAINS, EVENTS_HOME_URL,
} from "./config.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const configured = !SUPABASE_URL.includes("YOUR-PROJECT") && !SUPABASE_ANON_KEY.startsWith("YOUR-");
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const app = document.getElementById("app");
const topbar = document.getElementById("topbar");
const modalRoot = document.getElementById("modal-root");

const state = { session: null, profile: null, settings: null, busy: false };

const MAX_FILES = 5;
const MAX_FILE_MB = 10;
const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json";
const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
};
// Generated pages run in a sandbox WITHOUT allow-same-origin, so they can't
// touch this site's login session.
const SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const timeAgo = (iso) => {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const emailAllowed = (email) => ALLOWED_DOMAINS.includes((email.split("@")[1] || "").toLowerCase().trim());

function extractHtml(raw) {
  let t = (raw || "").trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)(?:```|$)/i);
  if (fence && !/^<!doctype|^<html/i.test(t)) t = fence[1].trim();
  const start = t.search(/<!doctype html|<html/i);
  if (start > 0) t = t.slice(start);
  return t;
}

function toast(msg, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 4500);
}

function confirmModal({ title, body, confirmText = "Yes", cancelText = "Cancel" }) {
  return new Promise((resolve) => {
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <h3 id="m-title">${esc(title)}</h3>
          <div class="modal-body">${body}</div>
          <div class="modal-actions">
            <button class="btn btn-ghost" data-a="no">${esc(cancelText)}</button>
            <button class="btn btn-primary" data-a="yes">${esc(confirmText)}</button>
          </div>
        </div>
      </div>`;
    const close = (v) => { modalRoot.innerHTML = ""; resolve(v); };
    modalRoot.querySelector('[data-a="yes"]').onclick = () => close(true);
    modalRoot.querySelector('[data-a="no"]').onclick = () => close(false);
    modalRoot.querySelector(".modal-backdrop").onclick = (e) => { if (e.target.classList.contains("modal-backdrop")) close(false); };
    modalRoot.querySelector('[data-a="no"]').focus();
  });
}

function setIframe(iframe, html) {
  iframe.srcdoc = html || "<!DOCTYPE html><html><body style='font-family:system-ui;color:#888;display:grid;place-items:center;height:100vh;margin:0'>Nothing yet</body></html>";
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function loadProfile() {
  if (!state.session) { state.profile = null; return; }
  const { data } = await sb.from("profiles").select("id, username").eq("id", state.session.user.id).maybeSingle();
  state.profile = data;
}

async function loadSettings() {
  const { data } = await sb.from("settings").select("*").eq("id", 1).maybeSingle();
  state.settings = data || { final_open: true, test_limit: 25 };
}

async function uploadFiles(files) {
  const paths = [];
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    const safe = f.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const path = `${state.session.user.id}/${Date.now()}-${safe}`;
    const { error } = await sb.storage.from("references").upload(path, f, { contentType: MIME_BY_EXT[ext], upsert: false });
    if (error) throw new Error(`Upload failed for ${f.name}: ${error.message}`);
    paths.push(path);
  }
  return paths;
}

async function waitForRun(runId) {
  for (let i = 0; i < 200; i++) {
    const { data } = await sb.from("runs").select("*").eq("id", runId).maybeSingle();
    if (data && data.status !== "generating") return data;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Still generating — check back in a minute.");
}

/** Calls the edge function and streams the generated HTML. */
async function generate(kind, prompt, files, onProgress) {
  const attachments = files.length ? await uploadFiles(files) : [];
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ kind, prompt, attachments }),
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Request failed (${res.status})`);
  }

  let text = "", runId = null, finished = null;
  try {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!line.startsWith("data:")) continue;
        const d = JSON.parse(line.slice(5));
        if (d.type === "start") runId = d.runId;
        else if (d.type === "delta") { text += d.text; onProgress?.(text); }
        else if (d.type === "done") finished = d;
        else if (d.type === "error") throw new Error(d.message);
      }
    }
  } catch (e) {
    if (!runId) throw e;
    if (e.message && !/network|fetch|abort/i.test(e.message)) throw e;
  }
  // Read the saved result (also covers a dropped connection mid-stream).
  if (!runId) throw new Error("Lost connection before the run started.");
  const run = finished ? (await sb.from("runs").select("*").eq("id", runId).single()).data : await waitForRun(runId);
  if (run.status === "error") throw new Error(run.error || "Generation failed.");
  return run;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function renderTopbar() {
  const route = location.hash || "#/";
  const link = (href, label) => `<a href="${href}" class="${route === href || (href !== "#/" && route.startsWith(href)) ? "active" : ""}">${label}</a>`;
  topbar.innerHTML = `
    <div class="topbar-inner">
      <div class="brand">
        <a class="back" href="${esc(EVENTS_HOME_URL)}" title="All events">←</a>
        <a href="#/" class="brand-name">${esc(EVENT_NAME)}</a>
      </div>
      <nav>
        ${state.profile ? link("#/", "My workspace") : ""}
        ${link("#/dashboard", "Dashboard")}
        ${state.profile ? link(`#/u/${state.profile.username}`, `@${esc(state.profile.username)}`) : ""}
        ${state.session ? `<button class="btn btn-ghost btn-sm" id="signout">Sign out</button>` : ""}
      </nav>
    </div>`;
  const so = $("#signout");
  if (so) so.onclick = async () => { await sb.auth.signOut(); location.hash = "#/"; };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function viewNotConfigured() {
  app.innerHTML = `
    <section class="card narrow">
      <h1>Almost there</h1>
      <p>Open <code>config.js</code> and paste your Supabase project URL and anon key. See the README for the full setup.</p>
    </section>`;
}

function viewLogin() {
  const pending = sessionStorage.getItem("pendingEmail");
  app.innerHTML = `
    <section class="hero">
      <h1>${esc(EVENT_NAME)}</h1>
      <p class="tagline">${esc(EVENT_TAGLINE)}</p>
    </section>
    <section class="card narrow">
      ${pending ? `
        <h2>Check your email</h2>
        <p class="muted">We sent a sign-in code to <strong>${esc(pending)}</strong>.</p>
        <form id="code-form" class="stack">
          <label>Code<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required /></label>
          <button class="btn btn-primary" type="submit">Sign in</button>
          <button class="btn btn-ghost" type="button" id="restart">Use a different email</button>
        </form>` : `
        <h2>Sign in with your USF email</h2>
        <p class="muted">Use an address ending in ${ALLOWED_DOMAINS.map((d) => `<code>@${esc(d)}</code>`).join(", ")}.</p>
        <form id="email-form" class="stack">
          <label>Email<input id="email" type="email" autocomplete="email" placeholder="you@dons.usfca.edu" required /></label>
          <button class="btn btn-primary" type="submit">Send me a code</button>
        </form>`}
    </section>
    <p class="center"><a href="#/dashboard">Browse what people have built →</a></p>`;

  const ef = $("#email-form");
  if (ef) ef.onsubmit = async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim().toLowerCase();
    if (!emailAllowed(email)) return toast("Please use your USF email (usfca.edu, dons.usfca.edu or cs.usfca.edu).", "error");
    const btn = ef.querySelector("button"); btn.disabled = true; btn.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) { btn.disabled = false; btn.textContent = "Send me a code"; return toast(error.message, "error"); }
    sessionStorage.setItem("pendingEmail", email);
    viewLogin();
  };
  const cf = $("#code-form");
  if (cf) {
    $("#code").focus();
    cf.onsubmit = async (e) => {
      e.preventDefault();
      const btn = cf.querySelector("button[type=submit]"); btn.disabled = true;
      const { error } = await sb.auth.verifyOtp({ email: pending, token: $("#code").value.trim(), type: "email" });
      btn.disabled = false;
      if (error) return toast(error.message, "error");
      sessionStorage.removeItem("pendingEmail");
    };
    $("#restart").onclick = () => { sessionStorage.removeItem("pendingEmail"); viewLogin(); };
  }
}

function viewChooseUsername() {
  const suggestion = (state.session.user.email.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  app.innerHTML = `
    <section class="card narrow">
      <h2>Pick your username</h2>
      <p class="muted">This is how everyone will find your product on the dashboard. 3–24 characters: lowercase letters, numbers, <code>-</code> or <code>_</code>.</p>
      <form id="u-form" class="stack">
        <label>Username<input id="username" value="${esc(suggestion)}" pattern="[a-z0-9_\\-]{3,24}" required /></label>
        <button class="btn btn-primary" type="submit">Continue</button>
      </form>
    </section>`;
  $("#username").oninput = (e) => { e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""); };
  $("#u-form").onsubmit = async (e) => {
    e.preventDefault();
    const username = $("#username").value.trim();
    if (!/^[a-z0-9_-]{3,24}$/.test(username)) return toast("3–24 characters: a–z, 0–9, - or _", "error");
    const { error } = await sb.from("profiles").insert({ id: state.session.user.id, username });
    if (error) return toast(error.code === "23505" ? "That username is taken." : error.message, "error");
    await loadProfile();
    render();
  };
}

function fileInputBlock(id) {
  return `
    <div class="files">
      <label class="btn btn-ghost btn-sm file-btn">📎 Attach references
        <input type="file" id="${id}" multiple accept="${ACCEPT}" hidden />
      </label>
      <span class="muted small">Images, PDF, txt, md, csv, json · up to ${MAX_FILES} files, ${MAX_FILE_MB} MB each</span>
      <ul class="file-list" id="${id}-list"></ul>
    </div>`;
}

function wireFileInput(id) {
  let files = [];
  const input = $(`#${id}`), list = $(`#${id}-list`);
  const draw = () => {
    list.innerHTML = files.map((f, i) => `<li>${esc(f.name)} <button type="button" data-i="${i}" title="Remove">✕</button></li>`).join("");
    list.querySelectorAll("button").forEach((b) => (b.onclick = () => { files.splice(+b.dataset.i, 1); draw(); }));
  };
  input.onchange = () => {
    for (const f of input.files) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!MIME_BY_EXT[ext]) { toast(`${f.name}: unsupported file type`, "error"); continue; }
      if (f.size > MAX_FILE_MB * 1024 * 1024) { toast(`${f.name} is over ${MAX_FILE_MB} MB`, "error"); continue; }
      if (files.length >= MAX_FILES) { toast(`Max ${MAX_FILES} files`, "error"); break; }
      files.push(f);
    }
    input.value = "";
    draw();
  };
  return { get: () => files, clear: () => { files = []; draw(); } };
}

async function viewWorkspace() {
  const uid = state.session.user.id;
  const [{ data: tests }, { data: finals }] = await Promise.all([
    sb.from("runs").select("id, prompt, status, error, created_at, output_html").eq("user_id", uid).eq("kind", "test").order("created_at", { ascending: false }),
    sb.from("runs").select("id, status, error, created_at").eq("user_id", uid).eq("kind", "final").neq("status", "error").limit(1),
  ]);
  const final = finals?.[0];
  const limit = state.settings.test_limit;
  const used = tests?.length ?? 0;
  const left = limit > 0 ? Math.max(0, limit - used) : Infinity;

  app.innerHTML = `
    <section class="intro">
      <h1>Hi @${esc(state.profile.username)}</h1>
      <p class="muted">Practice as much as you like, then submit <strong>one</strong> final input. Your final product gets its own page on the dashboard.</p>
    </section>

    <div class="grid-2">
      <section class="card">
        <div class="card-head">
          <h2>1 · Practice</h2>
          <span class="pill">${limit > 0 ? `${left} of ${limit} runs left` : "Unlimited runs"}</span>
        </div>
        <p class="muted small">Private — only you can see practice runs.</p>
        <form id="test-form" class="stack">
          <textarea id="test-prompt" rows="6" maxlength="8000" placeholder="Describe the product you want built…" required></textarea>
          ${fileInputBlock("test-files")}
          <button class="btn btn-secondary" type="submit" ${left === 0 ? "disabled" : ""}>Run practice test</button>
        </form>
        ${tests?.length ? `
          <h3 class="mt">Your practice runs</h3>
          <ul class="history" id="history">
            ${tests.map((t) => `
              <li data-id="${t.id}">
                <span class="status status-${t.status}"></span>
                <span class="h-prompt">${esc(t.prompt.slice(0, 90))}${t.prompt.length > 90 ? "…" : ""}</span>
                <span class="muted small">${timeAgo(t.created_at)}</span>
              </li>`).join("")}
          </ul>` : ""}
      </section>

      <section class="card card-final">
        <div class="card-head">
          <h2>2 · Final submission</h2>
          ${final ? `<span class="pill pill-done">Submitted</span>` : state.settings.final_open ? `<span class="pill pill-open">Open</span>` : `<span class="pill">Closed</span>`}
        </div>
        ${final ? `
          <p>You submitted your final ${timeAgo(final.created_at)}.</p>
          ${final.status === "generating" ? `<p class="muted">It's still being generated… this page will be ready shortly.</p>` : ""}
          <a class="btn btn-primary" href="#/u/${esc(state.profile.username)}">View your product page →</a>
        ` : !state.settings.final_open ? `
          <p class="muted">Final submissions are closed.</p>
        ` : `
          <p class="muted small">You get <strong>one</strong> final. It will be public on the dashboard.</p>
          <form id="final-form" class="stack">
            <textarea id="final-prompt" rows="8" maxlength="8000" placeholder="Your one final input…" required></textarea>
            ${fileInputBlock("final-files")}
            <div class="row">
              <button class="btn btn-ghost btn-sm" type="button" id="copy-practice">Copy from practice box</button>
              <button class="btn btn-primary" type="submit">Submit final</button>
            </div>
          </form>`}
      </section>
    </div>

    <section class="card preview-card">
      <div class="card-head">
        <h2 id="preview-title">Preview</h2>
        <div class="row">
          <span class="muted small" id="preview-status"></span>
          <button class="btn btn-ghost btn-sm" id="toggle-code">Show code</button>
        </div>
      </div>
      <iframe id="preview" class="preview" sandbox="${SANDBOX}" title="Generated product preview"></iframe>
      <pre id="code" class="code" hidden></pre>
    </section>`;

  const preview = $("#preview"), codeEl = $("#code"), statusEl = $("#preview-status");
  let currentHtml = "";
  const show = (html, label) => {
    currentHtml = html || "";
    setIframe(preview, currentHtml);
    codeEl.textContent = currentHtml;
    if (label) $("#preview-title").textContent = label;
  };
  show(tests?.find((t) => t.output_html)?.output_html, tests?.length ? "Latest practice run" : "Preview");

  $("#toggle-code").onclick = (e) => {
    codeEl.hidden = !codeEl.hidden;
    preview.hidden = !codeEl.hidden;
    e.target.textContent = codeEl.hidden ? "Show code" : "Show preview";
  };

  $("#history")?.querySelectorAll("li").forEach((li) => {
    li.onclick = () => {
      const t = tests.find((x) => x.id === li.dataset.id);
      $("#test-prompt").value = t.prompt;
      show(t.output_html, "Practice run · " + timeAgo(t.created_at));
      statusEl.textContent = t.status === "error" ? `⚠ ${t.error || "failed"}` : "";
      preview.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });

  // Live progress while generating
  const runWithProgress = async (kind, prompt, files, button) => {
    if (state.busy) return;
    state.busy = true;
    const original = button.textContent;
    button.disabled = true; button.textContent = "Generating…";
    preview.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#preview-title").textContent = kind === "final" ? "Generating your final product…" : "Generating practice run…";
    const started = Date.now();
    let lastPaint = 0, chars = 0;
    const tick = setInterval(() => { statusEl.textContent = `${Math.round((Date.now() - started) / 1000)}s · ${chars.toLocaleString()} characters`; }, 500);
    codeEl.textContent = "";
    try {
      const run = await generate(kind, prompt, files, (text) => {
        chars = text.length;
        codeEl.textContent = text;
        if (Date.now() - lastPaint > 2000) { lastPaint = Date.now(); setIframe(preview, extractHtml(text)); }
      });
      show(run.output_html);
      statusEl.textContent = run.error ? `⚠ ${run.error}` : `Done in ${Math.round((Date.now() - started) / 1000)}s`;
      return run;
    } catch (e) {
      statusEl.textContent = "";
      toast(e.message, "error");
      return null;
    } finally {
      clearInterval(tick);
      state.busy = false;
      button.disabled = false; button.textContent = original;
    }
  };

  const testFiles = wireFileInput("test-files");
  $("#test-form").onsubmit = async (e) => {
    e.preventDefault();
    const prompt = $("#test-prompt").value.trim();
    if (!prompt) return;
    const run = await runWithProgress("test", prompt, testFiles.get(), e.submitter || $("#test-form button[type=submit]"));
    if (run) { toast("Practice run finished.", "success"); setTimeout(() => viewWorkspace().then(() => { $("#test-prompt").value = prompt; }), 600); }
  };

  const ff = $("#final-form");
  if (ff) {
    const finalFiles = wireFileInput("final-files");
    $("#copy-practice").onclick = () => { $("#final-prompt").value = $("#test-prompt").value; };
    ff.onsubmit = async (e) => {
      e.preventDefault();
      const prompt = $("#final-prompt").value.trim();
      if (!prompt) return;
      const nFiles = finalFiles.get().length;
      const ok = await confirmModal({
        title: "Are you sure you want to submit?",
        body: `<p>This is your <strong>one and only</strong> final submission. You can't change it afterwards.</p>
               <blockquote>${esc(prompt.slice(0, 400))}${prompt.length > 400 ? "…" : ""}</blockquote>
               ${nFiles ? `<p class="muted small">+ ${nFiles} reference file${nFiles > 1 ? "s" : ""}</p>` : ""}`,
        confirmText: "Yes, submit",
      });
      if (!ok) return;
      const run = await runWithProgress("final", prompt, finalFiles.get(), ff.querySelector("button[type=submit]"));
      if (run) { toast("Final submitted! 🎉", "success"); location.hash = `#/u/${state.profile.username}`; }
    };
  }
}

async function viewDashboard() {
  app.innerHTML = `<p class="muted">Loading dashboard…</p>`;
  const [{ data: profiles }, { data: finals }] = await Promise.all([
    sb.from("profiles").select("id, username, created_at").order("username"),
    sb.from("runs").select("id, user_id, prompt, status, created_at, output_html").eq("kind", "final").neq("status", "error"),
  ]);
  const byUser = new Map((finals || []).map((f) => [f.user_id, f]));
  const rows = (profiles || []).map((p) => ({ ...p, final: byUser.get(p.id) }))
    .sort((a, b) => (!!b.final - !!a.final) || (a.final && b.final ? new Date(a.final.created_at) - new Date(b.final.created_at) : a.username.localeCompare(b.username)));
  const submitted = rows.filter((r) => r.final).length;

  app.innerHTML = `
    <section class="intro">
      <h1>Dashboard</h1>
      <p class="muted">${submitted} product${submitted === 1 ? "" : "s"} submitted · ${rows.length} participant${rows.length === 1 ? "" : "s"}</p>
      <input id="search" class="search" placeholder="Search by username or input…" />
    </section>
    <div class="gallery" id="gallery">
      ${rows.map((r) => `
        <a class="tile ${r.final ? "" : "tile-empty"}" href="#/u/${esc(r.username)}" data-q="${esc((r.username + " " + (r.final?.prompt || "")).toLowerCase())}">
          <div class="thumb">
            ${r.final?.output_html ? `<iframe sandbox="" loading="lazy" tabindex="-1" title="${esc(r.username)} preview" data-html="1"></iframe>`
              : `<div class="thumb-empty">${r.final ? "Generating…" : "Not submitted yet"}</div>`}
          </div>
          <div class="tile-body">
            <strong>@${esc(r.username)}</strong>
            <p class="muted small">${r.final ? esc(r.final.prompt.slice(0, 110)) + (r.final.prompt.length > 110 ? "…" : "") : "—"}</p>
          </div>
        </a>`).join("") || `<p class="muted">No participants yet.</p>`}
    </div>`;

  // Fill thumbnails (static render: scripts disabled to keep the page light)
  const tiles = [...document.querySelectorAll(".tile")];
  tiles.forEach((tile, i) => {
    const f = rows[i].final;
    const fr = tile.querySelector("iframe[data-html]");
    if (fr && f) fr.srcdoc = f.output_html;
  });

  $("#search").oninput = (e) => {
    const q = e.target.value.toLowerCase().trim();
    tiles.forEach((t) => (t.style.display = !q || t.dataset.q.includes(q) ? "" : "none"));
  };
}

async function viewUser(username, fullscreen = false) {
  const { data: profile } = await sb.from("profiles").select("id, username, created_at").eq("username", username).maybeSingle();
  if (!profile) { app.innerHTML = `<section class="card narrow"><h2>No user @${esc(username)}</h2><a href="#/dashboard">← Dashboard</a></section>`; return; }
  const { data: finals } = await sb.from("runs").select("*").eq("user_id", profile.id).eq("kind", "final").order("created_at", { ascending: false });
  const final = finals?.find((f) => f.status !== "error") || null;
  const isMe = state.profile?.id === profile.id;

  if (fullscreen && final?.output_html) {
    document.body.classList.add("fullscreen");
    app.innerHTML = `
      <div class="fs-bar"><a href="#/u/${esc(username)}">← @${esc(username)}</a><span class="muted small">${esc(EVENT_NAME)}</span></div>
      <iframe class="fs-frame" sandbox="${SANDBOX}" title="@${esc(username)}'s product"></iframe>`;
    setIframe($(".fs-frame"), final.output_html);
    return;
  }

  if (!final) {
    app.innerHTML = `
      <section class="card narrow">
        <h1>@${esc(username)}</h1>
        <p class="muted">${isMe ? "You haven't submitted your final yet." : "Hasn't submitted a final yet."}</p>
        ${isMe ? `<a class="btn btn-primary" href="#/">Go to my workspace</a>` : `<a href="#/dashboard">← Dashboard</a>`}
      </section>`;
    return;
  }

  const atts = final.attachments || [];
  app.innerHTML = `
    <section class="intro">
      <a href="#/dashboard" class="small">← Dashboard</a>
      <h1>@${esc(username)}</h1>
      <p class="muted small">Submitted ${new Date(final.created_at).toLocaleString()}${final.model ? ` · ${esc(final.model)}` : ""}</p>
    </section>

    <section class="card">
      <h2>Input</h2>
      <div class="prompt-box">${esc(final.prompt)}</div>
      ${atts.length ? `
        <h3 class="mt">References</h3>
        <div class="refs">
          ${atts.map((a) => a.mime?.startsWith("image/")
            ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="ref-img"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" /></a>`
            : `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="ref-file">📄 ${esc(a.name)}</a>`).join("")}
        </div>` : ""}
    </section>

    <section class="card preview-card">
      <div class="card-head">
        <h2>Output</h2>
        <div class="row">
          ${final.status === "generating" ? `<span class="pill">Generating…</span>` : ""}
          ${final.error ? `<span class="muted small">⚠ ${esc(final.error)}</span>` : ""}
          <button class="btn btn-ghost btn-sm" id="toggle-code">Show code</button>
          <button class="btn btn-ghost btn-sm" id="download">Download HTML</button>
          <a class="btn btn-primary btn-sm" href="#/site/${esc(username)}">Open full screen ↗</a>
        </div>
      </div>
      <iframe id="out" class="preview preview-tall" sandbox="${SANDBOX}" title="@${esc(username)}'s product"></iframe>
      <pre id="code" class="code" hidden></pre>
    </section>`;

  setIframe($("#out"), final.output_html);
  $("#code").textContent = final.output_html || "";
  $("#toggle-code").onclick = (e) => {
    const c = $("#code"); c.hidden = !c.hidden; $("#out").hidden = !c.hidden;
    e.target.textContent = c.hidden ? "Show code" : "Show preview";
  };
  $("#download").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([final.output_html || ""], { type: "text/html" }));
    a.download = `${username}.html`; a.click();
  };
  if (final.status === "generating") setTimeout(() => { if (location.hash === `#/u/${username}`) render(); }, 5000);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function render() {
  document.body.classList.remove("fullscreen");
  if (!configured) { topbar.innerHTML = ""; return viewNotConfigured(); }
  renderTopbar();
  const route = location.hash.replace(/^#/, "") || "/";
  try {
    let m;
    if (route === "/dashboard") return await viewDashboard();
    if ((m = route.match(/^\/u\/([a-z0-9_-]+)$/))) return await viewUser(m[1]);
    if ((m = route.match(/^\/site\/([a-z0-9_-]+)$/))) return await viewUser(m[1], true);
    if (!state.session) return viewLogin();
    if (!state.profile) return viewChooseUsername();
    return await viewWorkspace();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<section class="card narrow"><h2>Something went wrong</h2><p class="muted">${esc(e.message)}</p></section>`;
  }
}

async function init() {
  if (!configured) return render();
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  await Promise.all([loadProfile(), loadSettings()]);
  sb.auth.onAuthStateChange((event, s) => {
    const sameUser = state.session?.user.id === s?.user.id;
    state.session = s;
    if (event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION" || (event === "SIGNED_IN" && sameUser)) return;
    // Defer: Supabase recommends not calling other supabase methods inside this callback.
    setTimeout(async () => { await loadProfile(); if (!state.busy) render(); }, 0);
  });
  window.addEventListener("hashchange", render);
  render();
}

init();
