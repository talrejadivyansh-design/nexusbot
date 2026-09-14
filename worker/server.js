import express from "express";
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { buildCoachMessages, extractJson, VISION_MODEL } from "./coach.js";

const PORT = process.env.PORT || 10000;
const WORKER_SECRET = process.env.WORKER_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const JOB_TIME_BUDGET_MS = 6 * 60 * 1000;
const PAGE_READY_TIMEOUT_MS = 60 * 1000;
const JOB_HARD_TIMEOUT_MS = 10 * 60 * 1000;

if (!WORKER_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required env vars: WORKER_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const app = express();
app.use(express.json());
app.use(express.static("public"));

app.get("/", (_req, res) => res.status(200).send("cricket coach worker ok"));

let isProcessing = false;

app.post("/process", (req, res) => {
  if (req.headers["x-worker-secret"] !== WORKER_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.status(202).json({ started: true });
  if (isProcessing) return;
  isProcessing = true;
  drainQueue()
    .catch((err) => console.error("drainQueue error:", err))
    .finally(() => { isProcessing = false; });
});

async function drainQueue() {
  const deadline = Date.now() + JOB_TIME_BUDGET_MS;
  while (Date.now() < deadline) {
    const { data: jobs, error } = await supabase
      .from("analysis_jobs")
      .select("*")
      .eq("status", "queued")
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) { console.error("queue fetch error:", error.message); return; }
    if (!jobs || !jobs.length) return;
    await processJob(jobs[0]);
  }
}

async function processJob(job) {
  console.log("processing job", job.id);
  await supabase.from("analysis_jobs").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", job.id);

  try {
    const result = await withTimeout(runJob(job), JOB_HARD_TIMEOUT_MS, "Analysis timed out");
    await supabase.from("analysis_jobs").update({
      status: "done", result_session_id: result.sessionId, updated_at: new Date().toISOString(),
    }).eq("id", job.id);
    await supabase.storage.from("batting-videos").remove(job.video_paths);
    console.log("job done", job.id, "session", result.sessionId);
  } catch (err) {
    console.error("job failed", job.id, err);
    await supabase.from("analysis_jobs").update({
      status: "failed", error: String(err.message || err), updated_at: new Date().toISOString(),
    }).eq("id", job.id);
  }
}

async function runJob(job) {
  const signedUrls = [];
  for (const path of job.video_paths) {
    const { data, error } = await supabase.storage.from("batting-videos").createSignedUrl(path, 1800);
    if (error) throw new Error("Could not access uploaded video: " + error.message);
    signedUrls.push(data.signedUrl);
  }

  const analysis = await runPoseAnalysis(signedUrls, job.handedness || "right");

  const { data: priorSessions } = await supabase
    .from("analysis_sessions")
    .select("created_at, technical_score, weaknesses")
    .eq("user_id", job.user_id)
    .order("created_at", { ascending: false })
    .limit(5);
  const priorSessionsSummary = (priorSessions || []).map((s) => ({
    date: s.created_at, technical_score: s.technical_score, top_weakness: s.weaknesses?.[0]?.issue || null,
  }));

  const messages = buildCoachMessages({
    handedness: job.handedness,
    sessionLabel: job.label,
    metrics: { perVideo: analysis.perVideoMetrics, aggregated: analysis.aggregated },
    benchmarks: analysis.benchmarks,
    keyFrames: analysis.keyFrames,
    priorSessionsSummary,
  });
  const report = await callGroq(messages);

  const { data: session, error: insertErr } = await supabase
    .from("analysis_sessions")
    .insert({
      user_id: job.user_id,
      label: job.label || null,
      video_count: job.video_paths.length,
      technical_score: report.technical_score,
      summary: report.summary,
      strengths: report.strengths || [],
      weaknesses: report.weaknesses || [],
      drills: (report.weaknesses || []).map((w) => w.drill).filter(Boolean),
      phase_metrics: { perVideo: analysis.perVideoMetrics, aggregated: analysis.aggregated },
      benchmark_comparison: analysis.benchmarks,
      coach_report: report.coach_report,
    })
    .select("id")
    .single();
  if (insertErr) throw new Error("Could not save session: " + insertErr.message);

  return { sessionId: session.id };
}

async function runPoseAnalysis(urls, handedness) {
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"] });
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log("[page]", msg.text()));
    await page.goto(`http://localhost:${PORT}/harness.html`);
    await page.waitForFunction(() => window.__ready === true, { timeout: PAGE_READY_TIMEOUT_MS });
    return await page.evaluate(
      ([urls, handedness]) => window.__runSession(urls, handedness),
      [urls, handedness]
    );
  } finally {
    await browser.close();
  }
}

async function callGroq(messages) {
  const keys = [
    process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_1, process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3, process.env.GROQ_API_KEY_4,
  ].filter(Boolean);
  const key = keys[Math.floor(Math.random() * keys.length)];
  if (!key) throw new Error("No Groq API key configured on the worker");

  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages,
      max_tokens: 2200,
      temperature: 0.4,
      response_format: { type: "json_object" },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Coach model request failed");
  const raw = data.choices?.[0]?.message?.content || "";
  const report = extractJson(raw);
  if (!report) throw new Error("Could not parse coach report");
  return report;
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

app.listen(PORT, () => console.log("cricket coach worker listening on " + PORT));
