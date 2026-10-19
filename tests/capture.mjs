/**
 * tests/capture.mjs
 * ---------------------------------------------------------------
 * Optional dev tool: drives the Smart Notes app in a headless
 * Chrome window and captures real screenshots of each UI state.
 *
 * It also re-runs the core user flows (create, search, reload,
 * persistence) inside a clean browser profile, so every screenshot
 * corresponds to a state that was actually rendered.
 *
 * Usage:
 *   1. Start a static server in the project root, e.g.
 *        python -m http.server 8000
 *   2. node tests/capture.mjs
 *
 * Screenshots are written to ../screenshots/
 * ---------------------------------------------------------------
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "screenshots");
const APP = process.env.APP_URL || "http://127.0.0.1:8000/index.html";
const PORT = 9333;
const PROFILE = join(process.env.TEMP || process.env.TMP || ROOT, "smartnotes-chrome-profile");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) throw new Error("Chrome not found");

/* ---------------- tiny CDP client ---------------- */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.onopen = () => res(new CDP(ws));
      ws.onerror = (e) => rej(new Error("ws error " + e.message));
    });
  }
  onMessage(data) {
    const msg = JSON.parse(data.toString());
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
}

/* ---------------- helpers ---------------- */
const sleep = (ms) => delay(ms);

