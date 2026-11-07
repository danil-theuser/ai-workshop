import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, EVENT_NAME, EVENT_TAGLINE, ALLOWED_DOMAINS, EVENTS_HOME_URL,
} from "./config.js?v=__BUILD__";

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

// A desktop-style window. `title` and `body` are HTML (escape before passing).
function win(title, body, { icon = "🗔", cls = "", id = "", status = "", controls = true } = {}) {
  return `
    <section class="window ${cls}"${id ? ` id="${id}"` : ""}>
      <div class="title-bar">
        <div class="title-bar-text"><span class="ti" aria-hidden="true">${icon}</span><span>${title}</span></div>
        ${controls ? `<div class="title-bar-controls">
          <button type="button" class="tb-min" data-win="min" aria-label="Minimize" title="Minimize"></button>
          <button type="button" class="tb-max" data-win="max" aria-label="Maximize" title="Maximize"></button>
        </div>` : ""}
      </div>
      <div class="window-body">${body}</div>
      ${status ? `<div class="status-bar">${status}</div>` : ""}
    </section>`;
}

// Window buttons: minimize rolls a window up, maximize fills the screen.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-win]");
  if (!b) return;
  const w = b.closest(".window");
  if (b.dataset.win === "min") { w.classList.toggle("minimized"); w.classList.remove("maximized"); }
  if (b.dataset.win === "max") { w.classList.toggle("maximized"); w.classList.remove("minimized"); }
  document.body.classList.toggle("has-max", !!document.querySelector(".window.maximized"));
});
document.addEventListener("dblclick", (e) => {
  const bar = e.target.closest(".title-bar");
  if (bar && !e.target.closest("button")) bar.querySelector('[data-win="max"]')?.click();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelector(".window.maximized [data-win=max]")?.click();
});

// Stop the browser from opening a file that's dropped outside a drop zone.
["dragover", "drop"].forEach((t) => window.addEventListener(t, (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
}));

// Notifications appear as balloons above the system tray.
function toast(msg, kind = "info") {
  document.querySelectorAll(".balloon").forEach((b) => b.remove());
  const icon = { error: "⛔", success: "✅", info: "ℹ️" }[kind] || "ℹ️";
  const title = { error: "Error", success: "Done", info: EVENT_NAME }[kind] || EVENT_NAME;
  const el = document.createElement("div");
  el.className = `balloon balloon-${kind}`;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.innerHTML = `<button class="balloon-x" aria-label="Close">×</button>
    <div class="balloon-title"><span aria-hidden="true">${icon}</span> ${esc(title)}</div>
    <div class="balloon-msg">${esc(msg)}</div>`;
  el.onclick = () => el.remove();
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, 6000);
}

function confirmModal({ title, body, confirmText = "Yes", cancelText = "Cancel" }) {
  return new Promise((resolve) => {
    modalRoot.innerHTML = `
      <div class="modal-backdrop">
        <div class="window modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
          <div class="title-bar">
            <div class="title-bar-text" id="m-title"><span class="ti" aria-hidden="true">⚠️</span><span>${esc(title)}</span></div>
            <div class="title-bar-controls"><button type="button" class="tb-close" data-a="no" aria-label="Close" title="Close"></button></div>
          </div>
          <div class="window-body">
            <div class="dialog-row">
              <div class="dialog-icon" aria-hidden="true">❓</div>
              <div class="modal-body">${body}</div>
            </div>
            <div class="modal-actions">
              <button class="btn btn-primary" data-a="yes">${esc(confirmText)}</button>
              <button class="btn" data-a="no">${esc(cancelText)}</button>
            </div>
          </div>
        </div>
      </div>`;
    const close = (v) => { modalRoot.innerHTML = ""; document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(false); };
    document.addEventListener("keydown", onKey);
    modalRoot.querySelectorAll('[data-a="yes"]').forEach((b) => (b.onclick = () => close(true)));
    modalRoot.querySelectorAll('[data-a="no"]').forEach((b) => (b.onclick = () => close(false)));
    modalRoot.querySelector('.modal-actions [data-a="no"]').focus();
  });
}

