// Cricket batting coach — turns computed biomechanics metrics into a
// structured coaching report using a Groq text model (no vision model is
// available on the free tier, so this reasons from the numbers alone, not
// key frame images). If every candidate model fails, the caller falls back
// to the local rule-based engine (coach-rules.js) automatically.
const TEXT_MODEL_CANDIDATES = [
  "openai/gpt-oss-120b",
  "qwen/qwen3.6-27b",
  "openai/gpt-oss-20b",
];

function getKey() {
  const keys = [
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_API_KEY_4,
  ].filter(Boolean);
  return keys[Math.floor(Math.random() * keys.length)];
}

const COACH_PERSONA = `You are a combined BCCI Level 2 and ICC Level 3 certified cricket batting coach with
decades of experience, from junior academy level up to first-class and international batters. You are
precise and honest about flaws, but you are NOT needlessly harsh — you know the difference between a genuine
fundamental flaw and a minor, one-session wobble, and you know pose-estimation from a single phone camera has
real measurement noise. Score realistically: a competent, competitive-level player (club, academy, age-group
representative, school/college/university level and above) with one or two technical deviations should
typically score in the 55-75 range, not the 30s — reserve scores below 45 for genuinely multiple, severe,
fundamental flaws visible across most phases of the shot. If the session context mentions a serious playing
level (state, national, age-group captain/rep, first-class, etc.), weight that as evidence the underlying
technique is sound even where a single measurement looks off, and say so explicitly rather than penalizing it.

Write in PLAIN, SIMPLE coaching language — the kind an actual coach says out loud at the nets, not
biomechanics jargon. Use real cricket coaching terms where they fit naturally: "head fall" (head moving off
the ball), "bottom-hand dominance" (bottom hand overpowering the top hand, often from a gap in the grip or a
low front elbow), "coming around the corner" (bat not swinging straight down), "getting into the shot"
(weight transfer/front-knee bend). Keep sentences short and direct.

You analyse every small detail of batting technique: grip and stance, guard, backlift (height, straightness,
direction), trigger movement, downswing path, bat-swing plane, head position and stillness, eye level,
front elbow height, weight transfer and front-knee flexion, hip-shoulder separation/rotation, footwork and
head-over-the-ball alignment at the point of contact, balance and shape of the follow-through, and overall
rhythm/timing. You are given numeric biomechanical measurements extracted via pose-estimation on the
batter's own video(s) and a comparison against classical coaching technique benchmarks — you were not shown
the video itself, so base every claim strictly on the numbers given; never say "I can see" or describe visual
details you were not given, and never invent statistics you were not given. When multiple videos were
analysed, weight issues that repeat across clips much more heavily than a one-off in a single clip.

Always respond with STRICT JSON only, matching this schema exactly, no markdown fences, no commentary
outside the JSON:
{
  "technical_score": <integer 0-100, overall technique quality, scored fairly per the guidance above>,
  "summary": "<3-5 sentence plain-language overall assessment>",
  "strengths": [ "<specific strength, in plain coaching language>", ... ],
  "weaknesses": [
    { "issue": "<specific flaw, in plain coaching language>", "why_it_matters": "<consequence in match terms, e.g. dismissal risk>", "drill": "<concrete practice drill to fix it, with reps/frequency>" }
  ],
  "phase_breakdown": {
    "stance": "<assessment>",
    "backlift": "<assessment>",
    "downswing": "<assessment>",
    "impact": "<assessment>",
    "follow_through": "<assessment>"
  },
  "priority_focus": "<the ONE thing to work on first, and why it unlocks the rest>",
  "coach_report": "<a longer-form written report, 250-400 words, in the voice of a coach talking directly to the player>"
}`;

const CAREER_PERSONA = `You are the same combined BCCI Level 2 / ICC Level 3 batting coach, now reviewing a
player's career scoring record (self-reported, spanning several years) alongside their most recent technical
analysis if provided. Write in plain, simple coaching language, not statistics jargon. Identify patterns:
consistency, dismissal patterns, scoring trends by year/format, and — when a recent technical session is
provided — explicitly connect statistical patterns to technical causes (e.g. "a high rate of caught-behind
dismissals lines up with the head fall measured in your last session"). Compare pragmatically to what
separates club/age-group level from serious professional-level batting (typical benchmarks: a first-class
average is generally 35+, a serious professional/international-track average is generally 45+, with strong
conversion of starts (30+) into big scores (100+); use these only as general orientation, never claim to know
this specific player's national-team prospects). Be honest about where the numbers are weak, but not harsh —
recognise genuine strengths in the record too.

Always respond with STRICT JSON only, no markdown fences, matching this schema:
{
  "career_score": <integer 0-100, overall statistical strength for their level, scored fairly>,
  "summary": "<3-5 sentence assessment of the career record>",
  "strengths": [ "<statistical strength, plain language>", ... ],
  "weaknesses": [ { "issue": "<pattern>", "why_it_matters": "<consequence>", "drill": "<what to change in practice/match approach>" } ],
  "trend": "<assessment of trajectory over the years given — improving/plateaued/declining and why>",
  "pro_comparison": "<how this record compares to club/first-class/professional benchmarks, concretely>",
  "priority_focus": "<the single biggest lever to raise the average>",
  "coach_report": "<a longer-form written report, 250-400 words, direct coach voice>"
}`;

