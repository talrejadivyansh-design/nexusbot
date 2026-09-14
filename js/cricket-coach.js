import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
import { analyzeVideoFile, BENCHMARKS, compareToBenchmarks, aggregateMetrics } from "./pose-engine.js";

const SUPABASE_URL = "https://xbuapfvanmtxwdaoacvr.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhidWFwZnZhbm10eHdkYW9hY3ZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzOTg2MDQsImV4cCI6MjEwNDk3NDYwNH0.O8kxjrCqZoKBZXRZl5boJgXV_f0rXejqsTratJI5Yx0";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const API_ENDPOINT = "/api/cricket-coach";
const $ = (id) => document.getElementById(id);

let currentUser = null;
let selectedFiles = [];
let lastSessionPayload = null; // {metrics, benchmarks, keyFrames}
let sessionsCache = [];
let careerCache = [];

// ---------- Auth ----------

async function refreshAuthUI() {
  const { data } = await supabase.auth.getUser();
  currentUser = data?.user || null;
  $("authStatus").textContent = currentUser ? currentUser.email : "Not signed in";
  $("authForm").hidden = !!currentUser;
  $("signOutBtn").hidden = !currentUser;
  $("cloudNotice").hidden = !!currentUser;
  if (currentUser) {
    await loadSessions();
    await loadCareerScores();
  } else {
    sessionsCache = [];
    careerCache = [];
    renderHistory();
    renderCareer();
  }
}

$("signUpBtn").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  if (!email || password.length < 6) return setAuthMsg("Enter an email and a password (6+ chars).");
  const { error } = await supabase.auth.signUp({ email, password });
  setAuthMsg(error ? error.message : "Account created. If email confirmation is required, check your inbox, then sign in.");
  if (!error) await refreshAuthUI();
});

$("signInBtn").addEventListener("click", async () => {
  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  setAuthMsg(error ? error.message : "");
  await refreshAuthUI();
});

$("signOutBtn").addEventListener("click", async () => {
  await supabase.auth.signOut();
  await refreshAuthUI();
});

function setAuthMsg(msg) { $("authMsg").textContent = msg || ""; }

// ---------- Tabs ----------

document.querySelectorAll(".tabbtn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabbtn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tabpanel").forEach((p) => p.hidden = true);
    btn.classList.add("active");
    $(btn.dataset.tab).hidden = false;
  });
});

// ---------- Video upload ----------

$("videoInput").addEventListener("change", (e) => {
  selectedFiles = selectedFiles.concat(Array.from(e.target.files));
  renderFileList();
  e.target.value = "";
});

function renderFileList() {
  const wrap = $("fileList");
  wrap.innerHTML = "";
  selectedFiles.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "filerow";
    row.innerHTML = `<span>${escapeHtml(f.name)}</span><button type="button" data-i="${i}">✕</button>`;
    row.querySelector("button").addEventListener("click", () => {
      selectedFiles.splice(i, 1);
      renderFileList();
    });
    wrap.appendChild(row);
  });
  $("analyzeBtn").disabled = selectedFiles.length === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- Analysis pipeline ----------

$("analyzeBtn").addEventListener("click", runAnalysis);

