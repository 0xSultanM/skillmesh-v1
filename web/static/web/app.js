/* SkillMesh AI dashboard. Depends on common.js (window.SM). */
(() => {
  "use strict";
  const { $, $$, h, store, post, toast, download, slugify, buildExport, difficultyPill, difficultyFilter, resourceTabs, roadmapKey, findRoadmap, dedupeTutmesh, dedupeHistory } = window.SM;
  const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  const state = {
    profile: null, job: null, github: null, result: null, analysisId: null,
    jobMode: "url", resumeFile: null,
  };

  async function busy(btn, fn) {
    btn.classList.add("loading"); btn.disabled = true;
    try { return await fn(); }
    catch (e) { toast(e.message || "Something went wrong.", true); }
    finally { btn.classList.remove("loading"); btn.disabled = false; updateButtons(); }
  }

  function setStep(n) {
    $$(".stepper li").forEach(li => {
      const s = Number(li.dataset.step);
      li.classList.toggle("active", s === n);
      li.classList.toggle("done", s < n);
    });
  }

  function updateButtons() {
    $('[data-profile-mode="resume"]').classList.toggle("has-data", !!state.profile);
    $('[data-profile-mode="github"]').classList.toggle("has-data", !!state.github);
    $("#analyzeBtn").disabled = !((state.profile || state.github) && state.job);
  }

  function tabs(attr, onChange) {
    $$(`[data-${attr}-mode]`).forEach(btn => btn.addEventListener("click", () => {
      const mode = btn.dataset[`${attr}Mode`];
      $$(`[data-${attr}-mode]`).forEach(b => b.setAttribute("aria-selected", String(b === btn)));
      onChange(mode);
    }));
  }

  function dropzone(zone, input, onFile, accept = () => true) {
    input.addEventListener("change", () => input.files[0] && onFile(input.files[0]));
    zone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    ["dragenter", "dragover"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.add("drag"); }));
    ["dragleave", "drop"].forEach(ev => zone.addEventListener(ev, e => { e.preventDefault(); zone.classList.remove("drag"); }));
    zone.addEventListener("drop", e => { const f = e.dataTransfer.files[0]; if (f && accept(f)) onFile(f); });
  }

  // ---------- capabilities ----------
  async function loadHealth() {
    try {
      const d = await (await fetch("/api/health/")).json();
      $("#capabilities").replaceChildren(
        h("span", { class: `badge ${d.llm ? "ok" : "off"}`, text: d.llm ? "AI extraction on" : "Rule-based extraction (no AI key)" }),
        h("span", { class: `badge ${d.youtube ? "ok" : ""}`, text: d.youtube ? "Live YouTube discovery" : "Curated resources" }),
        h("span", { class: "badge ok", text: "Nothing stored on our servers" }),
      );
    } catch { /* non-critical */ }
  }

  function autoStatus(el, text, kind = "") {
    if (!el) return;
    el.hidden = !text;
    el.className = `auto-status ${kind}`.trim();
    el.textContent = text || "";
  }

  // ---------- profile source (Resume / GitHub) ----------
  function setProfileMode(mode) {
    $$("[data-profile-mode]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.profileMode === mode)));
    $$("[data-profile-panel]").forEach(p => { p.hidden = p.dataset.profilePanel !== mode; });
  }

  // ---------- resume ----------
  let resumeSeq = 0;
  async function parseResume(file) {
    const seq = ++resumeSeq, status = $("#resumeStatus"), zone = $("#resumeDrop");
    autoStatus(status, "Reading your resume…", "busy");
    zone.classList.add("working");
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await post("/api/resume/parse/", { form });
      if (seq !== resumeSeq) return;
      state.profile = data.profile;
      renderProfile();
      setStep(2);
      autoStatus(status, `Found ${data.profile.skills.length} skills. Review them below.`, "ok");
      toast(`Found ${data.profile.skills.length} skills in your resume.`);
    } catch (e) {
      if (seq !== resumeSeq) return;
      autoStatus(status, e.message || "We couldn't read that file.", "error");
      toast(e.message || "We couldn't read that file.", true);
    } finally {
      if (seq === resumeSeq) { zone.classList.remove("working"); updateButtons(); }
    }
  }

  function setupResume() {
    tabs("profile", setProfileMode);
    dropzone($("#resumeDrop"), $("#resumeFile"), file => {
      $("#resumeFile").value = "";
      if (file.size > 5 * 1024 * 1024) { toast("Please choose a file under 5 MB.", true); return; }
      state.resumeFile = file;
      $("#resumeFileName").textContent = file.name;
      parseResume(file);
    });
  }

  function toggleStrength(s) { s.strength = s.strength === "applied" ? "listed" : "applied"; renderProfile(); }

  function renderProfile() {
    const p = state.profile;
    $("#profileBox").hidden = false;
    $("#profileSource").textContent = p.source === "llm" ? "AI extracted" : "Rule-based";
    $("#pYears").value = p.years_experience ?? 0;
    $("#pSeniority").value = p.seniority || "unknown";
    $("#pEducation").value = p.education || "";
    const box = $("#profileChips");
    box.replaceChildren(...p.skills.map((s, i) => h("span", {
      class: `chip ${s.strength === "applied" ? "applied" : "listed"} ${s.known ? "" : "custom"}`,
      title: s.evidence ? `Evidence: ${s.evidence}` : "Click to toggle used / listed",
      role: "button", tabindex: "0",
      onclick: e => { if (!e.target.closest(".x")) toggleStrength(s); },
      onkeydown: e => { if (e.key === "Enter") toggleStrength(s); },
    }, s.name, h("button", { class: "x", type: "button", "aria-label": `Remove ${s.name}`, text: "×", onclick: () => { p.skills.splice(i, 1); renderProfile(); } }))));
    if (!p.skills.length) box.append(h("p", { class: "hint", text: "No skills detected. Add them below." }));
    updateButtons();
  }

  // ---------- GitHub ----------
  let ghAuth = { signed_in: false, oauth_configured: false, free_total: 1, free_remaining: 1, login: "" };

  async function loadGithubStatus() {
    try { ghAuth = await (await fetch("/api/github/status/", { credentials: "same-origin" })).json(); } catch { /* ignore */ }
    renderGithubAuth();
  }

  function stashDraft() {
    try {
      sessionStorage.setItem("sm:draft", JSON.stringify({
        profile: state.profile, job: state.job, github: state.github,
        jobText: $("#jobText").value, githubUser: $("#githubUser").value,
      }));
    } catch { /* ignore */ }
  }

  function restoreDraft() {
    let d = null;
    try { d = JSON.parse(sessionStorage.getItem("sm:draft") || "null"); sessionStorage.removeItem("sm:draft"); } catch { /* ignore */ }
    if (!d) return null;
    if (d.profile) { state.profile = d.profile; renderProfile(); }
    if (d.jobText) $("#jobText").value = d.jobText;
    if (d.job) { state.job = d.job; renderJob(); }
    if (d.github) { state.github = d.github; renderGithub(); }
    if (d.githubUser) $("#githubUser").value = d.githubUser;
    updateButtons();
    return d;
  }

  function signIn() {
    if (!ghAuth.oauth_configured) {
      toast("GitHub sign-in needs a one-time setup on this server: add GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to .env, then restart it.", true);
      return;
    }
    stashDraft();
    window.location.href = "/auth/github/login/?next=/";
  }

  function renderGithubAuth(loginRequired = false) {
    const box = $("#ghAuth");
    if (ghAuth.signed_in) {
      box.className = "gh-auth ok";
      box.replaceChildren(
        h("span", { text: "✓ Signed in as " }), h("strong", { text: `@${ghAuth.login}` }),
        h("span", { class: "hint", text: " · unlimited analyses (GitHub's 5,000/hour limit)" }),
        h("button", { type: "button", class: "linklike", text: "Sign out", onclick: async () => {
          try { await post("/auth/github/logout/", { json: {} }); } catch { /* ignore */ }
          loadGithubStatus();
          toast("Signed out of GitHub. The token was revoked.");
        } }));
      return;
    }
    const left = ghAuth.free_remaining;
    const used = loginRequired || !left;
    box.className = `gh-auth ${used ? "warn" : ""}`;
    box.replaceChildren(
      h("div", { class: "gh-auth-text" },
        h("strong", { text: used ? "Today's free GitHub analysis is used" : `${left} free GitHub ${left === 1 ? "analysis" : "analyses"} available today` }),
        h("p", { text: used
          ? "Sign in with GitHub to keep analyzing right now, or come back tomorrow for another free one."
          : "Paste a profile URL below, or sign in with GitHub and we'll read the skills from your public repositories for you." }),
        h("small", { text: "Public data only · no permissions requested · sign out any time" })),
      h("button", { type: "button", class: `btn ${used ? "primary" : ""} gh-signin`, onclick: signIn,
        title: ghAuth.oauth_configured ? "Sign in with GitHub" : "GitHub sign-in isn't set up on this server yet" },
        h("span", { class: "gh-mark small", "aria-hidden": "true" }), "Sign in with GitHub"));
  }

  function setupGithub() {
    $("#githubForm").addEventListener("submit", e => {
      e.preventDefault();
      const username = $("#githubUser").value.trim();
      if (!username) return;
      busy($("#githubBtn"), async () => {
        try {
          const data = await post("/api/github/analyze/", { json: { username } });
          state.github = data.github;
          if (data.github_auth) Object.assign(ghAuth, data.github_auth);
          renderGithub();
          renderGithubAuth();
          toast(`Analyzed ${data.github.repos_analyzed} public repos: ${data.github.skills.length} skills evidenced.`);
        } catch (err) {
          if (err.code === "login_required") {
            ghAuth.free_remaining = 0;
            renderGithubAuth(true);
            $("#ghAuth").scrollIntoView({ behavior: "smooth", block: "center" });
          }
          throw err;
        }
      });
    });
    $("#githubClear").addEventListener("click", () => { state.github = null; $("#githubBox").hidden = true; updateButtons(); });
  }

  const LANG_COLORS = ["#4f46e5", "#0ea5e9", "#a855f7", "#f59e0b", "#10b981", "#ef4444"];

  function renderGithub() {
    const g = state.github;
    $("#githubBox").hidden = false;
    $("#ghSummary").replaceChildren(
      h("a", { href: g.profile_url, target: "_blank", rel: "noopener noreferrer", class: "gh-user", text: `@${g.username}` }),
      h("span", { text: `${g.repos_analyzed} of ${g.public_repos} public repos analyzed` }),
      h("span", { text: `★ ${g.total_stars}` }),
    );
    $("#ghLangBar").replaceChildren(...g.top_languages.map((l, i) => h("span", {
      style: `width:${Math.max(1.5, l.percent)}%;background:${LANG_COLORS[i % LANG_COLORS.length]}`, title: `${l.name} ${l.percent}%`,
    })));
    $("#ghLangLegend").replaceChildren(...g.top_languages.map((l, i) => h("span", {},
      h("i", { style: `background:${LANG_COLORS[i % LANG_COLORS.length]}` }), `${l.name} ${l.percent}%`)));
    $("#githubChips").replaceChildren(...g.skills.map((s, i) => h("span", { class: "chip gh", title: s.evidence },
      s.name, h("b", { class: "lvl", text: String(s.level) }),
      h("button", { class: "x", type: "button", "aria-label": `Remove ${s.name}`, text: "×", onclick: () => { g.skills.splice(i, 1); renderGithub(); } }))));
    updateButtons();
  }

  // ---------- job ----------
  function setupJob() {
    tabs("job", mode => {
      state.jobMode = mode;
      $$("[data-job-panel]").forEach(p => { if (p.dataset.jobPanel !== "text") p.hidden = p.dataset.jobPanel !== mode; });
      if (mode === "text") $("#jobText").focus();
      if (mode === "image") loadTesseract().catch(() => {});
    });
    $("#jobText").addEventListener("input", e => scheduleJobExtract(e.inputType === "insertFromPaste" ? 150 : 1500));
    $("#jobText").addEventListener("blur", () => scheduleJobExtract(0));

    $("#urlForm").addEventListener("submit", e => {
      e.preventDefault();
      busy($("#fetchBtn"), async () => {
        const data = await post("/api/job/scrape/", { json: { url: $("#jobUrl").value } });
        $("#jobText").value = data.text;
        toast(data.method === "json-ld" ? "Job posting found (structured data). Extracting requirements…" : "Page text fetched. Extracting requirements…");
        await extractJob();
      });
    });

    dropzone($("#imageDrop"), $("#jobImage"), ocr, f => f.type.startsWith("image/"));
    document.addEventListener("paste", e => {
      if (state.jobMode !== "image") return;
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); ocr(item.getAsFile()); }
    });
  }

  let jobTimer, jobSeq = 0, lastJobText = "";
  function scheduleJobExtract(delay) {
    clearTimeout(jobTimer);
    jobTimer = setTimeout(extractJob, delay);
  }

  async function extractJob() {
    clearTimeout(jobTimer);
    const text = $("#jobText").value.trim(), status = $("#jobStatus");
    if (text.length < 80) {
      autoStatus(status, text ? "Add a bit more of the job description and the requirements will be extracted automatically." : "");
      return;
    }
    if (text === lastJobText) return;
    lastJobText = text;
    const seq = ++jobSeq;
    autoStatus(status, "Extracting requirements…", "busy");
    try {
      const data = await post("/api/job/parse/", { json: { text } });
      if (seq !== jobSeq) return;
      state.job = data.job;
      renderJob();
      setStep(state.profile || state.github ? 3 : 2);
      autoStatus(status, `Found ${data.job.required.length} required and ${data.job.preferred.length} nice-to-have skills.`, "ok");
    } catch (e) {
      if (seq !== jobSeq) return;
      lastJobText = "";
      autoStatus(status, e.message || "We couldn't extract the requirements.", "error");
      toast(e.message || "We couldn't extract the requirements.", true);
    } finally {
      if (seq === jobSeq) updateButtons();
    }
  }

  let tesseractPromise;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    tesseractPromise ||= new Promise((resolve, reject) => {
      const s = h("script", { src: TESSERACT_URL, crossorigin: "anonymous" });
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { tesseractPromise = null; reject(new Error("Couldn't load the on-device text scanner.")); };
      document.head.append(s);
    });
    return tesseractPromise;
  }

  async function ocr(file) {
    const status = $("#ocrStatus"), bar = $("#ocrProgress"), fill = $("#ocrProgress > div");
    bar.hidden = false; fill.style.width = "0%";
    status.textContent = "Loading scanner…";
    try {
      const T = await loadTesseract();
      const worker = await T.createWorker("eng", 1, {
        logger: m => {
          if (m.status === "recognizing text") { fill.style.width = `${Math.round(m.progress * 100)}%`; status.textContent = `Reading text… ${Math.round(m.progress * 100)}%`; }
          else if (m.status) status.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + "…";
        },
      });
      const { data } = await worker.recognize(file);
      await worker.terminate();
      const text = (data.text || "").trim();
      if (text.length < 80) throw new Error("We couldn't read enough text from that image. Try a sharper screenshot or paste the text.");
      $("#jobText").value = text;
      status.textContent = `Scanned ${text.split(/\s+/).length} words.`;
      fill.style.width = "100%";
      if (data.confidence != null && data.confidence < 60) toast("The scan quality is low. Check the text and the extracted skills for mistakes.", true);
      extractJob();
    } catch (e) {
      status.textContent = "";
      toast(e.message || "Scanning failed.", true);
    } finally {
      setTimeout(() => { bar.hidden = true; }, 800);
    }
  }

  function renderJob() {
    const j = state.job;
    $("#jobBox").hidden = false;
    $("#jobHeading").textContent = [j.title, j.company].filter(Boolean).join(" · ") || "Requirements";
    $("#jobSource").textContent = j.source === "llm" ? "AI extracted" : "Rule-based";
    $("#jYears").value = j.years_required ?? 0;
    $("#jSeniority").value = j.seniority || "unknown";
    $("#jEducation").value = j.education || "";
    const chipList = (list, other, otherName) => list.map((s, i) => h("span", { class: `chip ${s.known ? "" : "custom"}` },
      s.name,
      h("button", { class: "x", type: "button", "aria-label": `Move ${s.name} to ${otherName}`, title: `Move to ${otherName}`, text: "⇄",
        onclick: () => { other.push(list.splice(i, 1)[0]); renderJob(); } }),
      h("button", { class: "x", type: "button", "aria-label": `Remove ${s.name}`, text: "×", onclick: () => { list.splice(i, 1); renderJob(); } }),
    ));
    $("#requiredChips").replaceChildren(...chipList(j.required, j.preferred, "nice to have"));
    $("#preferredChips").replaceChildren(...chipList(j.preferred, j.required, "required"));
    const hr = $("#hardReqs");
    hr.hidden = !j.hard_requirements?.length;
    if (j.hard_requirements?.length) {
      hr.replaceChildren(h("strong", { text: "Check these yourself: " }), h("ul", {}, j.hard_requirements.map(r => h("li", { text: r }))));
    }
    updateButtons();
  }

  function setupChipAdders() {
    $$(".add-chip").forEach(form => form.addEventListener("submit", e => {
      e.preventDefault();
      const input = $("input", form);
      const name = input.value.trim();
      if (!name) return;
      const target = form.dataset.target;
      if (target === "profile") {
        state.profile ||= { skills: [], years_experience: 0, seniority: "unknown", education: "", domains: [], source: "manual" };
        state.profile.skills.push({ slug: "", name, known: true, strength: "applied", evidence: "Added by you" });
        renderProfile();
      } else if (state.job && (target === "required" || target === "preferred")) {
        state.job[target].push({ slug: "", name, known: true });
        renderJob();
      }
      input.value = "";
    }));
  }

  // ---------- analyze ----------
  function collect() {
    const p = state.profile || { skills: [] }, j = state.job;
    return {
      profile: { ...p, years_experience: Number($("#pYears").value) || 0, seniority: $("#pSeniority").value, education: $("#pEducation").value },
      job: { ...j, years_required: Number($("#jYears").value) || 0, seniority: $("#jSeniority").value, education: $("#jEducation").value },
      github: state.github ? { username: state.github.username, skills: state.github.skills } : null,
      hours_per_week: Number($("#hours").value),
      include_preferred: $("#includePref").checked,
    };
  }

  function setupAnalyze() {
    const hours = $("#hours");
    const paintHours = () => {
      const v = Number(hours.value);
      $("#hoursVal").textContent = v;
      hours.style.setProperty("--p", String((v - hours.min) / (hours.max - hours.min)));
      hours.setAttribute("aria-valuetext", `${v} hours per week`);
      $("#hoursPace").replaceChildren(
        h("b", { text: v <= 5 ? "Light" : v <= 12 ? "Steady" : v <= 24 ? "Focused" : "Intensive" }),
        ` · about ${(v / 7).toFixed(1)} h a day`);
    };
    hours.addEventListener("input", paintHours);
    paintHours();
    $("#analyzeBtn").addEventListener("click", e => busy(e.currentTarget, async () => {
      const result = await post("/api/analyze/", { json: collect() });
      state.result = result;
      state.analysisId = `rm_${roadmapKey(result.job, result.roadmap)}`; // same job + skills = same roadmap, never a second copy
      renderResults(result);
      setStep(3);
      $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    $("#printBtn").addEventListener("click", () => window.print());
    $("#saveBtn").addEventListener("click", () => {
      if (!state.result) return;
      const r = state.result;
      const key = roadmapKey(r.job, r.roadmap);
      const hist = store.get("history", []).filter(x => x.id !== state.analysisId && roadmapKey(x?.result?.job, x?.result?.roadmap) !== key);
      hist.unshift({
        id: state.analysisId, at: new Date().toISOString(),
        title: [r.job.title, r.job.company].filter(Boolean).join(" · ") || "Untitled job",
        score: r.report.score, result: r,
      });
      if (!store.set("history", hist.slice(0, 20))) { toast("Couldn't save. Browser storage is unavailable.", true); return; }
      toast("Saved in this browser.");
    });

    // Exports
    $("#exportJson").addEventListener("click", () => {
      if (!state.result) return;
      const doc = buildExport(state.result, state.analysisId);
      download(`skillmesh-roadmap-${slugify(state.result.job.title)}.json`, new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" }));
      toast("Roadmap exported. Import it in TutMesh to track your progress.");
    });
    $("#exportPdf").addEventListener("click", e => busy(e.currentTarget, async () => {
      if (!state.result) return;
      await window.SM.downloadRoadmapPdf(buildExport(state.result, state.analysisId));
    }));
    $("#openTutmesh").addEventListener("click", () => {
      if (!state.result) return;
      const doc = window.SM.sanitizeRoadmapDoc(buildExport(state.result, state.analysisId));
      const tm = store.get("tutmesh", { roadmaps: {}, order: [] });
      dedupeTutmesh(tm);
      const id = findRoadmap(tm, doc) || doc.id;
      // Already tracked: refresh the plan and keep the progress instead of saving a second copy.
      tm.roadmaps[id] = tm.roadmaps[id] ? { ...doc, id, progress: tm.roadmaps[id].progress } : doc;
      tm.order = [id, ...tm.order.filter(x => x !== id)];
      if (!store.set("tutmesh", tm)) { toast("Browser storage is unavailable. Use Export JSON instead.", true); return; }
      window.location.href = `/tutmesh/#${encodeURIComponent(id)}`;
    });
  }

  // ---------- results ----------
  function renderResults(r) {
    const rep = r.report;
    $("#results").hidden = false;

    const C = 2 * Math.PI * 52;
    const fg = $("#ringFg");
    fg.style.strokeDasharray = String(C);
    fg.style.stroke = rep.score >= 80 ? "var(--good)" : rep.score >= 70 ? "var(--primary)" : rep.score >= 50 ? "var(--warn)" : "var(--bad)";
    requestAnimationFrame(() => { fg.style.strokeDashoffset = String(C * (1 - rep.score / 100)); });
    $("#scoreNum").textContent = rep.score;

    const pill = $("#verdictPill");
    pill.textContent = rep.verdict.label;
    pill.className = `verdict-pill v-${rep.verdict.key}`;
    $("#resultTitle").textContent = [r.job.title, r.job.company].filter(Boolean).join(" · ") || "Your fit for this role";
    $("#verdictMsg").textContent = rep.verdict.message;
    $("#capsList").replaceChildren(...rep.caps.map(c => h("li", { text: `Score capped: ${c}` })));

    $("#breakdown").replaceChildren(...rep.breakdown.map(b => h("div", { class: "bar-row" },
      h("div", { class: "bar-label" }, h("span", { text: b.label }), h("span", { text: `${b.points} / ${Math.round(b.weight * 100)} pts` })),
      h("div", { class: "bar" }, h("div", { style: `width:${Math.round(b.value * 100)}%` })),
      h("div", { class: "bar-note", text: b.note }),
    )));

    const wins = rep.quick_wins.length ? rep.quick_wins : ["Your resume already evidences the skills you have. Focus on the roadmap."];
    $("#quickWins").replaceChildren(...wins.map(w => h("li", { text: w })));
    const hr = $("#hardReqResult");
    hr.hidden = !rep.hard_requirements.length;
    if (rep.hard_requirements.length) hr.replaceChildren(h("strong", { text: "Non-skill requirements we can't verify:" }), h("ul", {}, rep.hard_requirements.map(x => h("li", { text: x }))));

    renderSkillLevels(r);
    renderRoadmap(r.roadmap);
  }

  function levelTone(row) {
    if (row.your_level >= row.required_level) return "good";
    if (row.your_level >= row.required_level * 0.6) return "warn";
    return "bad";
  }

  function renderSkillLevels(r) {
    const rep = r.report;
    const seniority = (r.job.seniority && r.job.seniority !== "unknown") ? r.job.seniority : "mid";
    $("#levelHint").textContent = `Your estimated proficiency compared with what a ${seniority}-level role typically expects (about ${rep.required_level}/100 on required skills).`;
    const ready = rep.readiness;
    $("#readiness").replaceChildren(
      h("div", { class: "readiness-num", text: `${ready}%` }),
      h("div", { class: "readiness-label", text: "skill readiness" }),
      h("div", { class: "readiness-bar" }, h("div", { style: `width:${ready}%` })),
    );

    const cc = rep.cross_check;
    const ccBox = $("#crossCheck");
    ccBox.hidden = !cc;
    if (cc) {
      const group = (title, items, cls) => h("div", { class: `cc-group ${cls}` },
        h("strong", { text: `${title} (${items.length})` }),
        h("div", { class: "cc-items" }, items.length ? items.map(x => h("span", { text: x })) : h("em", { text: "None" })));
      ccBox.replaceChildren(
        h("div", { class: "cc-title", text: "Resume ↔ GitHub cross-check" }),
        group("Confirmed by code", cc.confirmed, "ok"),
        group("Resume only (no public code)", cc.resume_only, "warn"),
        group("GitHub only (add to resume)", cc.github_only, "info"),
      );
    }

    const rows = [...rep.required.map(x => ({ ...x, type: "Required" })), ...rep.preferred.map(x => ({ ...x, type: "Nice to have" }))];
    const statusLabel = { matched: "Matched", partial: "Partial", missing: "Missing" };
    $("#skillLevels").replaceChildren(...rows.map(s => {
      const tone = levelTone(s);
      const evidence = s.status === "missing" ? "Not found in your resume or GitHub"
        : [s.via ? `Via ${s.via}${s.relation === "prerequisite" ? " (implies this)" : " (related)"}` : "",
           s.evidence ? `“${s.evidence}”` : (s.strength === "listed" ? "Listed only" : ""),
           s.github_evidence && s.github_evidence !== s.evidence ? `GitHub: ${s.github_evidence}` : ""].filter(Boolean).join(" · ");
      const gap = s.required_level - s.your_level;
      return h("div", { class: `lvl-row tone-${tone}` },
        h("div", { class: "lvl-top" },
          h("div", { class: "lvl-name" },
            h("strong", { text: s.name }),
            h("span", { class: "lvl-type", text: s.type }),
            ...(s.sources || []).map(src => h("i", { class: `src ${src === "github" ? "gh" : ""}`, title: src === "github" ? "Evidenced on GitHub" : "From your resume", text: src === "github" ? "G" : "R" }))),
          h("div", { class: "lvl-right" },
            h("span", { class: `status s-${s.status}`, text: statusLabel[s.status] }),
            h("span", { class: "lvl-nums" }, h("b", { text: String(s.your_level) }), ` / ${s.required_level}`))),
        h("div", { class: "lvl-track", role: "img", "aria-label": `${s.name}: your level ${s.your_level} of 100, required ${s.required_level}` },
          h("div", { class: "lvl-fill", style: `width:${s.your_level}%` }),
          h("div", { class: "lvl-marker", style: `left:${s.required_level}%`, title: `Required: ${s.required_level}` })),
        h("div", { class: "lvl-foot" },
          h("span", { class: "evidence", text: evidence }),
          h("span", { class: "lvl-gap", text: gap > 0 ? `${gap} pts to go` : "Meets the bar ✓" })),
      );
    }));
  }

  function renderRoadmap(rm) {
    const progress = store.get(`progress:${state.analysisId}`, {});
    $("#exportMenu").hidden = !rm.step_count;
    if (!rm.step_count) {
      $("#roadmapSummary").textContent = "No gaps to close. Your profile covers everything this job asks for.";
      $("#rmStats").replaceChildren();
      $("#roadmap").replaceChildren();
      return;
    }
    $("#roadmapSummary").textContent = "Ordered so every skill builds on the last. All resources are free.";
    const steps = rm.phases.flatMap(p => p.steps);
    const count = d => steps.filter(s => s.difficulty === d).length;
    const filter = difficultyFilter({ easy: count("easy"), medium: count("medium"), hard: count("hard") }, new Set(), selected => {
      $$("#roadmap .step-card").forEach(c => { c.hidden = selected.size > 0 && !selected.has(c.dataset.difficulty); });
      $$("#roadmap .phase").forEach(ph => { ph.hidden = !$$(".step-card", ph).some(c => !c.hidden); });
    });
    $("#rmStats").replaceChildren(
      ...[[rm.step_count, "skills"], [`${rm.total_hours} h`, "total effort"], [`${rm.total_weeks} wk`, `at ${rm.hours_per_week} h/week`]]
        .map(([v, l]) => h("div", { class: "rm-stat" }, h("b", { text: String(v) }), h("span", { text: l }))),
      filter,
    );

    let n = 0;
    $("#roadmap").replaceChildren(...rm.phases.map(ph => h("section", { class: `phase phase-${ph.key}` },
      h("div", { class: "phase-head" },
        h("span", { class: "phase-badge", text: ph.title.split(":")[0] }),
        h("div", {}, h("h4", { text: ph.title.split(":").slice(1).join(":").trim() || ph.title }), h("p", { text: ph.description })),
        h("span", { class: "phase-meta", text: `Weeks ${ph.weeks[0]}–${ph.weeks[1]} · ${ph.hours} h` })),
      h("div", { class: "timeline" }, ...ph.steps.map(st => stepCard(st, ++n, progress))),
    )));
  }

  function stepCard(st, n, progress) {
    const id = `step-${st.slug}`;
    const card = h("article", { class: `step-card ${progress[st.slug] ? "done" : ""}`, "data-difficulty": st.difficulty });
    const cb = h("input", { type: "checkbox", id, class: "step-check", "aria-label": `Mark ${st.name} as done` });
    cb.checked = !!progress[st.slug];
    cb.addEventListener("change", () => {
      progress[st.slug] = cb.checked;
      store.set(`progress:${state.analysisId}`, progress);
      card.classList.toggle("done", cb.checked);
    });
    const weeks = `Week ${st.start_week}${st.end_week > st.start_week ? `–${st.end_week}` : ""}`;
    card.append(
      h("div", { class: "step-node", "aria-hidden": "true", text: String(n) }),
      h("div", { class: "step-main" },
        h("header", { class: "step-header" },
          h("div", { class: "step-heading" },
            cb,
            h("label", { for: id, class: "step-title", text: st.name }),
            st.partial ? h("span", { class: "badge", text: `Build on ${st.via || "existing skills"}` }) : null),
          difficultyPill(st.difficulty)),
        h("div", { class: "step-meta" },
          h("span", { text: st.reason }), h("span", { text: `~${st.hours} h` }), h("span", { text: weeks })),
        h("div", { class: "step-project" }, h("span", { class: "proj-icon", "aria-hidden": "true", text: "◆" }),
          h("div", {}, h("strong", { text: "Prove it" }), h("p", { text: st.project }))),
        resourceTabs(st.resources),
      ),
    );
    return card;
  }

  // ---------- history ----------
  function setupHistory() {
    const drawer = $("#historyDrawer"), opener = $("#historyBtn");
    const backdrop = h("div", { class: "drawer-backdrop", hidden: true, "aria-hidden": "true" });
    drawer.before(backdrop);
    const open = () => { render(); drawer.hidden = false; backdrop.hidden = false; };
    const close = () => { drawer.hidden = true; backdrop.hidden = true; };
    const render = () => {
      const hist = store.get("history", []);
      const dropped = dedupeHistory(hist);
      if (dropped.length) {
        store.set("history", hist);
        dropped.filter(d => !hist.some(it => it.id === d.id)).forEach(d => store.remove(`progress:${d.id}`));
      }
      $("#historyList").replaceChildren(...(hist.length ? hist.map((it, i) => h("li", {},
        h("div", {},
          h("div", { class: "h-title", role: "button", tabindex: "0", text: it.title,
            onclick: () => { state.result = it.result; state.analysisId = it.id; renderResults(it.result); close(); $("#results").scrollIntoView({ behavior: "smooth" }); } }),
          h("div", { class: "h-meta", text: `${it.score}/100 · ${new Date(it.at).toLocaleDateString()}` })),
        h("button", { class: "linklike", "aria-label": `Delete ${it.title}`, text: "Delete",
          onclick: () => { hist.splice(i, 1); store.set("history", hist); store.remove(`progress:${it.id}`); render(); } }),
      )) : [h("li", { class: "hint", text: "Nothing saved yet." })]));
    };
    opener.addEventListener("click", () => (drawer.hidden ? open() : close()));
    $("#closeHistory").addEventListener("click", close);
    // Close on any click outside the drawer. `composedPath` still contains the drawer
    // when the clicked element was removed by its own handler (e.g. "Delete").
    document.addEventListener("click", e => {
      if (drawer.hidden) return;
      const path = e.composedPath();
      if (path.includes(drawer) || path.includes(opener)) return;
      close();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && !drawer.hidden) close(); });
    $("#wipeBtn").addEventListener("click", () => {
      if (!confirm("Delete all saved analyses, progress and TutMesh roadmaps from this browser?")) return;
      store.wipe(); render(); toast("All local data deleted.");
    });
  }

  function handleAuthReturn() {
    const params = new URLSearchParams(location.search);
    const gh = params.get("gh");
    if (!gh) return;
    setProfileMode("github");
    history.replaceState(null, "", location.pathname + location.hash);
    restoreDraft();
    if (gh === "signed_in") {
      // Signed in: read the skills from their own public profile unless they had typed another one.
      if (!$("#githubUser").value.trim()) $("#githubUser").value = ghAuth.login || "";
      if (!state.github && $("#githubUser").value.trim()) {
        toast("Signed in with GitHub. Reading your public repositories…");
        $("#githubForm").requestSubmit();
      } else toast("Signed in with GitHub. You can now analyze more profiles.");
    } else if (gh === "cancelled") toast("GitHub sign-in was cancelled.");
    else if (gh === "failed") toast("GitHub sign-in didn't complete. Please try again.", true);
    else if (gh === "not_configured") toast("GitHub sign-in isn't configured on this server.", true);
  }

  document.addEventListener("DOMContentLoaded", async () => {
    setupResume(); setupGithub(); setupJob(); setupChipAdders(); setupAnalyze(); setupHistory(); loadHealth(); updateButtons();
    $("#rmGoal").append(window.SM.media.goalWidget());
    await loadGithubStatus();
    handleAuthReturn();
  });
})();
