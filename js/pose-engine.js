// In-browser pose estimation + cricket batting biomechanics extraction.
// Uses MediaPipe Tasks Vision (WASM, runs fully client-side) to pull 33-point
// body landmarks from sampled frames of an uploaded video, detects the five
// batting phases from hand-speed profile, and derives coaching metrics.

import { PoseLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs";

const CDN_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_heavy/float16/1/pose_landmarker_heavy.task";

const L = {
  NOSE: 0,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_FOOT: 31, R_FOOT: 32,
};

let landmarkerPromise = null;
async function getLandmarker() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    const vision = await FilesetResolver.forVisionTasks(CDN_BASE);
    const common = {
      baseOptions: { modelAssetPath: MODEL_URL },
      runningMode: "VIDEO",
      numPoses: 1,
    };
    try {
      return await PoseLandmarker.createFromOptions(vision, {
        ...common,
        baseOptions: { ...common.baseOptions, delegate: "GPU" },
      });
    } catch {
      return await PoseLandmarker.createFromOptions(vision, {
        ...common,
        baseOptions: { ...common.baseOptions, delegate: "CPU" },
      });
    }
  })();
  return landmarkerPromise;
}

function seekTo(video, t) {
  return new Promise((resolve) => {
    if (Math.abs(video.currentTime - t) < 0.004) return resolve();
    const onSeeked = () => { video.removeEventListener("seeked", onSeeked); resolve(); };
    video.addEventListener("seeked", onSeeked);
    video.currentTime = t;
  });
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0)); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z || 0) + (b.z || 0)) / 2 }; }

// Angle at b (degrees) between rays b->a and b->c, using 3D world coordinates.
function angleAt(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) };
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z || 0) - (b.z || 0) };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const m1 = Math.hypot(v1.x, v1.y, v1.z), m2 = Math.hypot(v2.x, v2.y, v2.z);
  if (!m1 || !m2) return null;
  return (Math.acos(Math.min(1, Math.max(-1, dot / (m1 * m2)))) * 180) / Math.PI;
}

const VIS_THRESHOLD = 0.4;
function usable(pts, indices) {
  return indices.every((i) => pts[i] && (pts[i].visibility === undefined || pts[i].visibility > VIS_THRESHOLD));
}

/**
 * Extracts a landmark time-series from a video file by sampling frames at a
 * fixed interval (seek + detect), then detects batting phases and computes
 * biomechanics metrics. `onProgress(fraction, stage)` is called throughout.
 */