async function runAnalysis() {
  if (!selectedFiles.length) return;
  const handedness = $("handedness").value;
  const label = $("sessionLabel").value.trim();
  $("analyzeBtn").disabled = true;
  $("progressWrap").hidden = false;
  $("reportWrap").hidden = true;
  const log = $("progressLog");
  log.textContent = "";

  const perVideoMetrics = [];
  const allKeyFrames = [];

  try {
    for (let i = 0; i < selectedFiles.length; i++) {
      const f = selectedFiles[i];
      logLine(log, `Video ${i + 1}/${selectedFiles.length}: ${f.name} — loading & extracting pose...`);
      const result = await analyzeVideoFile(f, handedness, (frac, stage) => {
        setProgress(((i + frac) / selectedFiles.length) * 100);
      });
      perVideoMetrics.push(result.metrics);
      result.keyFrames.forEach((kf) => allKeyFrames.push({ ...kf, videoIndex: i }));
      logLine(log, `Video ${i + 1}: done (${result.sampleCount} frames sampled).`);
    }

    logLine(log, "Aggregating metrics across videos...");
    const aggregated = aggregateMetrics(perVideoMetrics);
    const meanOnly = Object.fromEntries(Object.entries(aggregated).map(([k, v]) => [k, v?.mean ?? null]));
    const benchmarks = compareToBenchmarks(meanOnly);

    // Cap frames sent to the model: prefer impact + backlift_top across videos, then others.
    const priority = { impact: 0, backlift_top: 1, follow_through: 2, downswing: 3, stance: 4 };
    const keyFramesToSend = allKeyFrames
      .slice()
      .sort((a, b) => (priority[a.phase] - priority[b.phase]) || (a.videoIndex - b.videoIndex))
      .slice(0, 8);

    logLine(log, "Sending to your coach for review (this can take a little while)...");
    const priorSessionsSummary = sessionsCache.slice(0, 5).map((s) => ({
      date: s.created_at, technical_score: s.technical_score, top_weakness: s.weaknesses?.[0]?.issue || null,
    }));

    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "technique",
        handedness,
        sessionLabel: label,
        metrics: { perVideo: perVideoMetrics, aggregated },
        benchmarks,
        keyFrames: keyFramesToSend,
        priorSessionsSummary,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Coach request failed");

    lastSessionPayload = {
      metrics: { perVideo: perVideoMetrics, aggregated },
      benchmarks,
      report: data.report,
      video_count: selectedFiles.length,
      label,
    };

    renderReport(data.report, benchmarks);
    $("saveSessionBtn").hidden = !currentUser;
    logLine(log, "Done.");
  } catch (err) {
    logLine(log, "Error: " + err.message);
  } finally {
    $("analyzeBtn").disabled = false;
  }
}

function setProgress(pct) { $("progressBar").style.width = Math.min(100, pct) + "%"; }
function logLine(el, text) { el.textContent += text + "\n"; el.scrollTop = el.scrollHeight; }

function scoreColor(score) {
  if (score >= 75) return "var(--green)";
  if (score >= 50) return "var(--amber)";
  return "var(--red)";
}