function setIframe(iframe, html) {
  iframe.srcdoc = html || "<!DOCTYPE html><html><body style='font-family:Tahoma,Verdana,sans-serif;font-size:12px;color:#666;background:#fff;display:grid;place-items:center;height:100vh;margin:0'>Nothing here yet. Run a practice test to see a preview.</body></html>";
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
// Sign out, after a confirmation dialog.
async function logOff() {
  const ok = await confirmModal({
    title: `Log Off ${EVENT_NAME}`,
    body: `<p>Are you sure you want to log off?</p>
      ${state.busy ? `<p class="muted small">⏳ A generation is still running. It will keep going on the server and be saved to your account.</p>` : ""}
      <p class="muted small">You can sign back in any time with your USF email.</p>`,
    confirmText: "Log Off",
  });
  if (!ok) return;
  clearInterval(state.dashTimer);
  sessionStorage.removeItem("pendingEmail");
  await sb.auth.signOut();
  state.session = null; state.profile = null;
  if (location.hash === "#/" || location.hash === "") render(); else location.hash = "#/";
  toast("You have been logged off.", "info");
}

// The header is a taskbar: start menu, one button per page, and a clock.
function renderTopbar() {
  const route = location.hash || "#/";
  const isActive = (href) => route === href || (href !== "#/" && route.startsWith(href));
  const items = [
    { href: "#/", icon: state.profile ? "🖥️" : "🔑", label: state.profile ? "My workspace" : "Sign in" },
    { href: "#/dashboard", icon: "🗂️", label: "Dashboard" },
    { href: "#/gallery", icon: "🖼️", label: "Inputs & outputs" },
    ...(state.profile ? [{ href: `#/u/${esc(state.profile.username)}`, icon: "👤", label: `@${esc(state.profile.username)}` }] : []),
  ];
  topbar.innerHTML = `
    <div class="taskbar">
      <button class="start-btn" id="start-btn" aria-haspopup="menu" aria-expanded="false">
        <span class="start-logo" aria-hidden="true"></span>start
      </button>
      <nav class="task-buttons" aria-label="Pages">
        ${items.map((i) => `<a class="task-btn ${isActive(i.href) ? "active" : ""}" href="${i.href}"><span aria-hidden="true">${i.icon}</span><span class="task-label">${i.label}</span></a>`).join("")}
      </nav>
      ${state.session ? `<button class="task-logoff" id="tb-logoff" title="Log Off"><span aria-hidden="true">⏻</span><span class="task-label">Log Off</span></button>` : ""}
      <div class="tray">
        <span class="tray-icon" title="Connected" aria-hidden="true">📶</span>
        <span class="tray-icon" title="Volume" aria-hidden="true">🔊</span>
        <time id="clock"></time>
      </div>
    </div>
    <div class="start-menu" id="start-menu" role="menu" hidden>
      <div class="sm-head">
        <span class="sm-avatar" aria-hidden="true">${state.profile ? "🧑‍💻" : "🌐"}</span>
        <strong>${state.profile ? `@${esc(state.profile.username)}` : "Guest"}</strong>
      </div>
      <div class="sm-body">
        <div class="sm-col">
          ${items.map((i) => `<a role="menuitem" href="${i.href}"><span aria-hidden="true">${i.icon}</span>${i.label}</a>`).join("")}
          ${state.profile ? `<a role="menuitem" href="#/site/${esc(state.profile.username)}"><span aria-hidden="true">🖼️</span>My product, full screen</a>` : ""}
        </div>
        <div class="sm-col sm-col-right">
          <a role="menuitem" href="${esc(EVENTS_HOME_URL)}"><span aria-hidden="true">📅</span>All events</a>
          <div class="sm-note">${esc(EVENT_NAME)}<br>${esc(EVENT_TAGLINE)}</div>
        </div>
      </div>
      <div class="sm-foot">
        ${state.session ? `<button class="sm-power" id="signout"><span aria-hidden="true">⏻</span> Log Off</button>` : `<a class="sm-power" href="#/"><span aria-hidden="true">🔑</span> Log On</a>`}
      </div>
    </div>`;
  const btn = $("#start-btn"), menu = $("#start-menu");
  const setOpen = (open) => { menu.hidden = !open; btn.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open)); };
  btn.onclick = (e) => { e.stopPropagation(); setOpen(menu.hidden); };
  menu.onclick = (e) => { if (e.target.closest("a")) setOpen(false); };
  document.onclick = (e) => { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); };
  const so = $("#signout");
  if (so) so.onclick = () => { setOpen(false); logOff(); };
  const tbl = $("#tb-logoff");
  if (tbl) tbl.onclick = () => logOff();
  document.onkeydown = (e) => { if (e.key === "Escape" && !menu.hidden) setOpen(false); };
  tickClock();
}

function tickClock() {
  const c = $("#clock");
  if (c) c.textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
setInterval(tickClock, 15000);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function viewNotConfigured() {
  app.innerHTML = win("Setup required", `
    <div class="dialog-row">
      <div class="dialog-icon" aria-hidden="true">⚙️</div>
      <div><p><strong>Almost there.</strong></p>
      <p>Open <code>config.js</code> and paste your Supabase project URL and anon key. See the README for the full setup.</p></div>
    </div>`, { icon: "⚙️", cls: "narrow", controls: false });
}

function logonBanner() {
  return `
    <div class="logon-banner">
      <div class="logon-badge" aria-hidden="true">AI</div>
      <div>
        <div class="logon-name">${esc(EVENT_NAME)}</div>
        <div class="logon-tag">${esc(EVENT_TAGLINE)}</div>
      </div>
    </div>`;
}

function viewLogin() {
  const pending = sessionStorage.getItem("pendingEmail");
  app.innerHTML = `
    ${win("Log On to " + esc(EVENT_NAME), `
      ${logonBanner()}
      <div class="logon-body">
      ${pending ? `
        <p>We sent a sign-in code to <strong>${esc(pending)}</strong>. Check your inbox (and spam).</p>
        <form id="code-form" class="form-grid">
          <label for="code">Code:</label>
          <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456" required />
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">OK</button>
            <button class="btn" type="button" id="resend">Resend code</button>
            <button class="btn" type="button" id="restart">Use a different email</button>
          </div>
        </form>` : `
        <p>Sign in with your USF email: ${ALLOWED_DOMAINS.map((d) => `<code>@${esc(d)}</code>`).join(", ")}.</p>
        <form id="email-form" class="form-grid">
          <label for="email">E-mail:</label>
          <input id="email" type="email" autocomplete="email" placeholder="you@dons.usfca.edu" required />
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">Send me a code</button>
          </div>
        </form>`}
      </div>`, { icon: "🔑", cls: "narrow logon", controls: false })}
    <p class="center desktop-link"><a href="#/dashboard">🗂️ Browse what people have built →</a> <a href="#/gallery">🖼️ See inputs &amp; outputs →</a></p>`;

  const ef = $("#email-form");
  if (ef) ef.onsubmit = async (e) => {
    e.preventDefault();
    const email = $("#email").value.trim().toLowerCase();
    if (!emailAllowed(email)) return toast("Please use your USF email (usfca.edu, dons.usfca.edu or cs.usfca.edu).", "error");
    const btn = ef.querySelector("button"); btn.disabled = true; btn.textContent = "Sending…";
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) { btn.disabled = false; btn.textContent = "Send me a code"; return toast(error.message, "error"); }
    sessionStorage.setItem("pendingEmail", email);
    sessionStorage.setItem("codeSentAt", String(Date.now()));
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
    // Resend, with the same 60 s cooldown Supabase enforces
    const rb = $("#resend");
    const cooldown = () => {
      const left = 60 - Math.floor((Date.now() - +(sessionStorage.getItem("codeSentAt") || 0)) / 1000);
      rb.disabled = left > 0;
      rb.textContent = left > 0 ? `Resend code (${left}s)` : "Resend code";
      if (left > 0 && document.body.contains(rb)) setTimeout(cooldown, 1000);
    };
    cooldown();
    rb.onclick = async () => {
      rb.disabled = true; rb.textContent = "Sending…";
      const { error } = await sb.auth.signInWithOtp({ email: pending, options: { shouldCreateUser: true } });
      if (error) { toast(error.message, "error"); rb.disabled = false; rb.textContent = "Resend code"; return; }
      sessionStorage.setItem("codeSentAt", String(Date.now()));
      toast(`New code sent to ${pending}.`, "success");
      cooldown();
    };
  }
}

