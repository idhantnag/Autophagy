/* Autophagy Radar — a personal literature briefing for Prof. Ravi Manjithaya.
 *
 * Principles borrowed from the sibling NeuroTrends tracker: a static site that
 * composes real PubMed E-utilities queries in the browser, so every paper and
 * every summary is live and never model-invented. What's new here:
 *   - a customizable time WINDOW that drives a spoken + written briefing
 *   - the briefing is read aloud via the browser's SpeechSynthesis (no key)
 *   - a keyless template summary that always works; an optional Anthropic key
 *     upgrades it to a Claude-written narrative that connects to the profile
 *   - "On your radar" cards that proactively surface work close to the
 *     researcher's own techniques ("you did X — these groups did something
 *     similar, want a summary?")
 *   - standout papers are always shown WITH their PubMed IDs.
 */
(function () {
  "use strict";

  const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
  const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
  const KEY_STORE = "autophagy-radar-key";
  const MODEL_STORE = "autophagy-radar-model";
  const TOOL = "autophagy-radar";
  const EMAIL = "anonymous@example.com";
  const PALETTE = ["#2f9e8f", "#7c6cff", "#f0883e", "#e4568f", "#3ba7d6",
    "#c2a63b", "#8e7cff", "#d9705b", "#4bb372", "#a06cd5"];

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const esc = (s) => (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const state = {
    cfg: null,
    days: 30,
    custom: false,
    lastSummaryText: "",   // plain text for TTS
    charts: {},
  };
  const themeById = (id) => state.cfg.themes.find((t) => t.id === id);
  const getKey = () => localStorage.getItem(KEY_STORE) || "";
  const getModel = () => localStorage.getItem(MODEL_STORE) || "claude-opus-5";

  /* ---------- window / date helpers ---------------------------------- */
  function pad(n) { return String(n).padStart(2, "0"); }
  function fmtDate(d) { return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; }
  function prettyDate(d) {
    return d.toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
  }

  // Returns { from, to, basis, label } for the active window.
  function currentWindow() {
    if (state.custom) {
      const f = $("#dateFrom").value, t = $("#dateTo").value;
      const basis = $("#dateBasis").value || "edat";
      const from = f ? new Date(f + "T00:00:00") : new Date(Date.now() - 30 * 864e5);
      const to = t ? new Date(t + "T00:00:00") : new Date();
      return { from, to, basis, label: `${prettyDate(from)} – ${prettyDate(to)}` };
    }
    const to = new Date();
    const from = new Date(Date.now() - state.days * 864e5);
    const human = state.days >= 365 ? `${Math.round(state.days / 365)} year(s)`
      : state.days >= 30 ? `${Math.round(state.days / 30)} month(s)` : `${state.days} days`;
    return { from, to, basis: "edat", label: `the last ${human}` };
  }
  function windowFragment(w) {
    return `("${fmtDate(w.from)}"[${w.basis}] : "${fmtDate(w.to)}"[${w.basis}])`;
  }

  /* ---------- PubMed --------------------------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // NCBI allows ~3 requests/second without an API key, so we retry politely on
  // transient failures / HTTP 429 rather than firing everything at once.
  async function withRetry(fn, signal, tries = 4) {
    let backoff = 450;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) {
        if (e.name === "AbortError") throw e;
        if (i === tries - 1) throw e;
        await sleep(backoff); backoff = Math.min(backoff * 2, 4000);
      }
    }
  }

  async function esearch(term, { retmax = 0, sort = "date", signal } = {}) {
    const url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${retmax}&sort=${sort}`
      + `&term=${encodeURIComponent(term)}&tool=${TOOL}&email=${EMAIL}`;
    return withRetry(async () => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`PubMed ${res.status}`);
      const r = await res.json();
      if (!r.esearchresult || r.esearchresult.ERROR) {
        throw new Error((r.esearchresult && r.esearchresult.ERROR) || "PubMed busy");
      }
      return { count: Number(r.esearchresult.count), ids: r.esearchresult.idlist || [] };
    }, signal);
  }
  async function efetch(ids, signal) {
    if (!ids.length) return [];
    const url = `${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&id=${ids.join(",")}`
      + `&tool=${TOOL}&email=${EMAIL}`;
    return withRetry(async () => {
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`PubMed ${res.status}`);
      return parseArticles(await res.text());
    }, signal);
  }

  // Editorial / non-research records we don't want to surface as "highlights".
  const NON_ARTICLE = /^(retraction|correction|corrigendum|erratum|author correction|withdrawn|withdrawal|expression of concern|editorial expression|comment on|reply to|response to|in this issue)/i;
  function textOf(node) { return node ? (node.textContent || "").trim() : ""; }

  function parseArticles(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const out = [];
    doc.querySelectorAll("PubmedArticle").forEach((art) => {
      const pmid = textOf(art.querySelector("MedlineCitation > PMID"));
      const title = textOf(art.querySelector("Article > ArticleTitle")) || "(untitled)";
      const journal = textOf(art.querySelector("Journal > Title"))
        || textOf(art.querySelector("Journal ISOAbbreviation"));
      const year = textOf(art.querySelector("Article JournalIssue PubDate Year"))
        || textOf(art.querySelector("Article JournalIssue PubDate MedlineDate"));
      const month = textOf(art.querySelector("Article JournalIssue PubDate Month"));
      const abstract = [...art.querySelectorAll("Article > Abstract > AbstractText")]
        .map(textOf).join(" ");
      let doi = "";
      art.querySelectorAll("PubmedData > ArticleIdList > ArticleId").forEach((a) => {
        if (a.getAttribute("IdType") === "doi") doi = textOf(a);
      });
      const authorNodes = [...art.querySelectorAll("Article > AuthorList > Author")]
        .filter((a) => a.querySelector("LastName"));
      const authors = authorNodes.map((a) => {
        const last = textOf(a.querySelector("LastName"));
        const init = textOf(a.querySelector("Initials"));
        const affs = [...a.querySelectorAll("AffiliationInfo > Affiliation")].map(textOf);
        const emails = (affs.join(" ").match(/[\w.+-]+@[\w-]+\.[A-Za-z][\w.-]*[A-Za-z]/g) || [])
          .map((e) => e.replace(/[.,;]+$/, ""));
        return { name: `${last} ${init}`.trim(), aff: affs[0] || "", email: emails[0] || "" };
      });
      out.push({
        pmid, title, journal, year, month, doi, abstract,
        first: authors[0], senior: authors[authors.length - 1],
        corresponding: authors.filter((a) => a.email), count: authors.length,
      });
    });
    return out;
  }

  // "Nature"/"Science" flag their whole family (Nature X, Science X are all
  // high-profile); every other single-word brand ("Cell", "Autophagy", "Neuron")
  // must match the title exactly, so "Cell biochemistry and biophysics" and
  // "Advanced Science" don't get falsely starred. Multi-word entries prefix-match
  // so partial official titles (e.g. the long PNAS title) still resolve.
  const PRESTIGE_FAMILIES = new Set(["nature", "science"]);
  const isPrestige = (journal) => {
    const j = (journal || "").trim().toLowerCase();
    return state.cfg.prestigeJournals.some((p) => {
      const pl = p.toLowerCase();
      if (j === pl) return true;
      const canPrefix = pl.includes(" ") || PRESTIGE_FAMILIES.has(pl);
      return canPrefix && j.startsWith(pl + " ");
    });
  };

  /* ---------- briefing ------------------------------------------------- */
  let briefAbort = null;

  // theme may be a theme object (focused briefing) or null (whole field).
  async function runBriefing(theme, autoplay) {
    const card = $("#summaryCard"), status = $("#summaryStatus"), body = $("#summaryBody");
    const w = currentWindow();
    card.hidden = false;
    $("#summaryTitle").textContent = theme ? `Briefing · ${theme.label}` : "Your autophagy briefing";
    body.innerHTML = "";
    $("#highlightCard").hidden = true;
    $("#engineNote").hidden = true;
    status.innerHTML = `<span class="spinner"></span> Scanning PubMed for ${esc(w.label)}…`;
    stopSpeech();
    card.scrollIntoView({ behavior: "smooth", block: "start" });

    if (briefAbort) briefAbort.abort();
    briefAbort = new AbortController();
    const signal = briefAbort.signal;

    const base = state.cfg.baseQuery;
    const winFrag = windowFragment(w);
    const scopeQuery = theme ? `${base} AND ${theme.query}` : base;

    try {
      // 1) headline count + a sample of the most recent papers
      const search = await esearch(`${scopeQuery} AND ${winFrag}`, { retmax: 25, sort: "date", signal });
      if (!search.count) {
        status.textContent = `No new papers in ${w.label} for this scope. Try a longer window.`;
        return;
      }
      const papers = await efetch(search.ids, signal);
      // Drop retractions/corrections/errata etc. from what we spotlight.
      const articles = papers.filter((p) => !NON_ARTICLE.test(p.title));

      // 2) per-theme activity (real counts), only for the whole-field briefing.
      // Sequential + retry keeps us under NCBI's keyless 3 req/s limit so no
      // theme silently drops to zero from a 429.
      let themeCounts = null;
      if (!theme) {
        status.innerHTML = `<span class="spinner"></span> Measuring activity across your themes…`;
        const counts = [];
        for (const t of state.cfg.themes) {
          try { counts.push([t, (await esearch(`${base} AND ${t.query} AND ${winFrag}`, { signal })).count]); }
          catch (e) { if (e.name === "AbortError") return; counts.push([t, 0]); }
          await sleep(120);
        }
        themeCounts = counts.filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
      }

      // 3) standout papers: highest-profile venues first, then top up with the
      // most recent research so there's always a handful to read.
      const pres = articles.filter((p) => isPrestige(p.journal));
      const rest = articles.filter((p) => !pres.includes(p));
      const highlights = pres.concat(rest).slice(0, 4);

      status.innerHTML = `<strong>${fmt(search.count)}</strong> new paper${search.count === 1 ? "" : "s"} in ${esc(w.label)}${theme ? " · " + esc(theme.label) : ""}.`;

      // 4) narrative — Claude if a key is present, else a template
      let narrative;
      if (getKey()) {
        try {
          narrative = await claudeNarrative({ w, theme, total: search.count, themeCounts, papers: articles, highlights, signal });
          $("#engineNote").textContent = "Narrative written by Claude over the live PubMed results; every PMID is real.";
        } catch (err) {
          if (err.name === "AbortError") return;
          narrative = templateNarrative({ w, theme, total: search.count, themeCounts, highlights });
          $("#engineNote").textContent = "Claude was unavailable, so this is the built-in summary. " + (err.message || "");
        }
      } else {
        narrative = templateNarrative({ w, theme, total: search.count, themeCounts, highlights });
        $("#engineNote").textContent = "Built-in summary from live PubMed counts. Add an API key (⚙) for a Claude-written narrative.";
      }
      $("#engineNote").hidden = false;

      renderNarrative(narrative, highlights);
      renderHighlights(highlights, w);
      state.lastSummaryText = narrative.spoken || narrative.text;
      if (autoplay) speak(state.lastSummaryText);
    } catch (err) {
      if (err.name === "AbortError") return;
      status.innerHTML = `Couldn't reach PubMed (${esc(err.message)}). Please retry in a moment.`;
    }
  }

  // Deterministic, keyless summary built purely from the fetched data.
  function templateNarrative({ w, theme, total, themeCounts, highlights }) {
    const r = state.cfg.researcher;
    const bits = [];
    bits.push(`Here's your autophagy briefing for ${w.label}.`);
    if (theme) {
      bits.push(`On ${theme.label.toLowerCase()}, PubMed added ${total} new paper${total === 1 ? "" : "s"} across all journals.`);
    } else {
      bits.push(`PubMed added ${total} new autophagy paper${total === 1 ? "" : "s"} across the whole literature — not just autophagy-focused labs.`);
      if (themeCounts && themeCounts.length) {
        const top = themeCounts.slice(0, 4).map(([t, c]) => `${t.label} (${c})`);
        bits.push(`The busiest areas for you were ${listJoin(top)}.`);
      }
    }
    if (highlights.length) {
      bits.push(`A few worth reading in full:`);
      highlights.forEach((p) => {
        const who = p.senior ? p.senior.name : (p.first ? p.first.name : "the authors");
        bits.push(`In ${p.journal || "a leading journal"}, ${who} and colleagues published "${cleanTitle(p.title)}". That's PubMed ID ${p.pmid}.`);
      });
    }
    bits.push(`Open any of these below, or ask me to zoom into one of your themes on the radar.`);
    const spoken = bits.join(" ");
    return { text: spoken, spoken, html: paragraphsFrom(bits) };
  }

  // Optional richer narrative from Claude, grounded in the fetched papers.
  async function claudeNarrative({ w, theme, total, themeCounts, papers, highlights, signal }) {
    const r = state.cfg.researcher;
    const sig = state.cfg.themes.filter((t) => t.signature)
      .map((t) => `${t.label} (${t.technique})`).join("; ");
    const paperLines = papers.slice(0, 18).map((p) =>
      `PMID ${p.pmid} | ${p.journal || "?"} | ${cleanTitle(p.title)} | ${(p.abstract || "").slice(0, 320)}`).join("\n");
    const themeLine = themeCounts
      ? themeCounts.map(([t, c]) => `${t.label}: ${c}`).join(", ") : (theme ? theme.label : "");

    const system = [
      `You are a research assistant writing a short spoken briefing for ${r.name} (${r.lab}, ${r.affiliation}).`,
      `Their work: ${r.blurb}`,
      `Signature techniques/topics to connect back to: ${sig}.`,
      "You are given REAL papers just fetched from PubMed for a chosen time window. Write a warm, concise briefing (about 130-190 words) that will be READ ALOUD, so use flowing prose, no markup, no bullet characters, no headings.",
      "Naturally connect one or two items to the researcher's own techniques, e.g. 'you've worked on X — this group did something similar'. When you name a standout paper, say its PubMed ID as 'PubMed ID <number>' so it can be spoken clearly.",
      "Only use the papers provided. Never invent a PMID, title, or finding. Return ONLY JSON matching the schema.",
    ].join("\n");
    const user = [
      `Time window: ${w.label}. New papers in scope: ${total}.`,
      theme ? `Focus theme: ${theme.label}.` : `Theme activity (new papers): ${themeLine}.`,
      `Suggested standouts (prestige venues): ${highlights.map((h) => "PMID " + h.pmid).join(", ") || "none flagged"}.`,
      "",
      "Papers:",
      paperLines,
    ].join("\n");

    const schema = {
      type: "object",
      properties: {
        spoken: { type: "string" },
        highlightPmids: { type: "array", items: { type: "string" } },
      },
      required: ["spoken", "highlightPmids"],
      additionalProperties: false,
    };
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST", signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": getKey(),
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: getModel(), max_tokens: 900, system,
        messages: [{ role: "user", content: user }],
        output_config: { format: { type: "json_schema", schema } },
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error((d.error && d.error.message) || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const block = (data.content || []).find((b) => b.type === "text");
    const plan = JSON.parse(block.text);
    return { text: plan.spoken, spoken: plan.spoken, html: paragraphsFrom(plan.spoken.split(/\n+/)) };
  }

  function renderNarrative(narrative, highlights) {
    // Link any "PubMed ID 12345" / "PMID 12345" mentions to PubMed.
    let html = narrative.html;
    html = html.replace(/(PubMed ID|PMID)\s*(\d{5,9})/g, (_m, lbl, id) =>
      `${lbl} <a class="pmid" href="https://pubmed.ncbi.nlm.nih.gov/${id}/" target="_blank" rel="noopener">${id}</a>`);
    $("#summaryBody").innerHTML = html;
  }

  function renderHighlights(highlights, w) {
    if (!highlights.length) { $("#highlightCard").hidden = true; return; }
    $("#highlightCard").hidden = false;
    $("#highlightList").innerHTML = highlights.map((p) => {
      const url = `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`;
      const who = p.senior ? p.senior.name : (p.first ? p.first.name : "");
      const date = [p.month, p.year].filter(Boolean).join(" ");
      const doi = p.doi ? ` · <a href="https://doi.org/${p.doi}" target="_blank" rel="noopener">DOI</a>` : "";
      const tag = isPrestige(p.journal) ? `<span class="badge">${esc(p.journal)}</span>` : `<span class="badge muted-badge">${esc(p.journal || "")}</span>`;
      const contact = (p.corresponding[0] && p.corresponding[0].email)
        ? `<a class="contact" href="mailto:${p.corresponding[0].email}" title="Corresponding author, as published">✉ ${esc(p.corresponding[0].name)}</a>` : "";
      return `<article class="hl">
        <div class="hl-top">${tag}<a class="pmid-chip" href="${url}" target="_blank" rel="noopener">PMID ${p.pmid}</a></div>
        <a class="hl-title" href="${url}" target="_blank" rel="noopener">${esc(cleanTitle(p.title))}</a>
        <div class="hl-meta">${esc(who)}${date ? " · " + esc(date) : ""}${doi}</div>
        ${contact ? `<div class="hl-contact">${contact}</div>` : ""}
      </article>`;
    }).join("");
  }

  /* ---------- On-your-radar cards -------------------------------------- */
  function buildRadar() {
    const snap = state.cfg.snapshot;
    const sig = state.cfg.themes.filter((t) => t.signature);
    // order by recent activity if we have a snapshot
    const ranked = sig.map((t) => ({ t, n: snap && snap.byTheme ? (snap.byTheme[t.id] || 0) : null }))
      .sort((a, b) => (b.n || 0) - (a.n || 0));
    $("#radarGrid").innerHTML = ranked.map(({ t, n }) => {
      const count = n == null ? "" : `<span class="radar-n">${n}</span> new`;
      return `<article class="radar" data-theme="${t.id}">
        <p class="radar-you">${esc(t.youText)}.</p>
        <p class="radar-say">I noticed ${esc(t.connector)} recently. ${count ? "There " + (n === 1 ? "is" : "are") + " " + count + " in the last 30 days — " : ""}want a summary?</p>
        <button class="btn-small" data-theme="${t.id}">Summarize ${esc(t.label)} ▶</button>
      </article>`;
    }).join("");
    $("#radarGrid").querySelectorAll("button[data-theme]").forEach((b) => {
      b.addEventListener("click", () => {
        $("#browseTheme").value = b.dataset.theme;
        runBriefing(themeById(b.dataset.theme), true);
      });
    });
  }

  /* ---------- speech synthesis ---------------------------------------- */
  let voices = [];
  function loadVoices() {
    voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    const sel = $("#voiceSel");
    if (!sel) return;
    // Only offer Google voices (e.g. "Google US English"). These ship with
    // Chrome/Chromium; other browsers may expose none.
    const google = voices.filter((v) => /google/i.test(v.name));
    if (!google.length) {
      sel.innerHTML = `<option value="">Google voices unavailable — using browser default</option>`;
      return;
    }
    const isEn = (v) => /^en(-|_|$)/i.test(v.lang);
    const list = [...google.filter(isEn), ...google.filter((v) => !isEn(v))];
    sel.innerHTML = list.map((v) => `<option value="${voices.indexOf(v)}">${esc(v.name)} · ${esc(v.lang)}</option>`).join("");
    // Prefer an Indian-English Google voice, then British, else first English.
    const pick = list.find((v) => /^en(-|_)IN$/i.test(v.lang))
      || list.find((v) => /^en(-|_)GB$/i.test(v.lang)) || list[0];
    if (pick) sel.value = String(voices.indexOf(pick));
  }
  function speak(text) {
    if (!window.speechSynthesis) {
      $("#engineNote").textContent = "This browser has no speech synthesis, so audio is unavailable — the written briefing is above.";
      $("#engineNote").hidden = false;
      return;
    }
    stopSpeech();
    const u = new SpeechSynthesisUtterance(text);
    const raw = $("#voiceSel").value;
    if (raw !== "" && voices[Number(raw)]) u.voice = voices[Number(raw)];
    u.rate = Number($("#rate").value) || 1;
    u.onend = () => { $("#playBtn").textContent = "▶"; };
    window.speechSynthesis.speak(u);
    $("#playBtn").textContent = "❚❚";
  }
  function stopSpeech() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if ($("#playBtn")) $("#playBtn").textContent = "▶";
  }
  function togglePlay() {
    const ss = window.speechSynthesis;
    if (!ss) return;
    if (ss.speaking && !ss.paused) { ss.pause(); $("#playBtn").textContent = "▶"; }
    else if (ss.paused) { ss.resume(); $("#playBtn").textContent = "❚❚"; }
    else if (state.lastSummaryText) speak(state.lastSummaryText);
  }

  /* ---------- trend chart --------------------------------------------- */
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function renderTrend() {
    if (!state.cfg.trend || !state.cfg.years || !window.Chart) { $("#trendCardWrap").hidden = true; return; }
    const years = state.cfg.years.map(String);
    // show the researcher's signature themes for a legible chart
    const themes = state.cfg.themes.filter((t) => t.signature).slice(0, 6);
    const ds = themes.map((t, i) => ({
      label: t.label,
      data: years.map((y) => (state.cfg.trend[t.id] || {})[y] || 0),
      borderColor: PALETTE[i % PALETTE.length],
      backgroundColor: PALETTE[i % PALETTE.length] + "22",
      tension: 0.3, borderWidth: 2, pointRadius: 2, fill: false,
    }));
    const grid = cssVar("--grid"), ink = cssVar("--muted");
    if (state.charts.trend) state.charts.trend.destroy();
    state.charts.trend = new Chart($("#trendChart"), {
      type: "line",
      data: { labels: years, datasets: ds },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: ink, boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { grid: { color: grid }, ticks: { color: ink } },
          y: { grid: { color: grid }, ticks: { color: ink }, beginAtZero: true },
        },
      },
    });
  }

  /* ---------- live browse --------------------------------------------- */
  let browseAbort = null;
  async function runBrowse() {
    const status = $("#browseStatus"), results = $("#browseResults");
    const w = currentWindow();
    const t = themeById($("#browseTheme").value);
    const q = (t ? `${state.cfg.baseQuery} AND ${t.query}` : state.cfg.baseQuery)
      + ` AND ${windowFragment(w)}`;
    status.innerHTML = `<span class="spinner"></span> Searching PubMed…`;
    results.innerHTML = "";
    if (browseAbort) browseAbort.abort();
    browseAbort = new AbortController();
    try {
      const s = await esearch(q, { retmax: 20, sort: $("#browseSort").value, signal: browseAbort.signal });
      if (!s.count) { status.textContent = "No papers matched this scope."; return; }
      const papers = await efetch(s.ids, browseAbort.signal);
      status.innerHTML = `<strong>${fmt(s.count)}</strong> match — showing ${papers.length}, ${$("#browseSort").value === "date" ? "most recent" : "best match"} first.`;
      renderPaperCards(papers, results);
    } catch (err) {
      if (err.name === "AbortError") return;
      status.innerHTML = `Couldn't reach PubMed (${esc(err.message)}).`;
    }
  }
  function renderPaperCards(papers, el) {
    el.innerHTML = papers.map((p) => {
      const url = `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`;
      const date = [p.month, p.year].filter(Boolean).join(" ");
      const authorLine = p.count > 1
        ? `${p.first ? esc(p.first.name) : ""} … <strong>${p.senior ? esc(p.senior.name) : ""}</strong>`
        : `<strong>${p.senior ? esc(p.senior.name) : ""}</strong>`;
      const seen = new Set();
      const contacts = p.corresponding.filter((c) => !seen.has(c.email) && seen.add(c.email))
        .map((c) => `<a class="contact" href="mailto:${c.email}">✉ ${esc(c.name)}</a>`).join("");
      const doi = p.doi ? ` · <a href="https://doi.org/${p.doi}" target="_blank" rel="noopener">DOI</a>` : "";
      return `<article class="paper">
        <a class="paper-title" href="${url}" target="_blank" rel="noopener">${esc(cleanTitle(p.title))}</a>
        <div class="paper-meta"><span class="paper-journal">${esc(p.journal || "")}</span>${date ? " · " + esc(date) : ""}
          · <a href="${url}" target="_blank" rel="noopener">PMID ${p.pmid}</a>${doi}</div>
        <div class="paper-authors"><span class="pi-label">Senior author:</span> ${authorLine}</div>
        ${contacts ? `<div class="paper-contacts">${contacts}</div>` : ""}
      </article>`;
    }).join("");
  }

  /* ---------- small text utilities ------------------------------------ */
  function cleanTitle(t) { return (t || "").replace(/\s*\.$/, "").replace(/<[^>]+>/g, ""); }
  function listJoin(arr) {
    if (arr.length <= 1) return arr.join("");
    return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
  }
  function paragraphsFrom(bits) {
    return bits.filter(Boolean).map((b) => `<p>${esc(b)}</p>`).join("");
  }

  /* ---------- wiring --------------------------------------------------- */
  function wireWindow() {
    $("#windowPresets").querySelectorAll(".win-btn").forEach((b) => {
      b.addEventListener("click", () => {
        $("#windowPresets").querySelectorAll(".win-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        if (b.dataset.custom) {
          state.custom = true; $("#customRow").hidden = false;
          const to = new Date(), from = new Date(Date.now() - 30 * 864e5);
          $("#dateTo").value = to.toISOString().slice(0, 10);
          $("#dateFrom").value = from.toISOString().slice(0, 10);
        } else {
          state.custom = false; $("#customRow").hidden = true;
          state.days = Number(b.dataset.days);
        }
        updateScope();
      });
    });
    ["#dateFrom", "#dateTo", "#dateBasis"].forEach((s) => $(s).addEventListener("change", updateScope));
  }
  function updateScope() {
    $("#scopeNote").textContent = `Scanning ${currentWindow().label}.`;
  }

  function wireKey() {
    $("#apiModel").value = getModel();
    $("#apiKey").value = getKey();
    $("#apiStatus").textContent = getKey() ? "Key saved in this browser — Claude narration is on." : "No key — using the built-in briefing.";
    $("#keyBtn").addEventListener("click", () => { $("#keyPanel").hidden = !$("#keyPanel").hidden; });
    $("#apiSave").addEventListener("click", () => {
      const k = $("#apiKey").value.trim();
      if (k) localStorage.setItem(KEY_STORE, k); else localStorage.removeItem(KEY_STORE);
      localStorage.setItem(MODEL_STORE, $("#apiModel").value);
      $("#apiStatus").textContent = k ? "Saved. Claude narration is on." : "Key cleared — using the built-in briefing.";
    });
    $("#apiClear").addEventListener("click", () => {
      localStorage.removeItem(KEY_STORE); $("#apiKey").value = "";
      $("#apiStatus").textContent = "Key cleared — using the built-in briefing.";
    });
    $("#apiModel").addEventListener("change", () => localStorage.setItem(MODEL_STORE, $("#apiModel").value));
  }

  function wireAudio() {
    $("#playBtn").addEventListener("click", togglePlay);
    $("#stopBtn").addEventListener("click", stopSpeech);
    if (window.speechSynthesis) {
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  function setupTheme() {
    const KEY = "autophagy-radar-theme";
    const apply = (t) => document.documentElement.setAttribute("data-theme", t);
    apply(localStorage.getItem(KEY) || "light");
    $("#themeToggle").addEventListener("click", () => {
      const cur = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(cur); localStorage.setItem(KEY, cur);
      renderTrend();
    });
  }

  function fillBrowseThemes() {
    const sel = $("#browseTheme");
    const groups = {};
    state.cfg.themes.forEach((t) => { (groups[t.group] = groups[t.group] || []).push(t); });
    Object.entries(groups).forEach(([g, list]) => {
      const og = document.createElement("optgroup"); og.label = g;
      list.forEach((t) => {
        const o = document.createElement("option"); o.value = t.id; o.textContent = t.label; og.appendChild(o);
      });
      sel.appendChild(og);
    });
  }

  async function boot() {
    try {
      state.cfg = await fetch("data/autophagy.json").then((r) => {
        if (!r.ok) throw new Error("config not found");
        return r.json();
      });
    } catch (err) {
      $("#app").innerHTML = `<div class="card"><p>Couldn't load <code>data/autophagy.json</code> (${esc(err.message)}).</p></div>`;
      return;
    }
    fillBrowseThemes();
    buildRadar();
    renderTrend();
    updateScope();
    wireWindow();
    wireKey();
    wireAudio();

    $("#briefPlay").addEventListener("click", () => runBriefing(null, true));
    $("#briefRead").addEventListener("click", () => runBriefing(null, false));
    $("#rate").addEventListener("input", () => { if (state.lastSummaryText && window.speechSynthesis && window.speechSynthesis.speaking) speak(state.lastSummaryText); });
    $("#browseGo").addEventListener("click", runBrowse);

    $("#app").setAttribute("aria-busy", "false");
  }

  setupTheme();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