async function waitForCDP() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return (await r.json()).webSocketDebuggerUrl;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error("Chrome DevTools endpoint never came up");
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true }); // clean profile => empty localStorage

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1400,900",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ], { stdio: "ignore" });

  const shots = [];
  const errors = [];
  let cdp, session;

  try {
    const browserWs = await waitForCDP();
    cdp = await CDP.connect(browserWs);
    cdp.ws.onmessage = (e) => {
      const raw = typeof e.data === "string" ? e.data : String(e.data);
      let msg = null;
      try { msg = JSON.parse(raw); } catch { /* not json */ }
      if (msg) {
        if (msg.method === "Runtime.exceptionThrown") {
          errors.push("exception: " + JSON.stringify(msg.params.exceptionDetails.text || msg.params.exceptionDetails));
        }
        if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
          errors.push("console.error: " + msg.params.args.map((a) => a.value || a.description || "").join(" "));
        }
      }
      cdp.onMessage(raw);
    };

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    session = sessionId;

    await cdp.send("Page.enable", {}, session);
    await cdp.send("Runtime.enable", {}, session);
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, session);

    const evalPage = async (expression) => {
      const r = await cdp.send("Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: true }, session);
      if (r.exceptionDetails) throw new Error("page error: " + JSON.stringify(r.exceptionDetails.exception));
      return r.result.value;
    };

    const waitFor = async (expression, label, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        if (await evalPage(expression)) return;
        await sleep(150);
      }
      throw new Error("timeout waiting for: " + label);
    };

    const shot = async (name) => {
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
      const file = join(OUT, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      shots.push(name);
      console.log("  captured " + name);
    };

    // ---- drive the real UI (same handlers a user triggers) ----
    const UI = `
      window.__ui = {
        click(sel, idx = 0) { const el = document.querySelectorAll(sel)[idx]; if (!el) throw new Error("no el " + sel + " #" + idx); el.click(); },
        type(sel, text) { const el = document.querySelector(sel); if (!el) throw new Error("no el " + sel); el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); },
        set(sel, text) { const el = document.querySelector(sel); if (!el) throw new Error("no el " + sel); el.value = text; },
        esc() { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); },
        cards() { return [...document.querySelectorAll(".note-title")].map(t => t.textContent); }
      };`;

    const createNote = async (n) => {
      await evalPage(UI);
      await evalPage(`__ui.click('#newNoteBtn')`);
      await waitFor(`!document.getElementById("noteOverlay").hidden`, "modal open");
      await evalPage(`__ui.type('#noteTitle', ${JSON.stringify(n.title)})`);
      await evalPage(`__ui.type('#noteContent', ${JSON.stringify(n.content)})`);
      await evalPage(`__ui.set('#noteFolder', ${JSON.stringify(n.folder)})`);
      await evalPage(`__ui.type('#noteTags', ${JSON.stringify(n.tags)})`);
      if (n.pinned) await evalPage(`__ui.click('#notePin')`);
      await evalPage(`__ui.click('#saveNote')`);
      await waitFor(`document.getElementById("noteOverlay").hidden`, "modal closed");
    };

    /* ============ 1. fresh profile -> empty state ============ */
    console.log("Loading app (clean profile)...");
    await cdp.send("Page.navigate", { url: APP }, session);
    await waitFor(`document.readyState === "complete"`, "page load");
    await waitFor(`!!window.SmartNotes`, "app booted");
    await evalPage(`localStorage.clear()`);
    await cdp.send("Page.navigate", { url: APP }, session);
    await waitFor(`document.readyState === "complete" && !!window.SmartNotes`, "reload");
    await shot("01-empty-state.png");

    /* ============ 2. create notes through the form ============ */
    console.log("Creating notes through the UI...");
    await createNote({
      title: "DBMS Unit 3 - Normalization",
      content: "1NF, 2NF, 3NF rules. A relation is in 3NF if it is in 2NF and no transitive dependency exists.",
      folder: "College", tags: "exam, dbms, unit3", pinned: false,
    });
    await createNote({
      title: "Lab Manual Draft (Final)",
      content: "Experiment 4 - stack implementation using arrays. Aim, algorithm, output and conclusion added.",
      folder: "Assignments", tags: "lab, semester4", pinned: true,
    });
    await createNote({
      title: "Semester Exam Timetable",
      content: "Exam schedule released: DBMS on 12th, OS on 15th. Reach the hall 30 minutes early.",
      folder: "Personal", tags: "exam, schedule", pinned: false,
    });
    await waitFor(`document.querySelectorAll(".note-card").length === 3`, "3 notes rendered");
    await sleep(2600); // let the toast disappear
    await shot("02-dashboard.png");

    /* ============ 3. search (content) + no-results state ============ */
    console.log("Searching...");
    await evalPage(UI);
    await evalPage(`__ui.type('#searchInput', 'stack')`);
    await waitFor(`document.querySelectorAll(".note-card").length === 1`, "search filtered");
    await sleep(350);
    await shot("03-search-results.png");
    await evalPage(`__ui.type('#searchInput', 'zzz-no-such-note')`);
    await waitFor(`document.querySelectorAll(".note-card").length === 0`, "no matches");
    await waitFor(`!document.getElementById("noResults").hidden`, "no-results state");
    await sleep(300);
    await shot("04-search-no-results.png");
    await evalPage(`__ui.click('#resetFiltersBtn')`);
    await waitFor(`document.querySelectorAll(".note-card").length === 3`, "filters reset");

    /* ============ 4. new-note modal ============ */
    await evalPage(`__ui.click('#newNoteBtn')`);
    await waitFor(`!document.getElementById("noteOverlay").hidden`, "modal open");
    await evalPage(`__ui.type('#noteTitle', 'Web Tech Viva — quick revision')`);
    await evalPage(`__ui.type('#noteContent', 'HTML semantics, CSS box model, JS events, DOM methods.')`);
    await evalPage(`__ui.set('#noteFolder', 'College')`);
    await evalPage(`__ui.type('#noteTags', 'viva, webtech')`);
    await shot("06-new-note-modal.png");
    await evalPage(`__ui.esc()`);
    await waitFor(`document.getElementById("noteOverlay").hidden`, "modal closed with Escape");

    /* ============ 5. folder filter ============ */
    console.log("Filtering by folder...");
    await evalPage(`__ui.click('#folderList [data-folder="College"]')`);
    await waitFor(`document.querySelectorAll(".note-card").length === 1`, "folder filtered");
    await waitFor(`document.getElementById("crumb").textContent === "College"`, "folder heading");
    await shot("05-folder-filter.png");
    await evalPage(`__ui.click('#libraryList [data-view="all"]')`);
    await waitFor(`document.querySelectorAll(".note-card").length === 3`, "back to all notes");

    /* ============ 6. delete confirmation ============ */
    console.log("Opening delete confirmation...");
    const victimIdx = await evalPage(
      `[...document.querySelectorAll(".note-card")].findIndex(c => c.querySelector(".note-title").textContent.startsWith("DBMS"))`);
    await evalPage(`__ui.click('.note-card [data-action="delete"]', ${victimIdx})`);
    await waitFor(`!document.getElementById("confirmOverlay").hidden`, "confirm dialog");
    const confirmText = await evalPage(`document.getElementById("confirmText").textContent`);
    console.log("  confirm:", confirmText);
    await shot("07-delete-confirmation.png");
    await evalPage(`__ui.click('#confirmOk')`);
    await waitFor(`document.getElementById("confirmOverlay").hidden`, "confirm closed");
    await waitFor(`document.getElementById("countTrash").textContent === "1"`, "note in trash");

    /* ============ 7. trash view ============ */
    await evalPage(`__ui.click('#libraryList [data-view="trash"]')`);
    await waitFor(`document.querySelectorAll(".note-card.trashed").length === 1`, "trash view");
    await shot("08-trash-view.png");

    /* ============ 8. permanent delete -> empty trash state ============ */
    await evalPage(`__ui.click('.note-card [data-action="purge"]')`);
    await waitFor(`!document.getElementById("confirmOverlay").hidden`, "purge confirm");
    await evalPage(`__ui.click('#confirmOk')`);
    await waitFor(`document.getElementById("countTrash").textContent === "0"`, "trash emptied");
    await waitFor(`!document.getElementById("emptyState").hidden`, "trash empty state");
    await shot("09-trash-empty-state.png");

    // put the demo note back so the final dataset has 3 notes again
    await evalPage(`__ui.click('#libraryList [data-view="all"]')`);
    await createNote({
      title: "DBMS Unit 3 - Normalization",
      content: "1NF, 2NF, 3NF rules. A relation is in 3NF if it is in 2NF and no transitive dependency exists.",
      folder: "College", tags: "exam, dbms, unit3", pinned: false,
    });
    await waitFor(`document.querySelectorAll(".note-card").length === 3`, "3 notes restored");
    await sleep(2600);

    /* ============ 9. persistence: full reload ============ */
    console.log("Reloading to verify persistence...");
    await cdp.send("Page.navigate", { url: APP }, session);
    await waitFor(`document.readyState === "complete" && !!window.SmartNotes`, "reload");
    const persisted = await evalPage(`({
      cards: document.querySelectorAll(".note-card").length,
      titles: [...document.querySelectorAll(".note-title")].map(t => t.textContent),
      pinned: document.querySelectorAll(".note-card.pinned").length,
      folders: JSON.parse(localStorage.getItem("smartnotes.v1.folders") || "[]"),
      bytes: (localStorage.getItem("smartnotes.v1.notes") || "").length
    })`);
    console.log("  after reload:", JSON.stringify(persisted));
    if (persisted.cards !== 3) throw new Error("persistence failed: " + persisted.cards);

    /* ============ 10. mobile viewport ============ */
    console.log("Capturing mobile viewport...");
    await cdp.send("Emulation.setDeviceMetricsOverride",
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, session);
    await sleep(400);
    const mobile = await evalPage(`({
      fab: getComputedStyle(document.getElementById("fab")).display,
      sidebarStatic: getComputedStyle(document.getElementById("sidebar")).position,
      newBtnHidden: getComputedStyle(document.getElementById("newNoteBtn")).display === "none",
      overflowX: document.documentElement.scrollWidth > window.innerWidth
    })`);
    console.log("  mobile layout:", JSON.stringify(mobile));
    await shot("10-mobile-view.png");
    await cdp.send("Emulation.clearDeviceMetricsOverride", {}, session);

    console.log("\nDONE. screenshots:", shots.join(", "));
    if (errors.length) console.log("PAGE ERRORS:", errors);
    else console.log("No page errors observed.");
  } finally {
    try { cdp && cdp.ws.close(); } catch { /* ignore */ }
    chrome.kill();
    await sleep(300);
    rmSync(PROFILE, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
