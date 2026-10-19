/* =========================================================
   Smart Notes — application script (vanilla JS)
   Persistence: browser localStorage
   ========================================================= */
(function () {
  "use strict";

  /* ---------------- Storage keys & helpers ---------------- */
  var NOTES_KEY = "smartnotes.v1.notes";
  var FOLDERS_KEY = "smartnotes.v1.folders";
  var UI_KEY = "smartnotes.v1.ui";
  var AI_SETTINGS_KEY = "smartnotes.v1.ai_settings";
  var AI_HISTORY_KEY = "smartnotes.v1.ai_history";

  var DEFAULT_FOLDERS = ["Personal", "College", "Assignments", "Ideas"];
  var DEFAULT_AI_SETTINGS = { engine: "local", apiKey: "", model: "" };

  function safeGet(key) {
    try { return localStorage.getItem(key); }
    catch (e) { console.warn("localStorage read failed:", e); return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (e) { console.warn("localStorage write failed:", e); toast("Could not save to localStorage"); return false; }
  }

  function loadJSON(key, fallback) {
    var raw = safeGet(key);
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
      console.warn("Corrupt data in " + key + ", resetting.", e);
      return fallback;
    }
  }

  function uid() {
    return "n" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* Escape user text before inserting into innerHTML */
  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------------- State ---------------- */
  var notes = loadJSON(NOTES_KEY, []);
  var folders = loadJSON(FOLDERS_KEY, DEFAULT_FOLDERS.slice());

  var ui = { view: "all", folder: null, tag: null, query: "", sort: "updated" };
  try {
    var savedUI = JSON.parse(safeGet(UI_KEY) || "null");
    if (savedUI && typeof savedUI === "object") {
      ui.view = savedUI.view || "all";
      ui.folder = savedUI.folder || null;
      ui.tag = savedUI.tag || null;
      ui.sort = savedUI.sort || "updated";
    }
  } catch (e) { /* ignore */ }

  var editingId = null;      // note id being edited, null = creating
  var pendingConfirm = null; // callback for confirm dialog
  var toastTimer = null;

  var aiSettings = Object.assign({}, DEFAULT_AI_SETTINGS);
  try {
    var savedAi = JSON.parse(safeGet(AI_SETTINGS_KEY) || "null");
    if (savedAi && typeof savedAi === "object") {
      aiSettings = Object.assign({}, DEFAULT_AI_SETTINGS, savedAi);
    }
  } catch (e) { /* ignore */ }

  var currentSummaryNoteId = null;

  /* ---------------- DOM refs ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var notesGrid = $("notesGrid");
  var searchInput = $("searchInput");
  var clearSearch = $("clearSearch");

  /* ---------------- Persistence ---------------- */
  function saveNotes() {
    safeSet(NOTES_KEY, JSON.stringify(notes));
    updateCounts();
  }
  function saveFolders() {
    safeSet(FOLDERS_KEY, JSON.stringify(folders));
    renderFolders();
    updateCounts();
  }
  function saveUI() {
    safeSet(UI_KEY, JSON.stringify({ view: ui.view, folder: ui.folder, tag: ui.tag, sort: ui.sort }));
  }

  /* ---------------- Toast ---------------- */
  function toast(msg) {
    var el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    // force reflow so the transition restarts
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { el.hidden = true; }, 260);
    }, 2200);
  }

  /* ---------------- Confirm dialog ---------------- */
  function confirmAction(opts, onOk) {
    $("confirmTitle").textContent = opts.title || "Are you sure?";
    $("confirmText").textContent = opts.text || "";
    $("confirmOk").textContent = opts.okText || "Delete";
    $("confirmOk").className = "btn " + (opts.danger === false ? "btn-primary" : "btn-danger");
    $("confirmIcon").textContent = opts.icon || "\uD83D\uDDD1\uFE0F";
    pendingConfirm = onOk;
    $("confirmOverlay").hidden = false;
    $("confirmCancel").focus();
  }
  function closeConfirm() {
    $("confirmOverlay").hidden = true;
    pendingConfirm = null;
  }
  $("confirmCancel").addEventListener("click", closeConfirm);
  $("confirmOk").addEventListener("click", function () {
    var cb = pendingConfirm;
    closeConfirm();
    if (typeof cb === "function") cb();
  });
  $("confirmOverlay").addEventListener("click", function (e) {
    if (e.target === this) closeConfirm();
  });

  /* ---------------- Text prompt dialog (used for folder names) ---------------- */
  var promptCallback = null;

  function askForText(opts, cb) {
    $("promptTitle").textContent = opts.title || "Enter a value";
    $("promptHint").textContent = opts.hint || "";
    $("promptInput").value = opts.value || "";
    $("promptInput").placeholder = opts.placeholder || "";
    $("promptOk").textContent = opts.okText || "OK";
    $("promptErr").hidden = true;
    $("promptInput").classList.remove("invalid");
    promptCallback = cb;
    $("promptOverlay").hidden = false;
    setTimeout(function () {
      var el = $("promptInput");
      el.focus();
      el.select();
    }, 40);
  }

  function closePrompt(result) {
    if ($("promptOverlay").hidden) return;
    $("promptOverlay").hidden = true;
    var cb = promptCallback;
    promptCallback = null;
    if (typeof cb === "function") cb(result);
  }

  function submitPrompt() {
    var val = $("promptInput").value.trim();
    if (!val) {
      $("promptErr").hidden = false;
      $("promptInput").classList.add("invalid");
      $("promptInput").focus();
      return;
    }
    closePrompt(val);
  }

  $("promptOk").addEventListener("click", submitPrompt);
  $("promptCancel").addEventListener("click", function () { closePrompt(null); });
  $("promptOverlay").addEventListener("click", function (e) { if (e.target === this) closePrompt(null); });
  $("promptInput").addEventListener("input", function () {
    if (this.value.trim()) {
      $("promptErr").hidden = true;
      this.classList.remove("invalid");
    }
  });
  $("promptInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submitPrompt(); }
  });

  /* ---------------- Filtering / sorting ---------------- */
  function activeNotes() { return notes.filter(function (n) { return !n.trashed; }); }

  function matchesSearch(n, q) {
    if (!q) return true;
    var hay = (n.title + " " + n.content + " " + (n.tags || []).join(" ")).toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function getVisibleNotes() {
    var q = ui.query.trim().toLowerCase();
    var list = notes.filter(function (n) {
      if (ui.view === "trash") { if (!n.trashed) return false; }
      else if (n.trashed) return false;

      if (ui.view === "pinned" && !n.pinned) return false;
      if (ui.folder && n.folder !== ui.folder) return false;
      if (ui.tag && (n.tags || []).indexOf(ui.tag) === -1) return false;
      return matchesSearch(n, q);
    });

    list.sort(function (a, b) {
      // Pinned first (except in trash view)
      if (ui.view !== "trash") {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      }
      if (ui.sort === "title") return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
      if (ui.sort === "created") return b.createdAt - a.createdAt;
      return b.updatedAt - a.updatedAt;
    });
    return list;
  }

  /* ---------------- Rendering ---------------- */
  function formatTime(ts) {
    var d = new Date(ts), now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (sameDay) return "Today, " + time;
    var yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return "Yesterday, " + time;
    return d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }

  function noteCardHTML(n) {
    var preview = n.content
      ? esc(n.content)
      : "<span class='note-preview placeholder'>No content</span>";

    var tagsHTML = (n.tags && n.tags.length)
      ? "<div class='note-tags'>" + n.tags.map(function (t) {
          return "<span class='note-tag'>#" + esc(t) + "</span>";
        }).join("") + "</div>"
      : "";

    if (ui.view === "trash") {
      return "<article class='note-card trashed' data-id='" + n.id + "'>" +
        "<h3 class='note-title'>" + esc(n.title) + "</h3>" +
        "<div class='note-preview'>" + preview + "</div>" +
        tagsHTML +
        "<div class='note-meta'><span>Deleted " + formatTime(n.updatedAt) + "</span></div>" +
        "<div class='trash-actions'>" +
          "<button class='btn btn-secondary' data-action='restore'>↺ Restore</button>" +
          "<button class='btn btn-danger' data-action='purge'>Delete forever</button>" +
        "</div>" +
      "</article>";
    }

    var previewEl = n.content
      ? "<div class='note-preview'>" + preview + "</div>"
      : "<div class='note-preview placeholder'>No content</div>";

    var wordCount = (n.content || "").trim().split(/\s+/).filter(Boolean).length;
    var readMins = Math.max(1, Math.ceil(wordCount / 180));
    var readBadge = wordCount > 0 ? "<span class='read-badge' title='Estimated reading time'>&#9889; " + readMins + "m</span>" : "";

    return "<article class='note-card" + (n.pinned ? " pinned" : "") + "' data-id='" + n.id + "'>" +
      (n.pinned ? "<div class='pin-badge' title='Pinned'>&#128204;</div>" : "") +
      "<h3 class='note-title'>" + esc(n.title) + "</h3>" +
      previewEl +
      tagsHTML +
      "<div class='note-meta'>" +
        "<span class='note-folder' title='Folder: " + esc(n.folder || "Unfiled") + "'>" +
          "<span class='folder-dot'></span>" + esc(n.folder || "Unfiled") + "</span>" +
        "<span>" + (readBadge ? readBadge + " " : "") + formatTime(n.updatedAt) + "</span>" +
      "</div>" +
      "<div class='note-actions'>" +
        "<button class='act-btn ai-act' data-action='ai-summary' title='AI Summary & Insights'>&#10024;</button>" +
        "<button class='act-btn" + (n.pinned ? " on" : "") + "' data-action='pin' title='" +
          (n.pinned ? "Unpin" : "Pin") + "'>&#128204;</button>" +
        "<button class='act-btn' data-action='edit' title='Edit'>&#9998;</button>" +
        "<button class='act-btn danger' data-action='delete' title='Delete'>&#128465;</button>" +
      "</div>" +
    "</article>";
  }

  function getHeading() {
    if (ui.view === "trash") return "Trash";
    if (ui.view === "pinned") return "Pinned Notes";
    if (ui.folder) return ui.folder;
    return "All Notes";
  }

  function render() {
    var list = getVisibleNotes();
    var hasQueryOrTag = !!ui.query.trim() || !!ui.tag;

    notesGrid.innerHTML = list.map(noteCardHTML).join("");

    // Count + heading
    $("crumb").textContent = getHeading();
    $("resultCount").textContent = list.length + (list.length === 1 ? " note" : " notes");

    // Empty states: friendly per-view message when no search/tag filter is on,
    // "no results" message when a search or tag filter hid everything.
    var showEmpty = list.length === 0 && !hasQueryOrTag;
    var showNoResults = list.length === 0 && hasQueryOrTag;
    $("emptyState").hidden = !showEmpty;
    $("noResults").hidden = !showNoResults;

    if (showEmpty) {
      if (ui.view === "trash") {
        $("emptyTitle").textContent = "Trash is empty";
        $("emptyText").textContent = "Deleted notes will appear here before you remove them forever.";
        $("emptyAction").hidden = true;
      } else if (ui.view === "pinned") {
        $("emptyTitle").textContent = "No pinned notes";
        $("emptyText").textContent = "Pin important notes with the 📌 button to find them quickly.";
        $("emptyAction").hidden = false;
        $("emptyAction").textContent = "+ Create a note";
      } else if (ui.folder) {
        $("emptyTitle").textContent = "This folder is empty";
        $("emptyText").textContent = "Add a note and choose this folder to organise it here.";
        $("emptyAction").hidden = false;
        $("emptyAction").textContent = "+ Create a note";
      } else {
        $("emptyTitle").textContent = "No notes yet";
        $("emptyText").textContent = "Create your first note and it will be saved automatically in your browser.";
        $("emptyAction").hidden = false;
        $("emptyAction").textContent = "+ Create your first note";
      }
    }

    if (showNoResults) {
      var bits = [];
      if (ui.query.trim()) bits.push('search "' + ui.query.trim() + '"');
      if (ui.folder) bits.push("folder “" + ui.folder + "”");
      if (ui.tag) bits.push("tag “" + ui.tag + "”");
      $("noResultsText").textContent = "No notes match " + bits.join(", ") + ".";
    }

    renderActiveFilters();
    renderTags();
    updateCounts();
    saveUI();
  }

  function renderActiveFilters() {
    var box = $("activeFilters");
    var pills = [];
    if (ui.query.trim()) pills.push("<span class='filter-pill'>Search: <b>" + esc(ui.query.trim()) + "</b><button data-clear='query' title='Clear search'>&#10005;</button></span>");
    if (ui.folder) pills.push("<span class='filter-pill'>Folder: <b>" + esc(ui.folder) + "</b><button data-clear='folder' title='Clear folder'>&#10005;</button></span>");
    if (ui.tag) pills.push("<span class='filter-pill'>Tag: <b>#" + esc(ui.tag) + "</b><button data-clear='tag' title='Clear tag'>&#10005;</button></span>");
    box.innerHTML = pills.join("");
    box.hidden = pills.length === 0;
  }

  function renderFolders() {
    var list = $("folderList");
    list.innerHTML = folders.map(function (f) {
      var count = activeNotes().filter(function (n) { return n.folder === f; }).length;
      var active = ui.folder === f && ui.view === "folder" ? " active" : "";
      return "<li class='side-row'>" +
        "<button class='side-item" + active + "' data-folder='" + esc(f) + "'>" +
          "<span class='folder-dot'></span>" + esc(f) +
          "<span class='count'>" + count + "</span>" +
        "</button>" +
        "<button class='folder-del' data-folder-del='" + esc(f) + "' title='Delete folder' aria-label='Delete folder " + esc(f) + "'>&#10005;</button>" +
      "</li>";
    }).join("");
    $("folderEmpty").hidden = folders.length > 0;
  }

  function renderTags() {
    var counts = {};
    activeNotes().forEach(function (n) {
      (n.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
    });
    var names = Object.keys(counts).sort();
    var box = $("tagCloud");
    box.innerHTML = names.map(function (t) {
      var active = ui.tag === t ? " active" : "";
      return "<button class='tag-chip" + active + "' data-tag='" + esc(t) + "'>#" + esc(t) +
        "<span class='t-count'>" + counts[t] + "</span></button>";
    }).join("");
    $("tagEmpty").hidden = names.length > 0;
  }

  function updateCounts() {
    $("countAll").textContent = activeNotes().length;
    $("countPinned").textContent = activeNotes().filter(function (n) { return n.pinned; }).length;
    $("countTrash").textContent = notes.filter(function (n) { return n.trashed; }).length;
    document.querySelectorAll("#libraryList .side-item").forEach(function (btn) {
      btn.classList.toggle("active", !ui.folder && btn.dataset.view === ui.view);
    });
    renderFolders();
  }

  /* ---------------- Modal (create / edit) ---------------- */
  function populateFolderSelect(selected) {
    var sel = $("noteFolder");
    var opts = ["<option value=''>Unfiled</option>"].concat(
      folders.map(function (f) {
        return "<option value='" + esc(f) + "'" + (f === selected ? " selected" : "") + ">" + esc(f) + "</option>";
      })
    );
    sel.innerHTML = opts.join("");
    if (selected && folders.indexOf(selected) === -1) {
      sel.innerHTML += "<option value='" + esc(selected) + "' selected>" + esc(selected) + " (folder removed)</option>";
    }
  }

  function updateContentStats() {
    var val = ($("noteContent").value || "").trim();
    var words = val ? val.split(/\s+/).filter(Boolean).length : 0;
    var mins = Math.max(1, Math.ceil(words / 180));
    $("contentStats").textContent = words + " word" + (words === 1 ? "" : "s") + " \u2022 " + (words ? mins : 0) + " min read";
  }

  function openModal(note) {
    editingId = note ? note.id : null;
    $("modalTitle").textContent = note ? "Edit Note" : "New Note";
    $("saveNote").textContent = note ? "Update Note" : "Save Note";
    $("noteTitle").value = note ? note.title : "";
    $("noteContent").value = note ? note.content : "";
    $("noteTags").value = note && note.tags ? note.tags.join(", ") : "";
    $("notePin").checked = note ? !!note.pinned : false;
    populateFolderSelect(note ? note.folder : (ui.folder || ""));
    $("titleErr").hidden = true;
    $("noteTitle").classList.remove("invalid");
    $("aiModalStatus").hidden = true;
    updateContentStats();
    $("noteOverlay").hidden = false;
    setTimeout(function () { $("noteTitle").focus(); }, 40);
  }

  function closeModal() {
    $("noteOverlay").hidden = true;
    $("aiModalStatus").hidden = true;
    editingId = null;
    $("noteForm").reset();
  }

  function parseTags(raw) {
    var seen = {};
    return String(raw || "").split(",").map(function (t) {
      return t.trim().replace(/^#+/, "");
    }).filter(function (t) {
      if (!t) return false;
      var k = t.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  $("noteForm").addEventListener("submit", function (e) {
    e.preventDefault();
    var title = $("noteTitle").value.trim();
    if (!title) {
      $("titleErr").hidden = false;
      $("noteTitle").classList.add("invalid");
      $("noteTitle").focus();
      return;
    }
    var now = Date.now();
    var data = {
      title: title,
      content: $("noteContent").value.trim(),
      folder: $("noteFolder").value,
      tags: parseTags($("noteTags").value),
      pinned: $("notePin").checked,
      updatedAt: now
    };

    if (editingId) {
      var n = notes.find(function (x) { return x.id === editingId; });
      if (n) {
        Object.keys(data).forEach(function (k) { n[k] = data[k]; });
        toast("Note updated");
      }
    } else {
      data.id = uid();
      data.createdAt = now;
      data.trashed = false;
      notes.unshift(data);
      toast("Note created");
    }

    saveNotes();
    closeModal();
    render();
  });

  $("closeModal").addEventListener("click", closeModal);
  $("cancelModal").addEventListener("click", closeModal);
  $("noteOverlay").addEventListener("click", function (e) { if (e.target === this) closeModal(); });
  $("noteTitle").addEventListener("input", function () {
    if (this.value.trim()) {
      $("titleErr").hidden = true;
      this.classList.remove("invalid");
    }
  });
  $("noteContent").addEventListener("input", updateContentStats);

  /* ---------------- Note actions ---------------- */
  function findNote(id) { return notes.find(function (n) { return n.id === id; }); }

  notesGrid.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (!btn) return;
    var card = btn.closest(".note-card");
    if (!card) return;
    var id = card.dataset.id;
    var note = findNote(id);
    if (!note) return;
    var action = btn.dataset.action;

    if (action === "ai-summary") {
      openAiSummary(note);
    }
    else if (action === "pin") {
      note.pinned = !note.pinned;
      note.updatedAt = Date.now();
      saveNotes();
      render();
      toast(note.pinned ? "Note pinned" : "Note unpinned");
    }
    else if (action === "edit") {
      openModal(note);
    }
    else if (action === "delete") {
      confirmAction({
        title: "Delete this note?",
        text: "“" + note.title + "” will be moved to Trash. You can restore it later.",
        okText: "Delete"
      }, function () {
        note.trashed = true;
        note.pinned = false;
        note.updatedAt = Date.now();
        saveNotes();
        render();
        toast("Note moved to Trash");
      });
    }
    else if (action === "restore") {
      note.trashed = false;
      note.updatedAt = Date.now();
      saveNotes();
      render();
      toast("Note restored");
    }
    else if (action === "purge") {
      confirmAction({
        title: "Delete forever?",
        text: "“" + note.title + "” will be permanently removed. This cannot be undone.",
        okText: "Delete forever"
      }, function () {
        notes = notes.filter(function (n) { return n.id !== id; });
        saveNotes();
        render();
        toast("Note permanently deleted");
      });
    }
  });

  /* ---------------- Sidebar interactions ---------------- */
  $("libraryList").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-view]");
    if (!btn) return;
    ui.view = btn.dataset.view;
    ui.folder = null;
    render();
  });

  $("folderList").addEventListener("click", function (e) {
    var del = e.target.closest("[data-folder-del]");
    if (del) {
      e.stopPropagation();
      var name = del.dataset.folderDel;
      var count = activeNotes().filter(function (n) { return n.folder === name; }).length;
      confirmAction({
        title: "Delete folder?",
        text: "The folder “" + name + "” will be removed." +
              (count ? " Its " + count + " note" + (count === 1 ? "" : "s") + " will move to Unfiled." : ""),
        okText: "Delete folder"
      }, function () {
        folders = folders.filter(function (f) { return f !== name; });
        notes.forEach(function (n) { if (n.folder === name) n.folder = ""; });
        if (ui.folder === name) { ui.folder = null; ui.view = "all"; }
        saveFolders();
        saveNotes();
        render();
        toast("Folder deleted");
      });
      return;
    }
    var btn = e.target.closest("[data-folder]");
    if (!btn) return;
    ui.view = "folder";
    ui.folder = btn.dataset.folder;
    ui.tag = null;
    render();
  });

  $("tagCloud").addEventListener("click", function (e) {
    var chip = e.target.closest("[data-tag]");
    if (!chip) return;
    var t = chip.dataset.tag;
    ui.tag = (ui.tag === t) ? null : t;
    if (ui.tag && ui.view === "trash") ui.view = "all";
    render();
  });

  $("addFolderBtn").addEventListener("click", function () {
    askForText({
      title: "New folder",
      hint: "Give your folder a short, unique name.",
      placeholder: "e.g. Projects",
      okText: "Create folder"
    }, function (name) {
      if (name === null) return; // cancelled
      if (!name) { toast("Folder name cannot be empty"); return; }
      if (folders.some(function (f) { return f.toLowerCase() === name.toLowerCase(); })) {
        toast("That folder already exists");
        return;
      }
      folders.push(name);
      saveFolders();
      toast("Folder “" + name + "” created");
    });
  });

  $("clearAllBtn").addEventListener("click", function () {
    var t = notes.filter(function (n) { return n.trashed; });
    if (!t.length) { toast("Trash is already empty"); return; }
    confirmAction({
      title: "Empty trash?",
      text: (t.length === 1 ? "The 1 note" : "All " + t.length + " notes") + " in Trash will be permanently deleted.",
      okText: "Empty trash"
    }, function () {
      notes = notes.filter(function (n) { return !n.trashed; });
      saveNotes();
      render();
      toast("Trash emptied");
    });
  });

  /* ---------------- Search / sort / filters ---------------- */
  var searchTimer = null;
  searchInput.addEventListener("input", function () {
    ui.query = this.value;
    clearSearch.hidden = !this.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 120);
  });
  clearSearch.addEventListener("click", function () {
    searchInput.value = "";
    ui.query = "";
    clearSearch.hidden = true;
    searchInput.focus();
    render();
  });
  $("sortSelect").addEventListener("change", function () {
    ui.sort = this.value;
    render();
  });
  $("activeFilters").addEventListener("click", function (e) {
    var b = e.target.closest("[data-clear]");
    if (!b) return;
    var what = b.dataset.clear;
    if (what === "query") { ui.query = ""; searchInput.value = ""; clearSearch.hidden = true; }
    if (what === "folder") { ui.folder = null; ui.view = "all"; }
    if (what === "tag") { ui.tag = null; }
    render();
  });
  $("resetFiltersBtn").addEventListener("click", function () {
    ui.query = ""; searchInput.value = ""; clearSearch.hidden = true;
    ui.folder = null; ui.tag = null; ui.view = "all";
    render();
    toast("Filters cleared");
  });

  /* ---------------- Natural Language Processing & AI Engine ---------------- */
  var STOP_WORDS = new Set([
    "a","about","above","after","again","against","all","am","an","and","any","are","arent","as","at",
    "be","because","been","before","being","below","between","both","but","by","cant","cannot","could",
    "couldnt","did","didnt","do","does","doesnt","doing","dont","down","during","each","few","for",
    "from","further","had","hadnt","has","hasnt","have","havent","having","he","hed","hell","hes",
    "her","here","heres","hers","herself","him","himself","his","how","hows","i","id","ill","im","ive",
    "if","in","into","is","isnt","it","its","itself","lets","me","more","most","mustnt","my","myself",
    "no","nor","not","of","off","on","once","only","or","other","ought","our","ours","ourselves","out",
    "over","own","same","shant","she","shed","shell","shes","should","shouldnt","so","some","such",
    "than","that","thats","the","their","theirs","them","themselves","then","there","theres","these",
    "they","theyd","theyll","theyre","theyve","this","those","through","to","too","under","until","up",
    "very","was","wasnt","we","wed","well","were","weve","werent","what","whats","when","whens","where",
    "wheres","which","while","who","whos","whom","why","whys","with","wont","would","wouldnt","you",
    "youd","youll","youre","youve","your","yours","yourself","yourselves","will","shall","can","just",
    "also","note","notes","write","wrote","using","used","use"
  ]);

  var SmartAI = {
    extractKeywords: function (text, maxCount) {
      if (!text) return [];
      maxCount = maxCount || 4;
      var clean = text.toLowerCase().replace(/[^a-z0-9_\-\s]/g, " ");
      var words = clean.split(/\s+/).filter(function (w) {
        return w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w);
      });
      var counts = {};
      words.forEach(function (w) { counts[w] = (counts[w] || 0) + 1; });
      return Object.keys(counts)
        .sort(function (a, b) { return counts[b] - counts[a]; })
        .slice(0, maxCount);
    },

    generateTitle: function (content) {
      if (!content || !content.trim()) return "Untitled Note";
      var lines = content.trim().split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var firstLine = lines[0] || "";
      firstLine = firstLine.replace(/^[#*\-•\d\.\s]+/, "").trim();
      if (firstLine.length >= 4 && firstLine.length <= 60) {
        return firstLine.charAt(0).toUpperCase() + firstLine.slice(1);
      }
      var keywords = SmartAI.extractKeywords(content, 3);
      if (keywords.length > 0) {
        var joined = keywords.map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(" & ");
        return joined + " Notes";
      }
      return firstLine.slice(0, 45) + "...";
    },

    generateSummary: function (text, maxSentences) {
      if (!text || !text.trim()) return "No content to summarize.";
      maxSentences = maxSentences || 2;
      var sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [text];
      sentences = sentences.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 12; });
      if (sentences.length <= maxSentences) return sentences.join(" ");

      var keywords = SmartAI.extractKeywords(text, 10);
      var keySet = new Set(keywords);

      var scored = sentences.map(function (s, idx) {
        var words = s.toLowerCase().split(/\s+/);
        var score = 0;
        words.forEach(function (w) {
          if (keySet.has(w)) score += 2;
        });
        if (idx === 0) score += 3.5;
        if (idx === 1) score += 1.5;
        if (words.length >= 8 && words.length <= 35) score += 1;
        return { text: s, score: score, index: idx };
      });

      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored.slice(0, maxSentences).sort(function (a, b) { return a.index - b.index; });
      return top.map(function (item) { return item.text; }).join(" ");
    },

    extractActionItems: function (text) {
      if (!text) return [];
      var lines = text.split("\n");
      var tasks = [];
      var taskRegex = /(?:^|\s)(?:TODO|FIXME|TASK|DUE|DEADLINE|ACTION)[\s:]+(.+)$/i;
      var checkboxRegex = /^\s*[-*]\s*\[[\sxX]?\]\s*(.+)$/;
      var imperativeRegex = /^\s*[-*•]?\s*(submit|prepare|review|read|complete|write|finish|study|practice|send|call|email|solve|revise|implement|upload|check)\b\s+(.+)$/i;

      lines.forEach(function (raw) {
        var line = raw.trim();
        var matchCheck = line.match(checkboxRegex);
        if (matchCheck) {
          tasks.push(matchCheck[1].trim());
          return;
        }
        var matchKeyword = line.match(taskRegex);
        if (matchKeyword) {
          tasks.push(matchKeyword[1].trim());
          return;
        }
        var matchImperative = line.match(imperativeRegex);
        if (matchImperative && line.length < 120) {
          tasks.push((matchImperative[1] + " " + matchImperative[2]).trim());
        }
      });
      return Array.from(new Set(tasks));
    },

    polishText: function (text) {
      if (!text || !text.trim()) return text;
      var clean = text
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/ ,/g, ",")
        .replace(/ \./g, ".")
        .replace(/ ;/g, ";")
        .replace(/ :/g, ":");

      clean = clean.replace(/(^|[.!?]\s+)([a-z])/g, function (m, p1, p2) {
        return p1 + p2.toUpperCase();
      });
      return clean.trim();
    },

    formatStudyGuide: function (content, title) {
      var summary = SmartAI.generateSummary(content, 2);
      var keywords = SmartAI.extractKeywords(content, 5);
      var tasks = SmartAI.extractActionItems(content);
      var keyList = keywords.map(function (k) { return "- **" + k.toUpperCase() + "**: Essential topic concept"; }).join("\n");
      var taskList = tasks.length
        ? tasks.map(function (t) { return "- [ ] " + t; }).join("\n")
        : "- [ ] Review core definitions and formulas\n- [ ] Practice chapter sample questions";

      return "## 📚 Study Guide: " + (title || "Subject Notes") + "\n\n" +
        "### 📌 Key Takeaways\n" + summary + "\n\n" +
        "### 💡 Core Concepts & Terminology\n" + (keyList || "- Core concepts to review") + "\n\n" +
        "### 📝 Detailed Notes\n" + (content ? content.trim() : "Add your lesson notes here.") + "\n\n" +
        "### ✅ Review Checklist & Tasks\n" + taskList + "\n\n" +
        "### 🎯 Self-Quiz Questions\n" +
        "1. What is the fundamental principle behind " + (keywords[0] || "this topic") + "?\n" +
        "2. How does " + (keywords[1] || "this concept") + " apply in practical scenarios?\n" +
        "3. Can you summarize the main takeaway in your own words?";
    },

    answerLibraryQuery: function (query, activeNotes) {
      var q = query.trim().toLowerCase();
      if (!activeNotes || activeNotes.length === 0) {
        return "You don't have any notes saved yet! Create your first note, and I will be able to analyze it and answer questions.";
      }

      if (q.includes("task") || q.includes("todo") || q.includes("action") || q.includes("deadline") || q.includes("pending")) {
        var allTasks = [];
        activeNotes.forEach(function (n) {
          var tasks = SmartAI.extractActionItems(n.content);
          tasks.forEach(function (t) {
            allTasks.push({ task: t, note: n.title, folder: n.folder });
          });
        });
        if (allTasks.length === 0) {
          return "I scanned all " + activeNotes.length + " notes in your library and found **no pending tasks or deadlines**. You're all caught up! 🎉";
        }
        var msg = "Here are the **action items and tasks** detected across your notes (" + allTasks.length + " found):\n\n";
        allTasks.forEach(function (item) {
          msg += "- [ ] **" + item.task + "** *(from: *" + item.note + "*" + (item.folder ? " in " + item.folder : "") + ")*\n";
        });
        return msg;
      }

      if (q.includes("summarize all") || q.includes("summary of all") || q.includes("overview of all") || q.includes("all my notes")) {
        var res = "### 📊 Library Overview (" + activeNotes.length + " notes)\n\n";
        var byFolder = {};
        activeNotes.forEach(function (n) {
          var f = n.folder || "Unfiled";
          byFolder[f] = byFolder[f] || [];
          byFolder[f].push(n);
        });
        Object.keys(byFolder).forEach(function (f) {
          res += "#### 📁 " + f + " (" + byFolder[f].length + " notes)\n";
          byFolder[f].slice(0, 3).forEach(function (n) {
            var s = SmartAI.generateSummary(n.content, 1);
            res += "- **" + n.title + "**: " + (s !== "No content to summarize." ? s : "(No content)") + "\n";
          });
          if (byFolder[f].length > 3) res += "- *...and " + (byFolder[f].length - 3) + " more notes*\n";
          res += "\n";
        });
        return res;
      }

      if (q.includes("quiz") || q.includes("flashcard") || q.includes("test me")) {
        var res = "### 🎓 Quick Study Quiz (Generated from your notes)\n\n";
        var sample = activeNotes.slice(0, 4);
        sample.forEach(function (n, i) {
          var kw = SmartAI.extractKeywords(n.content || n.title, 2);
          res += "**Q" + (i + 1) + ": What are the key concepts of *" + n.title + "*?**\n";
          res += "*Hint / Answer:* Key focus is on `" + (kw.join(", ") || n.title) + "`. " + SmartAI.generateSummary(n.content, 1) + "\n\n";
        });
        res += "*(Test yourself by reviewing these points!)*";
        return res;
      }

      if (q.includes("concept") || q.includes("topic") || q.includes("theme")) {
        var allTags = {};
        activeNotes.forEach(function (n) {
          (n.tags || []).forEach(function (t) { allTags[t] = (allTags[t] || 0) + 1; });
          var kws = SmartAI.extractKeywords(n.content, 3);
          kws.forEach(function (k) { allTags[k] = (allTags[k] || 0) + 1; });
        });
        var topTopics = Object.keys(allTags).sort(function (a, b) { return allTags[b] - allTags[a]; }).slice(0, 8);
        return "### 💡 Main Topics & Concepts Across Your Notes\n\n" +
          "Based on your notes, your top study themes are:\n\n" +
          topTopics.map(function (t, i) { return (i + 1) + ". **#" + t + "** (referenced across notes)"; }).join("\n") +
          "\n\n*Tip: Filter notes by clicking on these tags in your sidebar!*";
      }

      var queryTerms = q.split(/\s+/).filter(function (t) { return t.length > 2 && !STOP_WORDS.has(t); });
      var scoredNotes = activeNotes.map(function (n) {
        var score = 0;
        var titleLower = (n.title || "").toLowerCase();
        var contentLower = (n.content || "").toLowerCase();
        var tagsLower = (n.tags || []).join(" ").toLowerCase();

        queryTerms.forEach(function (term) {
          if (titleLower.includes(term)) score += 5;
          if (tagsLower.includes(term)) score += 3;
          if (contentLower.includes(term)) score += 1;
        });
        return { note: n, score: score };
      });

      scoredNotes.sort(function (a, b) { return b.score - a.score; });
      var matches = scoredNotes.filter(function (sn) { return sn.score > 0; }).slice(0, 3);

      if (matches.length === 0) {
        return "I couldn't find a direct match for **\"" + query + "\"** in your current notes.\n\n" +
          "*Suggestions:*\n- Try searching for keywords like topics, course names, or folder names.\n- Ask me to *'Summarize all notes'* or *'Find tasks'*.";
      }

      var ans = "Based on your notes, here is what I found regarding **\"" + query + "\"**:\n\n";
      matches.forEach(function (m) {
        var n = m.note;
        var summary = SmartAI.generateSummary(n.content, 2);
        ans += "📌 **[" + n.title + "]**" + (n.folder ? " *(Folder: " + n.folder + ")*" : "") + "\n";
        ans += summary + "\n\n";
      });

      ans += "*Found in " + matches.length + " relevant note" + (matches.length === 1 ? "" : "s") + ".*";
      return ans;
    }
  };

  /* Lightweight markdown to HTML formatter for AI assistant bubbles */
  function renderMarkdown(md) {
    if (!md) return "";
    var lines = md.split("\n");
    var html = [];
    var inList = false;

    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (!trimmed) {
        if (inList) { html.push("</ul>"); inList = false; }
        return;
      }
      if (trimmed.startsWith("### ")) {
        if (inList) { html.push("</ul>"); inList = false; }
        html.push("<h4>" + esc(trimmed.slice(4)) + "</h4>");
        return;
      }
      if (trimmed.startsWith("#### ")) {
        if (inList) { html.push("</ul>"); inList = false; }
        html.push("<h5>" + esc(trimmed.slice(5)) + "</h5>");
        return;
      }
      if (trimmed.startsWith("- [ ] ") || trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        if (!inList) { html.push("<ul>"); inList = true; }
        var itemContent = trimmed.replace(/^-\s*(\[[ \sxX]?\]\s*)?/, "");
        var isCheck = trimmed.startsWith("- [ ] ");
        var formatted = esc(itemContent)
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
          .replace(/\*(.+?)\*/g, "<em>$1</em>")
          .replace(/`(.+?)`/g, "<code>$1</code>");
        html.push("<li>" + (isCheck ? "<input type='checkbox' disabled /> " : "") + formatted + "</li>");
        return;
      }
      if (inList) { html.push("</ul>"); inList = false; }

      var formatted = esc(trimmed)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/g, "<em>$1</em>")
        .replace(/`(.+?)`/g, "<code>$1</code>");
      html.push("<p>" + formatted + "</p>");
    });

    if (inList) html.push("</ul>");
    return html.join("");
  }

  async function callCloudLLM(prompt, sysInstruction) {
    if (aiSettings.engine === "gemini" && aiSettings.apiKey) {
      var model = aiSettings.model || "gemini-1.5-flash";
      var url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(aiSettings.apiKey);
      var payload = {
        contents: [{
          role: "user",
          parts: [{ text: (sysInstruction ? sysInstruction + "\n\n" : "") + prompt }]
        }]
      };
      var res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error("Gemini HTTP " + res.status);
      var data = await res.json();
      return data.candidates[0].content.parts[0].text;
    }
    if (aiSettings.engine === "openai" && aiSettings.apiKey) {
      var model = aiSettings.model || "gpt-4o-mini";
      var url = "https://api.openai.com/v1/chat/completions";
      var res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + aiSettings.apiKey
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: sysInstruction || "You are a helpful AI study and note assistant." },
            { role: "user", content: prompt }
          ]
        })
      });
      if (!res.ok) throw new Error("OpenAI HTTP " + res.status);
      var data = await res.json();
      return data.choices[0].message.content;
    }
    throw new Error("No cloud engine configured");
  }

  /* ---------------- Note Modal AI Copilot Buttons ---------------- */
  $("aiAutoTitleBtn").addEventListener("click", function () {
    var content = $("noteContent").value.trim();
    if (!content) { toast("Please write some content first"); return; }
    var title = SmartAI.generateTitle(content);
    $("noteTitle").value = title;
    $("titleErr").hidden = true;
    $("noteTitle").classList.remove("invalid");
    toast("\u2728 AI generated title: " + title);
  });

  $("aiAutoTagBtn").addEventListener("click", function () {
    var text = ($("noteTitle").value + " " + $("noteContent").value).trim();
    if (!text) { toast("Please enter title or content first"); return; }
    var tags = SmartAI.extractKeywords(text, 4);
    if (!tags.length) { toast("No keywords found to suggest tags"); return; }
    var current = parseTags($("noteTags").value);
    var merged = current.slice();
    tags.forEach(function (t) {
      if (merged.indexOf(t) === -1) merged.push(t);
    });
    $("noteTags").value = merged.join(", ");
    toast("\uD83C\uDFF7\uFE0F Added suggested tags: " + tags.join(", "));
  });

  $("aiSummarizeBtn").addEventListener("click", function () {
    var content = $("noteContent").value.trim();
    if (!content) { toast("Please write some content first"); return; }
    var summary = SmartAI.generateSummary(content, 2);
    $("noteContent").value = content + "\n\n\uD83D\uDCCC **Key Takeaways:**\n- " + summary;
    updateContentStats();
    toast("\uD83D\uDD22 AI summary added");
  });

  $("aiPolishBtn").addEventListener("click", function () {
    var content = $("noteContent").value.trim();
    if (!content) { toast("Please write some content first"); return; }
    $("noteContent").value = SmartAI.polishText(content);
    updateContentStats();
    toast("\uD83E\uDE84 Content polished for clarity");
  });

  $("aiTasksBtn").addEventListener("click", function () {
    var content = $("noteContent").value.trim();
    if (!content) { toast("Please write some content first"); return; }
    var tasks = SmartAI.extractActionItems(content);
    if (!tasks.length) {
      tasks = ["Review notes for " + ($("noteTitle").value || "this topic"), "Practice sample exercises"];
    }
    var taskText = "\n\n\uD83D\uDCCB **Action Items:**\n" + tasks.map(function (t) { return "- [ ] " + t; }).join("\n");
    $("noteContent").value = content + taskText;
    updateContentStats();
    toast("\u2705 Action items extracted");
  });

  $("aiStudyBtn").addEventListener("click", function () {
    var content = $("noteContent").value.trim();
    if (!content) { toast("Please write some content first"); return; }
    $("noteContent").value = SmartAI.formatStudyGuide(content, $("noteTitle").value);
    updateContentStats();
    toast("\uD83D\uDCD8 Reformatted as Study Guide");
  });

  /* ---------------- Note Insights / Summary Modal ---------------- */
  function openAiSummary(note) {
    currentSummaryNoteId = note.id;
    $("aiSummaryNoteTitle").textContent = note.title;
    var words = (note.content || "").trim().split(/\s+/).filter(Boolean).length;
    var readMins = Math.max(1, Math.ceil(words / 180));
    $("aiMetricWords").textContent = words + " words";
    $("aiMetricTime").textContent = (words ? readMins : 0) + " min read";
    $("aiMetricFolder").textContent = "\uD83D\uDCC1 " + (note.folder || "Unfiled");

    var summary = SmartAI.generateSummary(note.content, 3);
    $("aiSummaryBody").textContent = summary;

    var tasks = SmartAI.extractActionItems(note.content);
    var taskBox = $("aiSummaryTasks");
    if (tasks.length) {
      taskBox.innerHTML = tasks.map(function (t) {
        return "<li class='ai-task-item'><input type='checkbox' /> <span>" + esc(t) + "</span></li>";
      }).join("");
      $("aiTasksSection").hidden = false;
    } else {
      taskBox.innerHTML = "<li class='side-empty'>No action items detected in this note</li>";
    }

    var kws = SmartAI.extractKeywords(note.content + " " + note.title, 5);
    var tagBox = $("aiSummaryTags");
    if (kws.length) {
      tagBox.innerHTML = kws.map(function (t) {
        return "<span class='tag-chip'>#" + esc(t) + "</span>";
      }).join("");
      $("aiTagsSection").hidden = false;
    } else {
      tagBox.innerHTML = "<span class='side-empty'>No tags extracted</span>";
    }

    $("aiSummaryOverlay").hidden = false;
  }

  function closeAiSummary() {
    $("aiSummaryOverlay").hidden = true;
    currentSummaryNoteId = null;
  }

  $("closeAiSummary").addEventListener("click", closeAiSummary);
  $("aiSummaryOverlay").addEventListener("click", function (e) { if (e.target === this) closeAiSummary(); });

  $("aiCopySummaryBtn").addEventListener("click", function () {
    var text = $("aiSummaryBody").textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      toast("Summary copied to clipboard");
    } else {
      toast("Summary ready to copy");
    }
  });

  $("aiEditFromSummaryBtn").addEventListener("click", function () {
    var id = currentSummaryNoteId;
    closeAiSummary();
    if (id) {
      var note = findNote(id);
      if (note) openModal(note);
    }
  });

  /* ---------------- AI Assistant Modal ---------------- */
  function updateAiEngineLabel() {
    var el = $("aiEngineLabel");
    if (!el) return;
    if (aiSettings.engine === "gemini") {
      el.textContent = "Engine: Google Gemini (" + (aiSettings.model || "gemini-1.5-flash") + ")";
    } else if (aiSettings.engine === "openai") {
      el.textContent = "Engine: OpenAI (" + (aiSettings.model || "gpt-4o-mini") + ")";
    } else {
      el.textContent = "Engine: Built-in Smart Local AI (Offline)";
    }
  }

  function openAiAssistant() {
    updateAiEngineLabel();
    $("aiAssistantOverlay").hidden = false;
    setTimeout(function () { $("aiChatInput").focus(); }, 40);
  }

  function closeAiAssistant() {
    $("aiAssistantOverlay").hidden = true;
  }

  $("aiAssistBtn").addEventListener("click", openAiAssistant);
  $("closeAiModal").addEventListener("click", closeAiAssistant);
  $("aiAssistantOverlay").addEventListener("click", function (e) { if (e.target === this) closeAiAssistant(); });

  $("clearAiChatBtn").addEventListener("click", function () {
    $("aiChatHistory").innerHTML = "<div class='ai-msg ai-msg-bot'>" +
      "<div class='ai-avatar'>\u2728</div>" +
      "<div class='ai-msg-content'>" +
        "<p><strong>Conversation cleared.</strong></p>" +
        "<p>How can I help you with your notes today?</p>" +
      "</div>" +
    "</div>";
    toast("Chat cleared");
  });

  // Prompt chips
  document.querySelector(".ai-prompt-chips").addEventListener("click", function (e) {
    var chip = e.target.closest("[data-prompt]");
    if (!chip) return;
    $("aiChatInput").value = chip.dataset.prompt;
    handleAiChatSubmit();
  });

  async function handleAiChatSubmit() {
    var q = $("aiChatInput").value.trim();
    if (!q) return;
    $("aiChatInput").value = "";

    var hist = $("aiChatHistory");

    // Add user bubble
    var userBubble = document.createElement("div");
    userBubble.className = "ai-msg ai-msg-user";
    userBubble.innerHTML = "<div class='ai-avatar'>\uD83D\uDC64</div>" +
      "<div class='ai-msg-content'><p>" + esc(q) + "</p></div>";
    hist.appendChild(userBubble);

    // Add bot thinking bubble
    var botBubble = document.createElement("div");
    botBubble.className = "ai-msg ai-msg-bot";
    botBubble.innerHTML = "<div class='ai-avatar'>\u2728</div>" +
      "<div class='ai-msg-content'>" +
        "<div class='ai-status-spinner'></div> <em>Analyzing your notes...</em>" +
      "</div>";
    hist.appendChild(botBubble);
    hist.scrollTop = hist.scrollHeight;

    var answer = "";
    if (aiSettings.engine !== "local" && aiSettings.apiKey) {
      try {
        var context = activeNotes().map(function (n) {
          return "Note: " + n.title + "\nFolder: " + (n.folder || "Unfiled") + "\nTags: " + (n.tags || []).join(", ") + "\nContent:\n" + n.content;
        }).join("\n\n---\n\n");
        var sysInstruction = "You are an intelligent study assistant for a student using Smart Notes. Answer their question accurately using only their notes context where relevant. Format clearly with markdown.";
        var fullPrompt = "Notes Context:\n" + context + "\n\nUser Question: " + q;
        answer = await callCloudLLM(fullPrompt, sysInstruction);
      } catch (err) {
        console.warn("Cloud LLM call failed, falling back to local AI:", err);
        toast("Cloud AI unavailable; used built-in offline engine");
        answer = SmartAI.answerLibraryQuery(q, activeNotes());
      }
    } else {
      answer = SmartAI.answerLibraryQuery(q, activeNotes());
    }

    var contentDiv = botBubble.querySelector(".ai-msg-content");
    contentDiv.innerHTML = renderMarkdown(answer) +
      "<div class='ai-msg-actions'>" +
        "<button class='ai-action-btn' data-ai-act='copy'>\uD83D\uDCCB Copy</button>" +
        "<button class='ai-action-btn' data-ai-act='save'>\u2795 Save as Note</button>" +
      "</div>";

    contentDiv.dataset.rawText = answer;
    contentDiv.dataset.query = q;
    hist.scrollTop = hist.scrollHeight;
  }

  $("aiChatForm").addEventListener("submit", function (e) {
    e.preventDefault();
    handleAiChatSubmit();
  });

  $("aiChatHistory").addEventListener("click", function (e) {
    var btn = e.target.closest("[data-ai-act]");
    if (!btn) return;
    var contentEl = btn.closest(".ai-msg-content");
    if (!contentEl) return;
    var rawText = contentEl.dataset.rawText || contentEl.innerText;
    var query = contentEl.dataset.query || "AI Summary";

    if (btn.dataset.aiAct === "copy") {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(rawText);
        toast("Copied to clipboard");
      } else {
        toast("Ready to copy");
      }
    }
    else if (btn.dataset.aiAct === "save") {
      closeAiAssistant();
      openModal(null);
      $("noteTitle").value = "AI: " + (query.length > 35 ? query.slice(0, 35) + "..." : query);
      $("noteContent").value = rawText;
      $("noteFolder").value = ui.folder || "";
      $("noteTags").value = "ai-generated, assistant";
      updateContentStats();
      toast("AI response transferred to new note!");
    }
  });

  /* ---------------- AI Settings Modal ---------------- */
  function openAiSettings() {
    $("aiEngineSelect").value = aiSettings.engine || "local";
    $("aiApiKey").value = aiSettings.apiKey || "";
    $("aiModelInput").value = aiSettings.model || "";
    $("aiCloudFields").hidden = aiSettings.engine === "local";
    $("aiSettingsOverlay").hidden = false;
  }

  function closeAiSettings() {
    $("aiSettingsOverlay").hidden = true;
  }

  $("openAiSettingsBtn").addEventListener("click", openAiSettings);
  $("aiSettingsCancel").addEventListener("click", closeAiSettings);
  $("aiSettingsOverlay").addEventListener("click", function (e) { if (e.target === this) closeAiSettings(); });

  $("aiEngineSelect").addEventListener("change", function () {
    $("aiCloudFields").hidden = this.value === "local";
  });

  $("aiSettingsSave").addEventListener("click", function () {
    aiSettings.engine = $("aiEngineSelect").value;
    aiSettings.apiKey = $("aiApiKey").value.trim();
    aiSettings.model = $("aiModelInput").value.trim();
    safeSet(AI_SETTINGS_KEY, JSON.stringify(aiSettings));
    updateAiEngineLabel();
    closeAiSettings();
    toast("AI settings saved");
  });

  /* ---------------- New note buttons ---------------- */
  function newNote() { openModal(null); }
  $("newNoteBtn").addEventListener("click", newNote);
  $("fab").addEventListener("click", newNote);
  $("emptyAction").addEventListener("click", newNote);

  /* ---------------- Keyboard shortcuts ---------------- */
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (!$("aiSettingsOverlay").hidden) { closeAiSettings(); return; }
      if (!$("aiSummaryOverlay").hidden) { closeAiSummary(); return; }
      if (!$("aiAssistantOverlay").hidden) { closeAiAssistant(); return; }
      if (!$("promptOverlay").hidden) { closePrompt(null); return; }
      if (!$("confirmOverlay").hidden) { closeConfirm(); return; }
      if (!$("noteOverlay").hidden) { closeModal(); return; }
    }
    // Ctrl/Cmd + K focuses search, Ctrl/Cmd + N opens a new note, Ctrl/Cmd + J toggles AI Assistant
    var mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); searchInput.focus(); searchInput.select(); }
    if (mod && e.key.toLowerCase() === "n") {
      if ($("noteOverlay").hidden && $("aiAssistantOverlay").hidden) { e.preventDefault(); newNote(); }
    }
    if (mod && e.key.toLowerCase() === "j") {
      e.preventDefault();
      if ($("aiAssistantOverlay").hidden) openAiAssistant();
      else closeAiAssistant();
    }
  });

  /* ---------------- Migration / seed ---------------- */
  function normalize() {
    var changed = false;
    notes.forEach(function (n) {
      if (typeof n.trashed !== "boolean") { n.trashed = false; changed = true; }
      if (!Array.isArray(n.tags)) { n.tags = []; changed = true; }
      if (!n.folder) { n.folder = ""; changed = true; }
      if (!n.createdAt) { n.createdAt = n.updatedAt || Date.now(); changed = true; }
      if (typeof n.pinned !== "boolean") { n.pinned = false; changed = true; }
    });
    if (changed) safeSet(NOTES_KEY, JSON.stringify(notes));
  }

  /* ---------------- Init ---------------- */
  normalize();
  if (!safeGet(FOLDERS_KEY)) saveFolders();
  searchInput.value = ui.query;
  clearSearch.hidden = !ui.query;
  $("sortSelect").value = ui.sort;
  updateAiEngineLabel();
  render();

  // expose a tiny API for debugging / console testing
  window.SmartNotes = {
    getNotes: function () { return notes.slice(); },
    getFolders: function () { return folders.slice(); },
    getAiSettings: function () { return Object.assign({}, aiSettings); },
    ai: SmartAI,
    clearAll: function () { notes = []; saveNotes(); render(); },
    version: "2.0.0-ai"
  };
})();
