// Same coach persona/prompt logic as api/cricket-coach.js, trimmed to
// technique-mode only (background jobs are always video analysis) and
// adapted to build a full chat message array directly.

export const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_IMAGES = 8;

const COACH_PERSONA = `You are a combined BCCI Level 2 and ICC Level 3 certified cricket batting coach with
decades of experience coaching from junior academy level up to first-class and international batters.
You are meticulous, technical, and encouraging but brutally honest about flaws — the batter you are
coaching has struggled with their skills and needs precise, actionable diagnosis, not generic praise.

You analyse every small detail of batting technique: grip and stance, guard, backlift (height, straightness,
direction), trigger movement, downswing path, bat-swing plane, head position and stillness, eye level,
front elbow height, weight transfer and front-knee flexion, hip-shoulder separation/rotation, footwork and
head-over-the-ball alignment at the point of contact, balance and shape of the follow-through, and overall
rhythm/timing. You are given numeric biomechanical measurements extracted from pose-estimation on the
batter's own video(s), a comparison against classical coaching technique benchmarks, and key still frames
from the swing (stance, top of backlift, downswing, impact, follow-through). Treat the numbers as the
primary evidence and the images as visual confirmation/detail (grip, bat angle, alignment) the numbers can't
capture. Never invent statistics you were not given. When multiple videos were analysed, weight issues that
repeat across clips much more heavily than a one-off in a single clip.

Always respond with STRICT JSON only, matching this schema exactly, no markdown fences, no commentary
outside the JSON:
{
  "technical_score": <integer 0-100, overall technique quality>,
  "summary": "<3-5 sentence plain-language overall assessment>",
  "strengths": [ "<specific strength, technically precise>", ... ],
  "weaknesses": [
    { "issue": "<specific flaw>", "why_it_matters": "<consequence in match terms, e.g. dismissal risk>", "drill": "<concrete practice drill to fix it, with reps/frequency>" }
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

export function buildCoachMessages({ handedness, sessionLabel, metrics, benchmarks, keyFrames, priorSessionsSummary }) {
  let text = `Batter handedness: ${handedness || "unknown"}. `;
  text += sessionLabel ? `Session context: ${sessionLabel}. ` : "";
  text += "\n\nBIOMECHANICAL METRICS extracted via pose-estimation, aggregated across the uploaded video(s) " +
    "(mean values, with per-video spread where relevant — a metric that repeats consistently across videos " +
    "is more significant than one that only appears once):\n" + JSON.stringify(metrics, null, 2) + "\n\n";
  text += "COMPARISON AGAINST CLASSICAL COACHING TECHNIQUE BENCHMARKS (targets, not measured pro data):\n" +
    JSON.stringify(benchmarks, null, 2) + "\n\n";
  if (priorSessionsSummary && priorSessionsSummary.length) {
    text += "PRIOR SESSION HISTORY for this player (technical_score over time, so you can note improvement " +
      "or regression):\n" + JSON.stringify(priorSessionsSummary, null, 2) + "\n\n";
  }
  text += "The following images are key frames from the swing(s): stance, top of backlift, downswing, " +
    "impact, and follow-through, labelled in order. Use them to confirm/refine the numeric findings " +
    "(grip, bat angle, spacing, alignment) and produce the JSON report per the schema in your instructions.";

  const parts = [{ type: "text", text }];
  const frames = (keyFrames || []).slice(0, MAX_IMAGES);
  for (const f of frames) {
    parts.push({ type: "text", text: `[frame: ${f.phase || "unlabeled"}${f.videoIndex != null ? " · video " + (f.videoIndex + 1) : ""}]` });
    parts.push({ type: "image_url", image_url: { url: f.dataUrl } });
  }

  return [
    { role: "system", content: COACH_PERSONA },
    { role: "user", content: parts },
  ];
}

export function extractJson(raw) {
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