export async function analyzeVideoFile(file, handedness, onProgress) {
  const landmarker = await getLandmarker();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("Could not load video: " + file.name)), { once: true });
  });

  const duration = video.duration;
  const targetSamples = Math.min(150, Math.max(30, Math.round(duration * 30)));
  const dt = duration / targetSamples;

  const series = [];
  let ts = 1;
  for (let i = 0; i <= targetSamples; i++) {
    const t = Math.min(duration - 0.001, i * dt);
    await seekTo(video, t);
    const result = landmarker.detectForVideo(video, ts++);
    const lm = result.landmarks && result.landmarks[0];
    const wlm = result.worldLandmarks && result.worldLandmarks[0];
    if (lm && wlm) series.push({ t, img: lm, world: wlm });
    if (onProgress) onProgress((i + 1) / (targetSamples + 1), "pose");
  }

  if (series.length < 8) {
    throw new Error(`Could not reliably detect a person's body in "${file.name}". Try a clearer, closer, well-lit clip.`);
  }

  const front = handedness === "left" ? "R" : "L";
  const back = front === "L" ? "R" : "L";
  const idx = {
    frontShoulder: L[`${front}_SHOULDER`], backShoulder: L[`${back}_SHOULDER`],
    frontElbow: L[`${front}_ELBOW`], backElbow: L[`${back}_ELBOW`],
    frontWrist: L[`${front}_WRIST`], backWrist: L[`${back}_WRIST`],
    frontHip: L[`${front}_HIP`], backHip: L[`${back}_HIP`],
    frontKnee: L[`${front}_KNEE`], backKnee: L[`${back}_KNEE`],
    frontAnkle: L[`${front}_ANKLE`], backAnkle: L[`${back}_ANKLE`],
  };

  // Bat-hand proxy: midpoint of both wrists (both hands grip near the same spot).
  const handProxy = series.map((s) => mid(s.img[L.L_WRIST], s.img[L.R_WRIST]));
  const speeds = [0];
  for (let i = 1; i < series.length; i++) {
    const dtStep = series[i].t - series[i - 1].t || 1 / 30;
    speeds.push(dist(handProxy[i], handProxy[i - 1]) / dtStep);
  }
  // Smooth with a small moving average.
  const smoothed = speeds.map((_, i) => {
    const win = speeds.slice(Math.max(0, i - 2), i + 3);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });

  const maxSpeed = Math.max(...smoothed);
  const impactIdx = smoothed.indexOf(maxSpeed);

  const stanceThreshold = maxSpeed * 0.12;
  let stanceEndIdx = 0;
  for (let i = 0; i < impactIdx; i++) {
    if (smoothed[i] > stanceThreshold) { stanceEndIdx = i; break; }
    stanceEndIdx = i;
  }
  const stanceStartIdx = 0;

  // Top of backlift: highest point (min image-y) of the hand proxy between
  // stance end and impact.
  let backliftTopIdx = stanceEndIdx;
  let minY = Infinity;
  for (let i = stanceEndIdx; i <= impactIdx; i++) {
    if (handProxy[i].y < minY) { minY = handProxy[i].y; backliftTopIdx = i; }
  }
  if (backliftTopIdx >= impactIdx) backliftTopIdx = Math.max(stanceEndIdx, impactIdx - 1);

  let followEndIdx = series.length - 1;
  for (let i = impactIdx + 1; i < series.length; i++) {
    if (smoothed[i] < stanceThreshold) { followEndIdx = i; break; }
    followEndIdx = i;
  }

  const shoulderWidth = (i) => dist(series[i].img[L.L_SHOULDER], series[i].img[L.R_SHOULDER]) || 0.15;
  const torsoLen = (i) => dist(mid(series[i].img[L.L_SHOULDER], series[i].img[L.R_SHOULDER]), mid(series[i].img[L.L_HIP], series[i].img[L.R_HIP])) || 0.25;

  const sw0 = shoulderWidth(stanceStartIdx);
  const noseX0 = series[stanceStartIdx].img[L.NOSE].x;

  let headDriftMax = 0;
  for (let i = stanceStartIdx; i <= impactIdx; i++) {
    const d = Math.abs(series[i].img[L.NOSE].x - noseX0) / sw0;
    if (d > headDriftMax) headDriftMax = d;
  }

  const headOverFrontKneeAtImpact = usable(series[impactIdx].img, [idx.frontKnee, L.NOSE])
    ? Math.abs(series[impactIdx].img[L.NOSE].x - series[impactIdx].img[idx.frontKnee].x) / shoulderWidth(impactIdx)
    : null;

  const frontKneeAngle = (i) => usable(series[i].world, [idx.frontHip, idx.frontKnee, idx.frontAnkle])
    ? angleAt(series[i].world[idx.frontHip], series[i].world[idx.frontKnee], series[i].world[idx.frontAnkle])
    : null;
  const kneeStance = frontKneeAngle(stanceStartIdx);
  const kneeImpact = frontKneeAngle(impactIdx);
  const frontKneeFlexionChange = (kneeStance != null && kneeImpact != null) ? (kneeStance - kneeImpact) : null;

  const stanceWidthRatio = dist(series[stanceStartIdx].img[L.L_ANKLE], series[stanceStartIdx].img[L.R_ANKLE]) / sw0;

  const backliftHeightRatio = (series[stanceStartIdx].img[idx.backWrist].y - series[backliftTopIdx].img[idx.backWrist].y) / torsoLen(stanceStartIdx);

  // Straightness of the downswing hand path vs. a straight line from top-of-backlift to impact.
  let straightnessDeviationSum = 0, straightnessCount = 0;
  const p0 = handProxy[backliftTopIdx], p1 = handProxy[impactIdx];
  const lineLen = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1e-6;
  for (let i = backliftTopIdx; i <= impactIdx; i++) {
    const p = handProxy[i];
    const cross = Math.abs((p1.x - p0.x) * (p0.y - p.y) - (p0.x - p.x) * (p1.y - p0.y));
    straightnessDeviationSum += cross / lineLen;
    straightnessCount++;
  }
  const backliftStraightnessDeviation = straightnessCount ? (straightnessDeviationSum / straightnessCount) / torsoLen(impactIdx) : null;

  const frontElbowAboveShoulderRatio = usable(series[impactIdx].img, [idx.frontElbow, idx.frontShoulder])
    ? (series[impactIdx].img[idx.frontShoulder].y - series[impactIdx].img[idx.frontElbow].y) / torsoLen(impactIdx)
    : null;

  const lineAngleDeg = (a, b) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const hipShoulderSeparationDeg = (() => {
    const s = series[impactIdx].img;
    if (!usable(s, [L.L_SHOULDER, L.R_SHOULDER, L.L_HIP, L.R_HIP])) return null;
    const shoulderAngle = lineAngleDeg(s[L.L_SHOULDER], s[L.R_SHOULDER]);
    const hipAngle = lineAngleDeg(s[L.L_HIP], s[L.R_HIP]);
    let diff = Math.abs(shoulderAngle - hipAngle);
    if (diff > 90) diff = 180 - diff;
    return diff;
  })();

  const hipCenterXs = [];
  for (let i = impactIdx; i <= followEndIdx; i++) {
    hipCenterXs.push(mid(series[i].img[L.L_HIP], series[i].img[L.R_HIP]).x);
  }
  const hcMean = hipCenterXs.reduce((a, b) => a + b, 0) / (hipCenterXs.length || 1);
  const hcVar = hipCenterXs.reduce((a, b) => a + (b - hcMean) ** 2, 0) / (hipCenterXs.length || 1);
  const followThroughWobble = Math.sqrt(hcVar) / shoulderWidth(followEndIdx);

  const downswingDurationMs = Math.round((series[impactIdx].t - series[backliftTopIdx].t) * 1000);
  const totalShotDurationMs = Math.round((series[impactIdx].t - series[stanceStartIdx].t) * 1000);
  const maxHandSpeedNormalized = maxSpeed / (torsoLen(impactIdx) || 0.25);

  const metrics = {
    stanceWidthRatio: round2(stanceWidthRatio),
    headLateralDriftRatio: round2(headDriftMax),
    headOverFrontKneeAtImpactRatio: round2(headOverFrontKneeAtImpact),
    frontKneeFlexionChangeDeg: round2(frontKneeFlexionChange),
    backliftHeightRatio: round2(backliftHeightRatio),
    backliftStraightnessDeviation: round2(backliftStraightnessDeviation),
    frontElbowAboveShoulderRatio: round2(frontElbowAboveShoulderRatio),
    hipShoulderSeparationDeg_approx: round2(hipShoulderSeparationDeg),
    followThroughWobbleRatio: round2(followThroughWobble),
    downswingDurationMs,
    totalShotDurationMs,
    maxHandSpeedNormalized: round2(maxHandSpeedNormalized),
  };

  const phaseTimes = {
    stance: series[stanceStartIdx].t,
    backlift_top: series[backliftTopIdx].t,
    downswing: series[Math.round((backliftTopIdx + impactIdx) / 2)].t,
    impact: series[impactIdx].t,
    follow_through: series[followEndIdx].t,
  };

  if (onProgress) onProgress(1, "frames");
  const keyFrames = [];
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = Math.round(480 * (video.videoHeight / video.videoWidth || 0.5625));
  const ctx = canvas.getContext("2d");
  for (const [phase, t] of Object.entries(phaseTimes)) {
    await seekTo(video, Math.min(duration - 0.001, Math.max(0, t)));
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    keyFrames.push({ phase, dataUrl: canvas.toDataURL("image/jpeg", 0.72) });
  }

  URL.revokeObjectURL(video.src);

  return { metrics, keyFrames, duration, sampleCount: series.length };
}