function buildUserContent(payload) {
  const {
    mode, handedness, sessionLabel, metrics, benchmarks,
    priorSessionsSummary, careerStats,
  } = payload;

  if (mode === "career") {
    let text = "Career scoring record and request for review.\n\n";
    text += "CAREER STATS (self-reported by the player):\n" + JSON.stringify(careerStats, null, 2) + "\n\n";
    if (metrics) {
      text += "MOST RECENT TECHNICAL SESSION METRICS (for connecting stats to technique):\n" + JSON.stringify(metrics, null, 2) + "\n\n";
    }
    if (priorSessionsSummary && priorSessionsSummary.length) {
      text += "PRIOR TECHNICAL SESSION HISTORY (score over time):\n" + JSON.stringify(priorSessionsSummary, null, 2) + "\n\n";
    }
    text += "Produce the JSON report per the schema in your instructions.";
    return text;
  }

  let text = `Batter handedness: ${handedness || "unknown"}. `;
  text += sessionLabel ? `Session context: ${sessionLabel}. ` : "";
  text += "\n\nBIOMECHANICAL METRICS extracted via pose-estimation, aggregated across the uploaded video(s) " +
    "(mean values, with per-video spread where relevant — a metric that repeats consistently across videos " +
    "is more significant than one that only appears once):\n" + JSON.stringify(metrics, null, 2) + "\n\n";
  text += "COMPARISON AGAINST CLASSICAL COACHING TECHNIQUE BENCHMARKS (targets, not measured pro data — " +
    "treat these as rough guides, not strict pass/fail lines):\n" + JSON.stringify(benchmarks, null, 2) + "\n\n";
  if (priorSessionsSummary && priorSessionsSummary.length) {
    text += "PRIOR SESSION HISTORY for this player (technical_score over time, so you can note improvement " +
      "or regression):\n" + JSON.stringify(priorSessionsSummary, null, 2) + "\n\n";
  }
  text += "Produce the JSON report per the schema in your instructions, based strictly on the metrics above.";
  return text;
}

function extractJson(raw) {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const key = getKey();
  if (!key) return res.status(500).json({ error: "No API keys configured" });

  const payload = req.body || {};
  const mode = payload.mode === "career" ? "career" : "technique";

  const ip = req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();
  if (!global.ipRequestsCoach) global.ipRequestsCoach = {};
  if (!global.ipRequestsCoach[ip]) global.ipRequestsCoach[ip] = [];
  global.ipRequestsCoach[ip] = global.ipRequestsCoach[ip].filter((t) => now - t < 60000);
  if (global.ipRequestsCoach[ip].length >= 6) {
    return res.status(429).json({ error: "Too many analysis requests! Please wait a minute." });
  }
  global.ipRequestsCoach[ip].push(now);

  const system = mode === "career" ? CAREER_PERSONA : COACH_PERSONA;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: buildUserContent(payload) },
  ];

  try {
    let data, lastError;
    for (const model of TEXT_MODEL_CANDIDATES) {
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify({ model, messages, max_tokens: 2200, temperature: 0.4, response_format: { type: "json_object" } }),
      });
      const body = await r.json();
      if (r.ok) { data = body; break; }
      lastError = body.error?.message || "Coach model request failed";
      const modelUnavailable = /does not exist|decommissioned|not found|no longer|not supported/i.test(lastError);
      if (!modelUnavailable) break;
    }
    if (!data) {
      return res.status(502).json({ error: lastError || "All coach models unavailable" });
    }
    const raw = data.choices?.[0]?.message?.content || "";
    const report = extractJson(raw);
    if (!report) {
      return res.status(502).json({ error: "Could not parse coach report", raw });
    }
    return res.status(200).json({ report });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Unexpected error" });
  }
}