function viewChooseUsername() {
  const suggestion = (state.session.user.email.split("@")[0] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  app.innerHTML = win("New User Setup", `
    ${logonBanner()}
    <div class="logon-body">
      <p>Pick your username. This is how everyone will find your product on the dashboard.</p>
      <p class="muted small">3–24 characters: lowercase letters, numbers, <code>-</code> or <code>_</code>.</p>
      <form id="u-form" class="form-grid">
        <label for="username">User name:</label>
        <input id="username" value="${esc(suggestion)}" pattern="[a-z0-9_\\-]{3,24}" required />
        <div class="form-actions"><button class="btn btn-primary" type="submit">Next &gt;</button></div>
      </form>
    </div>`, { icon: "👤", cls: "narrow logon", controls: false });
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

// Reference files: drag them onto the drop zone (or anywhere on the form),
// or click Browse… to pick them.
function fileInputBlock(id) {
  return `
    <div class="dropzone" id="${id}-zone">
      <input type="file" id="${id}" multiple accept="${ACCEPT}" hidden />
      <div class="dz-empty">
        <span class="dz-icon" aria-hidden="true">📂</span>
        <span><strong>Drag reference files here</strong> or
          <label class="btn btn-sm" for="${id}">Browse…</label></span>
        <span class="muted small">Images, PDF, txt, md, csv, json · up to ${MAX_FILES} files, ${MAX_FILE_MB} MB each</span>
      </div>
      <ul class="file-list" id="${id}-list"></ul>
      <div class="dz-overlay" aria-hidden="true">📥 Drop to attach</div>
    </div>`;
}

const fileIcon = (name) => /\.(png|jpe?g|gif|webp)$/i.test(name) ? "🖼️" : /\.pdf$/i.test(name) ? "📕" : "📄";
const fileSize = (n) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

function wireFileInput(id) {
  let files = [];
  const input = $(`#${id}`), list = $(`#${id}-list`), zone = $(`#${id}-zone`);
  const target = zone.closest("form") || zone;
  const draw = () => {
    zone.classList.toggle("has-files", files.length > 0);
    list.innerHTML = files.map((f, i) => `
      <li><span aria-hidden="true">${fileIcon(f.name)}</span><span class="fl-name">${esc(f.name)}</span>
        <span class="muted small">${fileSize(f.size)}</span>
        <button type="button" data-i="${i}" title="Remove" aria-label="Remove ${esc(f.name)}">×</button></li>`).join("") +
      (files.length && files.length < MAX_FILES ? `<li class="fl-add"><label for="${id}">+ Add more…</label></li>` : "");
    list.querySelectorAll("button").forEach((b) => (b.onclick = () => { files.splice(+b.dataset.i, 1); draw(); }));
  };
  const add = (incoming) => {
    let added = 0;
    for (const f of incoming) {
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (!MIME_BY_EXT[ext]) { toast(`${f.name}: unsupported file type`, "error"); continue; }
      if (f.size > MAX_FILE_MB * 1024 * 1024) { toast(`${f.name} is over ${MAX_FILE_MB} MB`, "error"); continue; }
      if (files.some((x) => x.name === f.name && x.size === f.size)) continue;
      if (files.length >= MAX_FILES) { toast(`Max ${MAX_FILES} files`, "error"); break; }
      files.push(f); added++;
    }
    draw();
    return added;
  };
  input.onchange = () => { add(input.files); input.value = ""; };

  // Drag & drop onto the whole form. The counter avoids flicker when the
  // pointer passes over child elements.
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes("Files");
  target.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; zone.classList.add("dragging"); });
  target.addEventListener("dragover", (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  target.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove("dragging"); });
  target.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; zone.classList.remove("dragging");
    const n = add(e.dataTransfer.files);
    if (n) toast(`Attached ${n} file${n > 1 ? "s" : ""}.`, "success");
  });
  return { get: () => files, clear: () => { files = []; draw(); } };
}

