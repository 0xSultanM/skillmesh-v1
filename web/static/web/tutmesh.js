/* TutMesh: browser-only roadmap tracker. Depends on common.js (window.SM).
 * Storage: localStorage "sm:tutmesh" = { roadmaps: {id: doc}, order: [id, ...] }
 * doc.progress = { steps: {slug: true}, resources: {url: true}, notes: {slug: text}, time: {url: seconds} }
 * Daily streaks come from automatic tracking (media.js): 10 min of video OR 5 min of reading in-app.
 */
(() => {
  "use strict";
  const { $, h, store, toast, download, slugify, sanitizeRoadmapDoc, difficultyPill, difficultyFilter, resourceTabs, findRoadmap, dedupeTutmesh } = window.SM;
  const { activity, goalWidget, dayKey, GOALS, DEFAULT_GOALS } = window.SM.media;
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let tm = store.get("tutmesh", { roadmaps: {}, order: [] });
  let currentId = null;
  const diffSel = new Set(); // difficulty filter for the open roadmap; empty = show all

  const save = () => { if (!store.set("tutmesh", tm)) toast("Couldn't save. Browser storage is full or disabled.", true); };
  const current = () => tm.roadmaps[currentId];
  // Attribute tracked study time to the roadmap that owns the resource (per-resource "min studied").
  function onActivity(e) {
    const { url, secs } = e.detail || {};
    if (!url || !secs) { renderStats(); return; }
    let touched = false;
    for (const id of tm.order) {
      const doc = tm.roadmaps[id];
      const has = doc.roadmap.phases.some(ph => ph.steps.some(st =>
        [...st.resources.video, ...st.resources.content].some(r => r.url === url)));
      if (has) { doc.progress.time ||= {}; doc.progress.time[url] = (doc.progress.time[url] || 0) + secs; touched = true; }
    }
    if (touched) save();
    renderStats();
  }

  // ---------- import ----------
  async function importFile(file) {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) { toast("That file is too large to be a roadmap.", true); return; }
    let doc;
    try {
      doc = sanitizeRoadmapDoc(JSON.parse(await file.text()));
    } catch (e) {
      toast(e instanceof SyntaxError ? "That file isn't valid JSON." : e.message, true);
      return;
    }
    const existing = findRoadmap(tm, doc); // same id, or the same job + skills under another id
    if (existing && !confirm("This roadmap is already in TutMesh. Replace it with the imported copy (including its progress)?")) return;
    if (existing) doc.id = existing; else tm.order.unshift(doc.id);
    tm.roadmaps[doc.id] = doc;
    save();
    select(doc.id);
    toast("Roadmap imported. Happy learning!");
  }

  function setupImport() {
    const zone = $("#importDrop"), input = $("#importFile");
    input.addEventListener("change", () => { importFile(input.files[0]); input.value = ""; });
    zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("drag"); }));
    zone.addEventListener("drop", e => importFile(e.dataTransfer.files[0]));
  }

  // ---------- list ----------
  function pctDone(doc) {
    const steps = doc.roadmap.phases.flatMap(p => p.steps);
    const done = steps.filter(s => doc.progress.steps[s.slug]).length;
    return steps.length ? Math.round((done * 100) / steps.length) : 0;
  }

  function renderList() {
    tm.order = tm.order.filter(id => tm.roadmaps[id]);
    $("#tmEmptyList").hidden = tm.order.length > 0;
    $("#tmList").replaceChildren(...tm.order.map(id => {
      const doc = tm.roadmaps[id];
      const pct = pctDone(doc);
      return h("li", { class: id === currentId ? "active" : "" },
        h("button", { type: "button", class: "tm-item", onclick: () => select(id) },
          h("span", { class: "tm-item-title", text: doc.job.title || "Untitled roadmap" }),
          h("span", { class: "tm-item-sub", text: [doc.job.company, `${doc.roadmap.step_count} steps`].filter(Boolean).join(" · ") }),
          h("span", { class: "mini-bar" }, h("span", { style: `width:${pct}%` })),
          h("span", { class: "tm-item-pct", text: `${pct}%` })));
    }));
  }

  function select(id) {
    if (!tm.roadmaps[id]) return;
    if (id !== currentId) diffSel.clear();
    currentId = id;
    history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    renderList();
    renderMain();
  }

  // ---------- main ----------
  function renderMain() {
    const doc = current();
    $("#tmMain").hidden = !doc;
    if (!doc) return;
    const pct = pctDone(doc);
    const C = 2 * Math.PI * 52;
    const ring = $("#tmRing");
    ring.style.strokeDasharray = String(C);
    ring.style.strokeDashoffset = String(C * (1 - pct / 100));
    ring.style.stroke = pct >= 100 ? "var(--good)" : "var(--primary)";
    $("#tmPct").textContent = pct;
    $("#tmEyebrow").textContent = doc.summary.score != null ? `Fit score at export: ${doc.summary.score}/100${doc.summary.verdict ? ` · ${doc.summary.verdict}` : ""}` : "Learning roadmap";
    $("#tmJob").textContent = [doc.job.title, doc.job.company].filter(Boolean).join(" · ") || "Untitled roadmap";
    $("#tmMeta").textContent = `${doc.roadmap.step_count} steps · ~${doc.roadmap.total_hours} h · ${doc.roadmap.total_weeks} weeks at ${doc.roadmap.hours_per_week} h/week`;

    renderStats();
    renderSteps(doc);
  }

  function renderStats() {
    const s = activity.streaks();
    $("#tmStreak").textContent = s.current;
    $("#tmBest").textContent = s.best;
    $("#tmDays").textContent = s.total;
    renderHeatmap(activity.data().days);
  }

  // One column per week (Sunday first) for the past 12 months, with month names on top.
  function renderHeatmap(days) {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const start = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate() + 1);
    start.setDate(start.getDate() - start.getDay());
    const cells = [], months = [];
    let col = 0, video = 0, read = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dow = d.getDay();
      if (dow === 0) {
        col++;
        if (!months.length || months[months.length - 1].month !== d.getMonth()) months.push({ col, month: d.getMonth() });
      }
      const day = days[dayKey(d)] || {};
      const v = day.video || 0, r = day.read || 0;
      video += v; read += r;
      const m = Math.round((v + r) / 60);
      const earned = activity.qualifies(day);
      const lvl = m <= 0 ? 0 : !earned ? 1 : m < 20 ? 2 : m < 45 ? 3 : 4;
      const label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      cells.push(h("i", { class: `l${lvl}${earned ? " earned" : ""}`, style: `grid-column:${col + 1};grid-row:${dow + 2}`,
        title: `${label}: ${m ? `${Math.round(v / 60)} min video, ${Math.round(r / 60)} min reading` : "no tracked study"}${earned ? " · streak day ✓" : ""}` }));
    }
    if (months.length > 1 && months[1].col - months[0].col < 3) months.shift(); // a clipped first month would overlap the next label
    const last = months[months.length - 1];
    last.end = col - last.col < 2; // too few columns left for the name: anchor it to the right edge instead of overflowing
    const map = $("#heatmap");
    map.style.setProperty("--weeks", String(col));
    map.replaceChildren(
      ...months.map(mo => h("span", { class: `heat-month${mo.end ? " end" : ""}`, style: `grid-column:${mo.col + 1}${mo.end ? " / -1" : ""}`, text: MONTHS[mo.month] })),
      ...[["Mon", 3], ["Wed", 5], ["Fri", 7]].map(([text, row]) => h("span", { class: "heat-day", style: `grid-row:${row}`, text })),
      ...cells);
    map.scrollLeft = map.scrollWidth; // narrow screens: start at the most recent weeks

    const total = Math.floor((video + read) / 60);
    const w = activity.weeks();
    $("#tmTotalMin").textContent = total.toLocaleString();
    $("#tmTotalSplit").textContent = `${Math.floor(video / 60).toLocaleString()} watched · ${Math.floor(read / 60).toLocaleString()} read`;
    $("#tmWeekStreak").textContent = w.current;
    $("#tmWeekUnit").textContent = w.current === 1 ? "week" : "weeks";
    $("#tmWeekDays").textContent = `${w.thisWeek} of 7 days earned this week`;
    map.setAttribute("aria-label", `Study activity for the past 12 months: ${total} minutes tracked, ${w.current}-week streak`);
  }

  function renderSteps(doc) {
    const p = doc.progress;
    const hideDone = $("#hideDone").checked;
    const all = doc.roadmap.phases.flatMap(ph => ph.steps);
    const count = d => all.filter(s => s.difficulty === d).length;
    const doneAll = all.filter(s => p.steps[s.slug]).length;
    $("#hideDoneCount").textContent = `${doneAll} of ${all.length} done`;
    [...diffSel].forEach(d => { if (!count(d)) diffSel.delete(d); });
    $("#tmDiffFilter").replaceChildren(difficultyFilter(
      { easy: count("easy"), medium: count("medium"), hard: count("hard") }, diffSel, () => renderSteps(doc)));
    const shown = st => !(hideDone && p.steps[st.slug]) && (!diffSel.size || diffSel.has(st.difficulty));
    let n = 0;
    const phases = doc.roadmap.phases.map(ph => {
      const done = ph.steps.filter(s => p.steps[s.slug]).length;
      if (!ph.steps.some(shown)) { n += ph.steps.length; return null; }
      return h("section", { class: `phase phase-${ph.key}` },
        h("div", { class: "phase-head" },
          h("span", { class: "phase-badge", text: ph.title.split(":")[0] }),
          h("div", {}, h("h4", { text: ph.title.split(":").slice(1).join(":").trim() || ph.title }), h("p", { text: ph.description })),
          h("span", { class: "phase-meta", text: `${done}/${ph.steps.length} done · weeks ${ph.weeks[0]}–${ph.weeks[ph.weeks.length - 1]}` })),
        h("div", { class: "timeline" }, ...ph.steps.map(st => {
          n++;
          return shown(st) ? stepCard(doc, st, n) : null;
        })));
    }).filter(Boolean);
    $("#tmRoadmap").replaceChildren(...(phases.length ? phases
      : [h("p", { class: "hint steps-empty", text: all.length === doneAll && hideDone && !diffSel.size
          ? "Everything is completed. Turn off “Hide completed” to see the steps again."
          : "No steps match these filters." })]));
  }

  function stepCard(doc, st, n) {
    const p = doc.progress;
    const id = `tm-step-${slugify(st.slug)}`;
    const card = h("article", { class: `step-card ${p.steps[st.slug] ? "done" : ""}` });
    const cb = h("input", { type: "checkbox", id, class: "step-check", "aria-label": `Mark ${st.name} as done` });
    cb.checked = !!p.steps[st.slug];
    cb.addEventListener("change", () => {
      if (cb.checked) p.steps[st.slug] = true; else delete p.steps[st.slug];
      save();
      renderList();
      renderMain();
      if (cb.checked) toast(`Nice! ${st.name} completed.`);
    });

    const resDone = [...st.resources.video, ...st.resources.content].filter(r => p.resources[r.url]).length;
    const resTotal = st.resources.video.length + st.resources.content.length;
    const studied = Math.round([...st.resources.video, ...st.resources.content].reduce((n, r) => n + ((p.time || {})[r.url] || 0), 0) / 60);
    const notes = h("textarea", { rows: "2", placeholder: "Notes, links to your project, things to revisit…", "aria-label": `Notes for ${st.name}`, maxlength: "4000" });
    notes.value = p.notes[st.slug] || "";
    let t;
    notes.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { p.notes[st.slug] = notes.value; save(); }, 400); });

    card.append(
      h("div", { class: "step-node", "aria-hidden": "true", text: String(n) }),
      h("div", { class: "step-main" },
        h("header", { class: "step-header" },
          h("div", { class: "step-heading" }, cb, h("label", { for: id, class: "step-title", text: st.name })),
          difficultyPill(st.difficulty)),
        h("div", { class: "step-meta" },
          h("span", { text: st.reason }), h("span", { text: `~${st.hours} h` }),
          h("span", { text: `Week ${st.start_week}${st.end_week > st.start_week ? `–${st.end_week}` : ""}` }),
          resTotal ? h("span", { text: `${resDone}/${resTotal} resources` }) : null,
          studied ? h("span", { class: "studied", text: `${studied} min studied` }) : null),
        st.project ? h("div", { class: "step-project" }, h("span", { class: "proj-icon", "aria-hidden": "true", text: "◆" }),
          h("div", {}, h("strong", { text: "Prove it" }), h("p", { text: st.project }))) : null,
        resourceTabs(st.resources, {
          checked: url => !!p.resources[url],
          onCheck: (url, on) => { if (on) p.resources[url] = true; else delete p.resources[url]; save(); renderMain(); },
          timeFor: url => (p.time || {})[url] || 0,
          topicChecked: key => !!(p.topics || {})[`${st.slug}|${key}`],
          onTopicCheck: (key, on) => { p.topics ||= {}; if (on) p.topics[`${st.slug}|${key}`] = true; else delete p.topics[`${st.slug}|${key}`]; save(); },
        }),
        h("details", { class: "notes" }, h("summary", { text: p.notes[st.slug] ? "Your notes" : "Add notes" }), notes),
      ),
    );
    return card;
  }

  // ---------- edit daily goal ----------
  // Only the goal is editable. Tracked time is never typed in: it is counted by the player and the reader (media.js).
  function setupGoalEdit() {
    const form = $("#tmGoalForm"), btn = $("#tmGoalEdit");
    const video = $("#geGoalVideo"), read = $("#geGoalRead");
    const toggle = open => { form.hidden = !open; btn.setAttribute("aria-expanded", String(open)); };
    btn.addEventListener("click", () => {
      if (!form.hidden) { toggle(false); return; }
      video.value = Math.round(GOALS.video / 60);
      read.value = Math.round(GOALS.read / 60);
      toggle(true);
      video.focus();
    });
    $("#geCancel").addEventListener("click", () => toggle(false));
    $("#geReset").addEventListener("click", () => { video.value = DEFAULT_GOALS.video / 60; read.value = DEFAULT_GOALS.read / 60; });
    form.addEventListener("submit", e => {
      e.preventDefault();
      activity.setGoals({ video: Number(video.value) * 60, read: Number(read.value) * 60 });
      toggle(false);
      renderStats();
      toast(`Daily goal saved: watch ${video.value} min or read ${read.value} min.`);
    });
  }

  // ---------- actions ----------
  function setupActions() {
    window.addEventListener("sm:activity", onActivity);
    window.addEventListener("sm:media-closed", () => { if (current()) { renderList(); renderSteps(current()); } });
    window.addEventListener("storage", e => { if (e.key === "sm:activity") renderStats(); });
    $("#hideDone").addEventListener("change", () => current() && renderSteps(current()));
    $("#tmExportJson").addEventListener("click", () => {
      const doc = current();
      if (!doc) return;
      const out = { ...doc, exported_at: new Date().toISOString() };
      download(`tutmesh-${slugify(doc.job.title)}.json`, new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    });
    $("#tmExportPdf").addEventListener("click", async e => {
      const doc = current();
      if (!doc) return;
      const btn = e.currentTarget;
      btn.classList.add("loading"); btn.disabled = true;
      try {
        await window.SM.downloadRoadmapPdf(doc);
      } catch (err) { toast(err.message, true); }
      finally { btn.classList.remove("loading"); btn.disabled = false; }
    });
    $("#tmDelete").addEventListener("click", () => {
      const doc = current();
      if (!doc || !confirm("Remove this roadmap and its progress from TutMesh? Export it first if you want a backup.")) return;
      delete tm.roadmaps[currentId];
      tm.order = tm.order.filter(id => id !== currentId);
      save();
      currentId = tm.order[0] || null;
      renderList();
      if (currentId) select(currentId); else { $("#tmMain").hidden = true; history.replaceState(null, "", location.pathname); }
    });
    window.addEventListener("storage", e => { // another tab changed TutMesh
      if (e.key !== "sm:tutmesh") return;
      tm = store.get("tutmesh", { roadmaps: {}, order: [] });
      if (!tm.roadmaps[currentId]) currentId = tm.order[0] || null;
      renderList(); renderMain();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#tmGoal").append(goalWidget());
    setupImport();
    setupActions();
    setupGoalEdit();
    if (dedupeTutmesh(tm)) save(); // older versions could store the same roadmap more than once
    renderList();
    const wanted = decodeURIComponent(location.hash.slice(1));
    if (wanted && tm.roadmaps[wanted]) select(wanted);
    else if (tm.order[0]) select(tm.order[0]);
  });
})();