function renderReport(report, benchmarks) {
  $("reportWrap").hidden = false;
  $("scoreNum").textContent = report.technical_score ?? "–";
  $("scoreNum").style.color = scoreColor(report.technical_score || 0);
  $("reportSummary").textContent = report.summary || "";
  $("priorityFocus").textContent = report.priority_focus || "";

  $("strengthsList").innerHTML = (report.strengths || []).map((s) => `<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>";

  $("weaknessesList").innerHTML = (report.weaknesses || []).map((w) => `
    <div class="wcard">
      <div class="wissue">${escapeHtml(w.issue)}</div>
      <div class="wwhy"><b>Why it matters:</b> ${escapeHtml(w.why_it_matters || "")}</div>
      <div class="wdrill"><b>Drill:</b> ${escapeHtml(w.drill || "")}</div>
    </div>`).join("") || "<p>No major flaws flagged.</p>";

  const pb = report.phase_breakdown || {};
  $("phaseBreakdown").innerHTML = ["stance", "backlift", "downswing", "impact", "follow_through"].map((p) => `
    <div class="phaseRow"><div class="phaseName">${p.replace("_", " ")}</div><div class="phaseText">${escapeHtml(pb[p] || "—")}</div></div>
  `).join("");

  $("coachReportText").textContent = report.coach_report || "";

  $("benchmarkTable").innerHTML = Object.entries(benchmarks).map(([k, v]) => `
    <tr class="${v.withinBenchmark ? "ok" : "flag"}">
      <td>${metricLabel(k)}</td><td>${v.value}</td><td>${v.target}</td>
      <td>${v.withinBenchmark ? "✓ within range" : "⚠ outside range"}</td>
    </tr>`).join("");
}

const METRIC_LABELS = {
  stanceWidthRatio: "Stance width (÷ shoulder width)",
  headLateralDriftRatio: "Head lateral drift",
  headOverFrontKneeAtImpactRatio: "Head-over-front-knee at impact",
  frontKneeFlexionChangeDeg: "Front knee flexion change (°)",
  backliftStraightnessDeviation: "Backlift/downswing straightness deviation",
  frontElbowAboveShoulderRatio: "Front elbow height vs shoulder",
  followThroughWobbleRatio: "Follow-through balance wobble",
};
function metricLabel(k) { return METRIC_LABELS[k] || k; }

// ---------- Save session ----------

$("saveSessionBtn").addEventListener("click", async () => {
  if (!currentUser || !lastSessionPayload) return;
  const r = lastSessionPayload.report;
  const { error } = await supabase.from("analysis_sessions").insert({
    user_id: currentUser.id,
    label: lastSessionPayload.label || null,
    video_count: lastSessionPayload.video_count,
    technical_score: r.technical_score,
    summary: r.summary,
    strengths: r.strengths || [],
    weaknesses: r.weaknesses || [],
    drills: (r.weaknesses || []).map((w) => w.drill).filter(Boolean),
    phase_metrics: lastSessionPayload.metrics,
    benchmark_comparison: lastSessionPayload.benchmarks,
    coach_report: r.coach_report,
  });
  if (error) { alert("Could not save: " + error.message); return; }
  $("saveSessionBtn").textContent = "Saved ✓";
  setTimeout(() => { $("saveSessionBtn").textContent = "Save to history"; }, 2000);
  await loadSessions();
});

// ---------- History ----------

async function loadSessions() {
  if (!currentUser) return;
  const { data, error } = await supabase
    .from("analysis_sessions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (!error) sessionsCache = data || [];
  renderHistory();
}

function renderHistory() {
  const wrap = $("historyList");
  if (!currentUser) { wrap.innerHTML = "<p class='muted'>Sign in to see your saved session history.</p>"; $("trendChart").innerHTML = ""; return; }
  if (!sessionsCache.length) { wrap.innerHTML = "<p class='muted'>No saved sessions yet — analyze a video and save it.</p>"; $("trendChart").innerHTML = ""; return; }

  wrap.innerHTML = sessionsCache.map((s, i) => `
    <div class="histcard">
      <div class="histtop">
        <span class="histscore" style="color:${scoreColor(s.technical_score || 0)}">${s.technical_score ?? "–"}</span>
        <span class="histdate">${new Date(s.created_at).toLocaleDateString()}</span>
        ${s.label ? `<span class="histlabel">${escapeHtml(s.label)}</span>` : ""}
      </div>
      <div class="histsummary">${escapeHtml(s.summary || "")}</div>
      <details><summary>Full report</summary>
        <div class="histweak"><b>Weaknesses:</b> ${(s.weaknesses || []).map((w) => escapeHtml(w.issue)).join("; ") || "—"}</div>
        <div class="histreport">${escapeHtml(s.coach_report || "")}</div>
      </details>
    </div>`).join("");

  renderTrendChart();
}

function renderTrendChart() {
  const pts = sessionsCache.slice().reverse().filter((s) => s.technical_score != null);
  const svgEl = $("trendChart");
  if (pts.length < 2) { svgEl.innerHTML = "<p class='muted'>Save at least 2 sessions to see your trend line.</p>"; return; }
  const w = 640, h = 200, pad = 30;
  const xs = pts.map((_, i) => pad + (i * (w - 2 * pad)) / (pts.length - 1));
  const ys = pts.map((p) => h - pad - (p.technical_score / 100) * (h - 2 * pad));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x},${ys[i]}`).join(" ");
  const dots = xs.map((x, i) => `<circle cx="${x}" cy="${ys[i]}" r="4" fill="var(--accent)"><title>${new Date(pts[i].created_at).toLocaleDateString()}: ${pts[i].technical_score}</title></circle>`).join("");
  svgEl.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border)"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="var(--border)"/>
    <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2"/>
    ${dots}
  </svg>`;
}

// ---------- Career scores ----------

$("addScoreBtn").addEventListener("click", async () => {
  if (!currentUser) return alert("Sign in to save your career scores.");
  const entry = {
    user_id: currentUser.id,
    match_date: $("scoreDate").value,
    format: $("scoreFormat").value,
    opposition: $("scoreOpp").value.trim() || null,
    runs: numOrNull($("scoreRuns").value),
    balls_faced: numOrNull($("scoreBalls").value),
    fours: numOrNull($("score4s").value),
    sixes: numOrNull($("score6s").value),
    dismissal: $("scoreDismissal").value.trim() || null,
    notes: $("scoreNotes").value.trim() || null,
  };
  if (!entry.match_date) return alert("Enter a date.");
  const { error } = await supabase.from("career_scores").insert(entry);
  if (error) return alert("Could not save: " + error.message);
  ["scoreOpp", "scoreRuns", "scoreBalls", "score4s", "score6s", "scoreDismissal", "scoreNotes"].forEach((id) => $(id).value = "");
  await loadCareerScores();
});

function numOrNull(v) { return v === "" || v === null || v === undefined ? null : Number(v); }

async function loadCareerScores() {
  if (!currentUser) return;
  const { data, error } = await supabase
    .from("career_scores")
    .select("*")
    .order("match_date", { ascending: false })
    .limit(500);
  if (!error) careerCache = data || [];
  renderCareer();
}

function renderCareer() {
  const wrap = $("careerTable");
  if (!currentUser) { wrap.innerHTML = "<p class='muted'>Sign in to track your career scores.</p>"; $("careerStats").innerHTML = ""; $("careerChart").innerHTML = ""; return; }
  if (!careerCache.length) { wrap.innerHTML = "<p class='muted'>No scores logged yet. Add your match history below — the more years you add, the better the trend picture.</p>"; $("careerStats").innerHTML = ""; $("careerChart").innerHTML = ""; return; }

  wrap.innerHTML = `<table class="scoretable"><thead><tr>
      <th>Date</th><th>Format</th><th>Opp</th><th>Runs</th><th>Balls</th><th>4s</th><th>6s</th><th>Dismissal</th><th></th>
    </tr></thead><tbody>` + careerCache.map((c) => `
      <tr>
        <td>${c.match_date}</td><td>${escapeHtml(c.format || "")}</td><td>${escapeHtml(c.opposition || "")}</td>
        <td>${c.runs ?? ""}</td><td>${c.balls_faced ?? ""}</td><td>${c.fours ?? ""}</td><td>${c.sixes ?? ""}</td>
        <td>${escapeHtml(c.dismissal || "")}</td>
        <td><button type="button" class="delscore" data-id="${c.id}">✕</button></td>
      </tr>`).join("") + "</tbody></table>";

  wrap.querySelectorAll(".delscore").forEach((btn) => btn.addEventListener("click", async () => {
    await supabase.from("career_scores").delete().eq("id", btn.dataset.id);
    await loadCareerScores();
  }));

  const withRuns = careerCache.filter((c) => c.runs != null);
  const totalRuns = withRuns.reduce((a, c) => a + c.runs, 0);
  const outs = withRuns.filter((c) => c.dismissal && c.dismissal.toLowerCase() !== "not out").length;
  const avg = outs > 0 ? (totalRuns / outs).toFixed(1) : (totalRuns / (withRuns.length || 1)).toFixed(1);
  const high = withRuns.length ? Math.max(...withRuns.map((c) => c.runs)) : 0;
  const fifties = withRuns.filter((c) => c.runs >= 50 && c.runs < 100).length;
  const hundreds = withRuns.filter((c) => c.runs >= 100).length;
  const years = new Set(careerCache.map((c) => c.match_date?.slice(0, 4))).size;

  $("careerStats").innerHTML = `
    <div class="statgrid">
      <div class="stat"><div class="statnum">${avg}</div><div class="statlbl">Average</div></div>
      <div class="stat"><div class="statnum">${high}</div><div class="statlbl">High score</div></div>
      <div class="stat"><div class="statnum">${fifties}</div><div class="statlbl">50s</div></div>
      <div class="stat"><div class="statnum">${hundreds}</div><div class="statlbl">100s</div></div>
      <div class="stat"><div class="statnum">${careerCache.length}</div><div class="statlbl">Innings logged</div></div>
      <div class="stat"><div class="statnum">${years}</div><div class="statlbl">Years covered</div></div>
    </div>`;

  renderCareerChart(withRuns);
}

function renderCareerChart(withRuns) {
  const byYear = {};
  withRuns.forEach((c) => {
    const y = c.match_date?.slice(0, 4);
    if (!y) return;
    (byYear[y] ||= []).push(c.runs);
  });
  const years = Object.keys(byYear).sort();
  const el = $("careerChart");
  if (years.length < 1) { el.innerHTML = ""; return; }
  const avgs = years.map((y) => byYear[y].reduce((a, b) => a + b, 0) / byYear[y].length);
  const w = 640, h = 200, pad = 34;
  const maxV = Math.max(...avgs, 1);
  const barW = (w - 2 * pad) / years.length;
  const bars = years.map((y, i) => {
    const bh = (avgs[i] / maxV) * (h - 2 * pad);
    const x = pad + i * barW + barW * 0.15;
    const bw = barW * 0.7;
    const yPos = h - pad - bh;
    return `<rect x="${x}" y="${yPos}" width="${bw}" height="${bh}" fill="var(--accent)"><title>${y}: avg ${avgs[i].toFixed(1)}</title></rect>
            <text x="${x + bw / 2}" y="${h - pad + 14}" font-size="10" fill="var(--muted)" text-anchor="middle">${y}</text>`;
  }).join("");
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%">
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="var(--border)"/>
    ${bars}
  </svg>`;
}