function round2(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

// Classical coaching-technique benchmark ranges (general biomechanics
// heuristics used in coaching education, not measured data from named
// players). Used to flag deltas for the LLM and for the on-page comparison table.
export const BENCHMARKS = {
  stanceWidthRatio: { min: 0.9, max: 1.4, note: "roughly shoulder-width to ~1.4x shoulder width" },
  headLateralDriftRatio: { min: 0, max: 0.18, note: "head should stay close to still through the shot" },
  headOverFrontKneeAtImpactRatio: { min: 0, max: 0.2, note: "head roughly stacked over the front knee/ball at contact" },
  frontKneeFlexionChangeDeg: { min: 8, max: 35, note: "front leg should visibly brace/flex into the shot" },
  backliftStraightnessDeviation: { min: 0, max: 0.12, note: "bat should come down close to a straight line" },
  frontElbowAboveShoulderRatio: { min: -0.05, max: 0.3, note: "front elbow at or above shoulder height through contact" },
  followThroughWobbleRatio: { min: 0, max: 0.1, note: "balanced, stable finish with minimal sway" },
};

export function compareToBenchmarks(metrics) {
  const out = {};
  for (const [key, range] of Object.entries(BENCHMARKS)) {
    const v = metrics[key];
    if (v === null || v === undefined) continue;
    out[key] = {
      value: v,
      target: `${range.min} - ${range.max}`,
      note: range.note,
      withinBenchmark: v >= range.min && v <= range.max,
    };
  }
  return out;
}

export function aggregateMetrics(perVideoMetrics) {
  const keys = Object.keys(perVideoMetrics[0] || {});
  const agg = {};
  for (const k of keys) {
    const vals = perVideoMetrics.map((m) => m[k]).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    if (!vals.length) { agg[k] = null; continue; }
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    agg[k] = { mean: round2(mean), std: round2(std), n: vals.length, of: perVideoMetrics.length };
  }
  return agg;
}