const progressBar = () => `<div class="progress" role="progressbar" aria-label="Generating"><div class="progress-marquee"></div></div>`;

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
  const statusLabel = { done: "Done", error: "Failed", generating: "Running" };

  app.innerHTML = `
    ${win(`Welcome, @${esc(state.profile.username)}`, `
      <div class="dialog-row">
        <div class="dialog-icon" aria-hidden="true">💡</div>
        <p>Practice as much as you like, then submit <strong>one</strong> final input. Your final product gets its own page on the dashboard.</p>
        <div class="intro-actions">
          <a class="btn btn-sm" href="#/u/${esc(state.profile.username)}">👤 My account</a>
          <button class="btn btn-sm" id="ws-logoff">⏻ Log Off</button>
        </div>
      </div>`, { icon: "🖥️", cls: "intro-win" })}

    <div class="grid-2">
      ${win("1 · Practice", `
        <p class="muted small">🔒 Private: only you can see practice runs.</p>
        <form id="test-form" class="stack">
          <textarea id="test-prompt" rows="6" maxlength="8000" placeholder="Describe the product you want built…" required></textarea>
          ${fileInputBlock("test-files")}
          <div class="form-actions"><button class="btn btn-primary" type="submit" ${left === 0 ? "disabled" : ""}>▶ Run practice test</button></div>
        </form>
        ${tests?.length ? `
          <fieldset class="mt">
            <legend>Your practice runs</legend>
            <div class="listview-wrap"><table class="listview" id="history">
              <thead><tr><th>Input</th><th>Status</th><th>When</th></tr></thead>
              <tbody>
              ${tests.map((t) => `
                <tr data-id="${t.id}" tabindex="0">
                  <td class="h-prompt">${esc(t.prompt.slice(0, 90))}${t.prompt.length > 90 ? "…" : ""}</td>
                  <td><span class="status status-${t.status}"></span>${statusLabel[t.status] || esc(t.status)}</td>
                  <td class="nowrap">${timeAgo(t.created_at)}</td>
                </tr>`).join("")}
              </tbody>
            </table></div>
          </fieldset>` : ""}`,
        { icon: "📝", status: `<span class="status-bar-field">${limit > 0 ? `${left} of ${limit} runs left` : "Unlimited runs"}</span><span class="status-bar-field">${used} used</span>` })}

      ${win("2 · Final submission", final ? `
          <div class="dialog-row">
            <div class="dialog-icon" aria-hidden="true">🏆</div>
            <div>
              <p>You submitted your final ${timeAgo(final.created_at)}.</p>
              ${final.status === "generating" ? `<p class="muted">It's still being generated… your page will be ready shortly.</p>${progressBar()}` : ""}
            </div>
          </div>
          <div class="form-actions"><a class="btn btn-primary" href="#/u/${esc(state.profile.username)}">View your product page →</a></div>
        ` : !state.settings.final_open ? `
          <div class="dialog-row"><div class="dialog-icon" aria-hidden="true">🚫</div><p>Final submissions are closed.</p></div>
        ` : `
          <p class="muted small">You get <strong>one</strong> final. It will be public on the dashboard.</p>
          <form id="final-form" class="stack">
            <textarea id="final-prompt" rows="8" maxlength="8000" placeholder="Your one final input…" required></textarea>
            ${fileInputBlock("final-files")}
            <div class="form-actions">
              <button class="btn" type="button" id="copy-practice">📋 Copy from practice box</button>
              <button class="btn btn-primary" type="submit">Submit final</button>
            </div>
          </form>`,
        { icon: "🏁", cls: "card-final", status: `<span class="status-bar-field">${final ? "✔ Submitted" : state.settings.final_open ? "● Open" : "Closed"}</span>` })}
    </div>

    ${win(`<span id="preview-title">Preview</span>`, `
      <div class="toolbar">
        <button class="btn btn-sm" id="toggle-code">📄 Show code</button>
      </div>
      <iframe id="preview" class="preview" sandbox="${SANDBOX}" title="Generated product preview"></iframe>
      <pre id="code" class="code" hidden></pre>`,
      { icon: "🌐", cls: "preview-card", status: `<span class="status-bar-field grow" id="preview-status">Ready</span><span class="status-bar-field" id="preview-progress"></span>` })}`;

  $("#ws-logoff").onclick = () => logOff();
  const preview = $("#preview"), codeEl = $("#code"), statusEl = $("#preview-status"), progEl = $("#preview-progress");
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
    e.currentTarget.textContent = codeEl.hidden ? "📄 Show code" : "🌐 Show preview";
  };

  $("#history")?.querySelectorAll("tbody tr").forEach((tr) => {
    const open = () => {
      const t = tests.find((x) => x.id === tr.dataset.id);
      $("#history").querySelectorAll("tr.selected").forEach((r) => r.classList.remove("selected"));
      tr.classList.add("selected");
      $("#test-prompt").value = t.prompt;
      show(t.output_html, "Practice run · " + timeAgo(t.created_at));
      statusEl.textContent = t.status === "error" ? `⚠ ${t.error || "failed"}` : "Done";
      preview.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    tr.onclick = open;
    tr.onkeydown = (e) => { if (e.key === "Enter") open(); };
  });

  // Live progress while generating
  const runWithProgress = async (kind, prompt, files, button) => {
    if (state.busy) return;
    state.busy = true;
    const original = button.innerHTML;
    button.disabled = true; button.textContent = "Generating…";
    preview.scrollIntoView({ behavior: "smooth", block: "start" });
    $("#preview-title").textContent = kind === "final" ? "Generating your final product…" : "Generating practice run…";
    document.body.classList.add("busy");
    progEl.innerHTML = progressBar();
    const started = Date.now();
    let lastPaint = 0, chars = 0;
    const tick = setInterval(() => { statusEl.textContent = `Building… ${Math.round((Date.now() - started) / 1000)}s · ${chars.toLocaleString()} characters`; }, 500);
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
      statusEl.textContent = "Ready";
      toast(e.message, "error");
      return null;
    } finally {
      clearInterval(tick);
      progEl.innerHTML = "";
      document.body.classList.remove("busy");
      state.busy = false;
      button.disabled = false; button.innerHTML = original;
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

// Dashboard: every participant's final product. Polls every 30 s for new or
// finished submissions (a cheap query), and only redraws when something changed.
const DASH_POLL_MS = 30000;

async function dashSignature() {
  const [{ data: ps }, { data: fs }] = await Promise.all([
    sb.from("profiles").select("id"),
    sb.from("runs").select("id, status").eq("kind", "final").neq("status", "error"),
  ]);
  return `${(ps || []).length}|${(fs || []).map((f) => f.id + f.status).sort().join(",")}`;
}


// Reference files shown under an input (images as thumbnails, others as icons).
function refsHtml(atts) {
  if (!atts?.length) return "";
  return `
    <fieldset class="mt">
      <legend>References</legend>
      <div class="refs">
        ${atts.map((a) => a.mime?.startsWith("image/")
          ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="ref-img" title="${esc(a.name)}"><img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" /><span>${esc(a.name)}</span></a>`
          : `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="ref-file"><span class="ref-file-icon" aria-hidden="true">${fileIcon(a.name)}</span><span>${esc(a.name)}</span></a>`).join("")}
      </div>
    </fieldset>`;
}

// Checks every 30 s whether finals changed; calls onChange while on `route`.
function pollForChanges(route, onChange) {
  clearInterval(state.dashTimer);
  let sig = null;
  dashSignature().then((s) => (sig = s)).catch(() => {});
  state.dashTimer = setInterval(async () => {
    if (location.hash !== route) return clearInterval(state.dashTimer);
    if (document.hidden) return;
    const now = await dashSignature().catch(() => null);
    if (now && sig && now !== sig) { sig = now; onChange(); }
  }, DASH_POLL_MS);
}

// Renders iframes' srcdoc only once they scroll near the viewport.
function lazyFrames(frames, htmlFor) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.srcdoc = htmlFor(e.target); io.unobserve(e.target); }
  }, { rootMargin: "300px" });
  frames.forEach((f) => io.observe(f));
}

async function viewDashboard({ refresh = false } = {}) {
  if (!refresh) app.innerHTML = win("Dashboard", `<p>Loading dashboard…</p>${progressBar()}`, { icon: "🗂️", cls: "narrow", controls: false });
  const [{ data: profiles, error: pErr }, { data: finals, error: fErr }] = await Promise.all([
    sb.from("profiles").select("id, username, created_at").order("username"),
    sb.from("runs").select("id, user_id, prompt, status, created_at, output_html").eq("kind", "final").neq("status", "error"),
  ]);
  if (pErr || fErr) throw new Error((pErr || fErr).message);
  if (location.hash !== "#/dashboard") return; // navigated away while loading
  const byUser = new Map((finals || []).map((f) => [f.user_id, f]));
  const rows = (profiles || []).map((p) => ({ ...p, final: byUser.get(p.id) }))
    .sort((a, b) => (!!b.final - !!a.final) || (a.final && b.final ? new Date(a.final.created_at) - new Date(b.final.created_at) : a.username.localeCompare(b.username)));
  const submitted = rows.filter((r) => r.final).length;
  const prevQuery = refresh ? ($("#search")?.value || "") : "";
  const prevScroll = window.scrollY;

  app.innerHTML = win("Dashboard · All products", `
    <div class="toolbar">
      <label class="search-label" for="search">🔍 Search:</label>
      <input id="search" class="search" placeholder="Username or input…" value="${esc(prevQuery)}" />
      <button class="btn btn-sm" id="dash-refresh" title="Refresh">🔄 Refresh</button>
      <span class="toolbar-sep"></span>
      <a class="btn btn-sm" href="#/gallery">🖼️ See all inputs &amp; outputs</a>
    </div>
    <div class="gallery" id="gallery">
      ${rows.map((r) => `
        <a class="tile ${r.final ? "" : "tile-empty"}" href="#/u/${esc(r.username)}" data-q="${esc((r.username + " " + (r.final?.prompt || "")).toLowerCase())}">
          <div class="tile-title"><span aria-hidden="true">${r.final ? "🌐" : "📁"}</span> @${esc(r.username)}</div>
          <div class="thumb">
            ${r.final?.output_html ? `<iframe sandbox="allow-scripts" tabindex="-1" aria-hidden="true" title="${esc(r.username)} preview" data-html="1"></iframe>`
              : `<div class="thumb-empty">${r.final ? "⏳ Generating…" : "Not submitted yet"}</div>`}
          </div>
          <div class="tile-body">
            <p class="small">${r.final ? esc(r.final.prompt.slice(0, 110)) + (r.final.prompt.length > 110 ? "…" : "") : "—"}</p>
          </div>
        </a>`).join("") || `<p class="muted">No participants yet.</p>`}
    </div>`, {
      icon: "🗂️", cls: "dash-win",
      status: `<span class="status-bar-field">${submitted} product${submitted === 1 ? "" : "s"} submitted</span><span class="status-bar-field">${rows.length} participant${rows.length === 1 ? "" : "s"}</span><span class="status-bar-field grow" id="search-count"></span><span class="status-bar-field">Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>`,
    });
  if (refresh) window.scrollTo(0, prevScroll);

  // Live thumbnails (scripts allowed so JS-drawn products show up; still
  // sandboxed without same-origin). Only rendered once scrolled into view.
  const tiles = [...document.querySelectorAll(".tile")];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const i = tiles.indexOf(e.target.closest(".tile"));
      e.target.srcdoc = rows[i].final.output_html;
      io.unobserve(e.target);
    }
  }, { rootMargin: "200px" });
  tiles.forEach((t) => { const fr = t.querySelector("iframe[data-html]"); if (fr) io.observe(fr); });

  const search = $("#search");
  const applySearch = () => {
    const q = search.value.toLowerCase().trim();
    let shown = 0;
    tiles.forEach((t) => { const ok = !q || t.dataset.q.includes(q); t.style.display = ok ? "" : "none"; shown += ok; });
    $("#search-count").textContent = q ? `${shown} match${shown === 1 ? "" : "es"}` : "";
  };
  search.oninput = applySearch;
  if (prevQuery) applySearch();

  pollForChanges("#/dashboard", () => viewDashboard({ refresh: true }));
  $("#dash-refresh").onclick = () => viewDashboard({ refresh: true });
}


// Every final submission: the full input next to the live output.
async function viewGallery() {
  app.innerHTML = win("Inputs & outputs", `<p>Loading…</p>${progressBar()}`, { icon: "🖼️", cls: "narrow", controls: false });
  const { data, error } = await sb.from("runs")
    .select("id, prompt, attachments, status, created_at, model, output_html, profiles(username)")
    .eq("kind", "final").neq("status", "error").order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  if (location.hash !== "#/gallery") return;
  const items = (data || []).filter((f) => f.profiles?.username);

  app.innerHTML = `
    ${win("Inputs & outputs · All submissions", `
      <div class="toolbar">
        <label class="search-label" for="search">🔍 Search:</label>
        <input id="search" class="search" placeholder="Username or input…" />
        <button class="btn btn-sm" id="g-refresh">🔄 Refresh</button>
        <span class="toolbar-sep"></span>
        <a class="btn btn-sm" href="#/dashboard">🗂️ Dashboard</a>
      </div>
      <div class="dialog-row">
        <div class="dialog-icon" aria-hidden="true">🖼️</div>
        <p>What every participant asked for, next to what Claude built from it. Click into an output to try it. Practice runs stay private; only final submissions are shown.</p>
      </div>`, {
        icon: "🖼️", cls: "intro-win",
        status: `<span class="status-bar-field">${items.length} submission${items.length === 1 ? "" : "s"}</span><span class="status-bar-field grow" id="search-count"></span><span class="status-bar-field" id="g-new" hidden></span>`,
      })}
    ${items.map((f, i) => {
      const u = esc(f.profiles.username);
      return `<div class="io-item" data-q="${esc((f.profiles.username + " " + f.prompt).toLowerCase())}">
        ${win(`#${i + 1} · @${u}`, `
          <div class="io-grid">
            <div class="io-input">
              <h3 class="io-label">📝 Input</h3>
              <div class="prompt-box">${esc(f.prompt)}</div>
              ${refsHtml(f.attachments)}
            </div>
            <div class="io-output">
              <div class="io-label-row">
                <h3 class="io-label">🌐 Output</h3>
                <div class="row">
                  <a class="btn btn-sm" href="#/u/${u}">Open page</a>
                  <a class="btn btn-sm btn-primary" href="#/site/${u}">Full screen ↗</a>
                </div>
              </div>
              ${f.output_html ? `<iframe class="preview io-frame" sandbox="${SANDBOX}" data-i="${i}" title="@${u}'s product"></iframe>`
                : `<div class="io-frame thumb-empty">⏳ Still generating…</div>`}
            </div>
          </div>`, {
          icon: "🌐",
          status: `<span class="status-bar-field grow">Submitted ${esc(new Date(f.created_at).toLocaleString())}</span>${f.model ? `<span class="status-bar-field">${esc(f.model)}</span>` : ""}`,
        })}
      </div>`;
    }).join("") || win("Nothing yet", `<div class="dialog-row"><div class="dialog-icon" aria-hidden="true">📭</div><p>No final submissions yet. Check back soon.</p></div>`, { icon: "📭", cls: "narrow", controls: false })}`;

  lazyFrames([...document.querySelectorAll(".io-frame[data-i]")], (fr) => items[+fr.dataset.i].output_html);

  const blocks = [...document.querySelectorAll(".io-item")];
  $("#search").oninput = (e) => {
    const q = e.target.value.toLowerCase().trim();
    let shown = 0;
    blocks.forEach((b) => { const ok = !q || b.dataset.q.includes(q); b.style.display = ok ? "" : "none"; shown += ok; });
    $("#search-count").textContent = q ? `${shown} match${shown === 1 ? "" : "es"}` : "";
  };
  $("#g-refresh").onclick = () => viewGallery();
  // Don't redraw by itself (that would reset outputs people are playing with);
  // just say there's something new.
  pollForChanges("#/gallery", () => {
    const n = $("#g-new");
    if (n) { n.hidden = false; n.innerHTML = `✨ New submissions · <a href="#/gallery" id="g-new-link">Refresh</a>`; $("#g-new-link").onclick = (e) => { e.preventDefault(); viewGallery(); }; }
  });
}


// "My account" window, shown only on your own profile page.
async function accountWindow(final) {
  const uid = state.session.user.id;
  const { count: used } = await sb.from("runs").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("kind", "test");
  const limit = state.settings?.test_limit ?? 0;
  return win("My account", `
    <div class="account">
      <div class="account-avatar" aria-hidden="true">🧑‍💻</div>
      <div class="account-info">
        <div class="account-name">@${esc(state.profile.username)}</div>
        <div class="muted small">${esc(state.session.user.email)} · <span title="Only you can see this">🔒 only visible to you</span></div>
        <table class="props">
          <tr><th>Practice runs</th><td>${used ?? 0}${limit > 0 ? ` of ${limit}` : ""} used</td></tr>
          <tr><th>Final</th><td>${final ? (final.status === "generating" ? "⏳ Generating…" : "✔ Submitted " + esc(new Date(final.created_at).toLocaleString())) : state.settings?.final_open ? "Not submitted yet" : "Not submitted (closed)"}</td></tr>
        </table>
        <form id="rename-form" class="rename" hidden>
          <label for="new-username">New user name:</label>
          <input id="new-username" value="${esc(state.profile.username)}" maxlength="24" required />
          <button class="btn btn-sm btn-primary" type="submit">Save</button>
          <button class="btn btn-sm" type="button" id="rename-cancel">Cancel</button>
        </form>
      </div>
    </div>
    <div class="form-actions">
      <a class="btn" href="#/">🖥️ My workspace</a>
      <button class="btn" id="rename-btn">✏️ Change username</button>
      <button class="btn btn-primary" id="acct-logoff">⏻ Log Off</button>
    </div>`, { icon: "👤", cls: "account-win" });
}

function wireAccountWindow() {
  if (!$("#acct-logoff")) return;
  $("#acct-logoff").onclick = () => logOff();
  const form = $("#rename-form"), input = $("#new-username");
  $("#rename-btn").onclick = () => { form.hidden = false; input.focus(); input.select(); };
  $("#rename-cancel").onclick = () => { form.hidden = true; input.value = state.profile.username; };
  input.oninput = () => { input.value = input.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""); };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const username = input.value.trim();
    if (username === state.profile.username) { form.hidden = true; return; }
    if (!/^[a-z0-9_-]{3,24}$/.test(username)) return toast("3–24 characters: a–z, 0–9, - or _", "error");
    const { error } = await sb.from("profiles").update({ username }).eq("id", state.profile.id);
    if (error) return toast(error.code === "23505" ? "That username is taken." : error.message, "error");
    await loadProfile();
    toast(`You are now @${username}.`, "success");
    location.hash = `#/u/${username}`;
  };
}