$("careerInsightBtn").addEventListener("click", async () => {
  if (!currentUser) return alert("Sign in first.");
  if (!careerCache.length) return alert("Add some career scores first.");
  $("careerInsightBtn").disabled = true;
  $("careerInsightOut").textContent = "Reviewing your career record...";
  try {
    const careerStats = {
      entries: careerCache.map((c) => ({ date: c.match_date, format: c.format, runs: c.runs, balls: c.balls_faced, fours: c.fours, sixes: c.sixes, dismissal: c.dismissal })),
    };
    const latestSession = sessionsCache[0];
    const res = await fetch(API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "career",
        careerStats,
        metrics: latestSession ? latestSession.phase_metrics : undefined,
        priorSessionsSummary: sessionsCache.slice(0, 8).map((s) => ({ date: s.created_at, technical_score: s.technical_score })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    renderCareerInsight(data.report);
  } catch (err) {
    $("careerInsightOut").textContent = "Error: " + err.message;
  } finally {
    $("careerInsightBtn").disabled = false;
  }
});

function renderCareerInsight(r) {
  $("careerInsightOut").innerHTML = `
    <div class="score" style="color:${scoreColor(r.career_score || 0)}">${r.career_score ?? "–"}<span class="scoreOf">/100</span></div>
    <p>${escapeHtml(r.summary || "")}</p>
    <p><b>Trend:</b> ${escapeHtml(r.trend || "")}</p>
    <p><b>vs. professional benchmarks:</b> ${escapeHtml(r.pro_comparison || "")}</p>
    <p><b>Priority focus:</b> ${escapeHtml(r.priority_focus || "")}</p>
    <div class="wlist">${(r.weaknesses || []).map((w) => `<div class="wcard"><div class="wissue">${escapeHtml(w.issue)}</div><div class="wwhy">${escapeHtml(w.why_it_matters || "")}</div><div class="wdrill">${escapeHtml(w.drill || "")}</div></div>`).join("")}</div>
    <p class="coachtext">${escapeHtml(r.coach_report || "")}</p>`;
}

// ---------- Benchmark reference table (static, shown on load) ----------
function renderBenchmarkReference() {
  $("benchmarkRef").innerHTML = Object.entries(BENCHMARKS).map(([k, v]) => `<li><b>${metricLabel(k)}:</b> ${v.note} (target ${v.min}–${v.max})</li>`).join("");
}

// ---------- Init ----------
renderBenchmarkReference();
supabase.auth.onAuthStateChange(() => refreshAuthUI());
refreshAuthUI();