async function viewUser(username, fullscreen = false) {
  const { data: profile } = await sb.from("profiles").select("id, username, created_at").eq("username", username).maybeSingle();
  if (!profile) {
    app.innerHTML = win("User not found", `
      <div class="dialog-row"><div class="dialog-icon" aria-hidden="true">⛔</div>
        <p>There's no user called <strong>@${esc(username)}</strong>.</p></div>
      <div class="form-actions"><a class="btn" href="#/dashboard">OK</a></div>`, { icon: "⛔", cls: "narrow", controls: false });
    return;
  }
  const { data: finals } = await sb.from("runs").select("*").eq("user_id", profile.id).eq("kind", "final").order("created_at", { ascending: false });
  const final = finals?.find((f) => f.status !== "error") || null;
  const isMe = state.profile?.id === profile.id;

  if (fullscreen && final?.output_html) {
    document.body.classList.add("fullscreen");
    app.innerHTML = `
      <div class="window fs-window">
        <div class="title-bar">
          <div class="title-bar-text"><span class="ti" aria-hidden="true">🌐</span><span>@${esc(username)}'s product · ${esc(EVENT_NAME)}</span></div>
          <div class="title-bar-controls"><a class="tb-close" href="#/u/${esc(username)}" aria-label="Close" title="Close"></a></div>
        </div>
        <div class="fs-menu"><a href="#/u/${esc(username)}">← Back to @${esc(username)}</a></div>
        <iframe class="fs-frame" sandbox="${SANDBOX}" title="@${esc(username)}'s product"></iframe>
      </div>`;
    setIframe($(".fs-frame"), final.output_html);
    return;
  }

  const acct = isMe && state.session ? await accountWindow(final) : "";

  if (!final) {
    app.innerHTML = acct + win(`@${esc(username)}`, `
      <div class="dialog-row"><div class="dialog-icon" aria-hidden="true">📭</div>
        <p>${isMe ? "You haven't submitted your final yet." : "Hasn't submitted a final yet."}</p></div>
      <div class="form-actions">${isMe ? `<a class="btn btn-primary" href="#/">Go to my workspace</a>` : `<a class="btn" href="#/dashboard">← Dashboard</a>`}</div>`,
      { icon: "👤", cls: isMe ? "" : "narrow", controls: false });
    wireAccountWindow();
    return;
  }

  // Previous / next submission, in dashboard order (oldest final first)
  const { data: order } = await sb.from("runs").select("user_id, created_at, profiles(username)")
    .eq("kind", "final").neq("status", "error").order("created_at", { ascending: true });
  const names = (order || []).map((o) => o.profiles?.username).filter(Boolean);
  const idx = names.indexOf(username);
  const prev = idx > 0 ? names[idx - 1] : null;
  const next = idx >= 0 && idx < names.length - 1 ? names[idx + 1] : null;

  app.innerHTML = `${acct}
    <div class="user-split">
    ${win(`@${esc(username)} · Input`, `
      <div class="prompt-box">${esc(final.prompt)}</div>
      ${refsHtml(final.attachments)}`,
      { icon: "📝", cls: "user-input", status: `<span class="status-bar-field grow">Submitted ${esc(new Date(final.created_at).toLocaleString())}</span>${final.model ? `<span class="status-bar-field">${esc(final.model)}</span>` : ""}` })}

    ${win(`@${esc(username)} · Output`, `
      <div class="toolbar">
        <a class="btn btn-sm" href="#/dashboard">🗂️ Dashboard</a>
        <a class="btn btn-sm ${prev ? "" : "is-disabled"}" ${prev ? `href="#/u/${esc(prev)}" title="@${esc(prev)}"` : 'aria-disabled="true"'}>◀ Previous</a>
        <a class="btn btn-sm ${next ? "" : "is-disabled"}" ${next ? `href="#/u/${esc(next)}" title="@${esc(next)}"` : 'aria-disabled="true"'}>Next ▶</a>
        <span class="toolbar-sep"></span>
        <button class="btn btn-sm" id="toggle-code">📄 Show code</button>
        <button class="btn btn-sm" id="download">💾 Download HTML</button>
        <a class="btn btn-sm btn-primary" href="#/site/${esc(username)}">Open full screen ↗</a>
      </div>
      <iframe id="out" class="preview preview-tall" sandbox="${SANDBOX}" title="@${esc(username)}'s product"></iframe>
      <pre id="code" class="code" hidden></pre>`,
      { icon: "🌐", cls: "preview-card", status: `<span class="status-bar-field grow">${final.status === "generating" ? "⏳ Generating…" : final.error ? `⚠ ${esc(final.error)}` : "Done"}</span>${final.status === "generating" ? `<span class="status-bar-field">${progressBar()}</span>` : ""}${idx >= 0 ? `<span class="status-bar-field">${idx + 1} of ${names.length}</span>` : ""}` })}
    </div>`;

  wireAccountWindow();
  setIframe($("#out"), final.output_html);
  $("#code").textContent = final.output_html || "";
  $("#toggle-code").onclick = (e) => {
    const c = $("#code"); c.hidden = !c.hidden; $("#out").hidden = !c.hidden;
    e.currentTarget.textContent = c.hidden ? "📄 Show code" : "🌐 Show preview";
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
  document.body.classList.remove("fullscreen", "has-max");
  if (!["#/dashboard", "#/gallery"].includes(location.hash)) clearInterval(state.dashTimer);
  if (!configured) { topbar.innerHTML = ""; return viewNotConfigured(); }
  renderTopbar();
  const route = location.hash.replace(/^#/, "") || "/";
  try {
    let m;
    if (route === "/dashboard") return await viewDashboard();
    if (route === "/gallery") return await viewGallery();
    if ((m = route.match(/^\/u\/([a-z0-9_-]+)$/))) return await viewUser(m[1]);
    if ((m = route.match(/^\/site\/([a-z0-9_-]+)$/))) return await viewUser(m[1], true);
    if (!state.session) return viewLogin();
    if (!state.profile) return viewChooseUsername();
    return await viewWorkspace();
  } catch (e) {
    console.error(e);
    app.innerHTML = win("Error", `<div class="dialog-row"><div class="dialog-icon" aria-hidden="true">⛔</div><div><p><strong>Something went wrong.</strong></p><p class="muted">${esc(e.message)}</p></div></div><div class="form-actions"><button class="btn" onclick="location.reload()">OK</button></div>`, { icon: "⛔", cls: "narrow", controls: false });
  }
}

// Each deploy stamps __BUILD__ with the commit id (see .github/workflows/pages.yml).
// GitHub Pages lets browsers cache files for 10 minutes, so if a newer
// version has been published, reload once onto it.
const BUILD = "__BUILD__";
async function ensureLatest() {
  if (BUILD.startsWith("__")) return; // local dev
  try {
    const r = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    const { build } = await r.json();
    if (build && build !== BUILD && sessionStorage.getItem("reloadedFor") !== build) {
      sessionStorage.setItem("reloadedFor", build);
      location.replace(`${location.pathname}?v=${build}${location.hash}`);
    }
  } catch { /* offline or missing: keep going */ }
}

async function init() {
  ensureLatest();
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
