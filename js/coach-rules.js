// Deterministic, rule-based cricket coaching report — no AI model, no
// network call, no cost, and it can never break because a provider
// deprecated a model. Everything is derived straight from the numbers
// pose-estimation already measured, written in plain coaching language.

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// key -> coaching content. "low"/"high" text is used when the value misses
// the benchmark range on that side; only metrics where one direction
// realistically matters need both.
const METRIC_COACHING = {
  stanceWidthRatio: {
    label: "Stance width",
    phase: "stance",
    low: {
      issue: "Your stance is too narrow.",
      why: "A narrow base makes you less stable and easier to knock off balance, especially against pace.",
      drill: "Mark your ideal stance width with two pieces of tape, shoulder-width apart, and take 20 stance set-ups a day until it's automatic.",
    },
    high: {
      issue: "Your stance is too wide.",
      why: "Too wide a base slows down your foot movement, so you're late getting to the pitch of the ball.",
      drill: "Practice taking guard slightly narrower and shadow a few trigger movements to check you can still move freely.",
    },
    ok: "You get into a solid, balanced stance every time — a good foundation to build the rest of the shot on.",
  },
  headLateralDriftRatio: {
    label: "Head stillness",
    phase: "impact",
    high: {
      issue: "You have a head fall — your head drifts away from the ball during the shot instead of staying still.",
      why: "Head fall is one of the biggest causes of mistimed shots and outside edges, because your eyes move off the ball right when you need them most.",
      drill: "Shadow batting in front of a mirror, watching only your head — if it moves more than a fist's width, reset and go again. 5 minutes a day.",
    },
    ok: "Your head stays still through the shot — genuinely one of your biggest strengths, keep protecting it.",
  },
  headOverFrontKneeAtImpactRatio: {
    label: "Head over the ball",
    phase: "impact",
    high: {
      issue: "At the moment of contact your head isn't over the ball — you're either falling over it or hanging back off it.",
      why: "When your head isn't stacked above the front knee at contact, you lose control of where the ball goes and are more likely to edge it or get out lbw.",
      drill: "Front-foot press drill: step into the shot and freeze at contact — check in a video that your head is directly above your front knee.",
    },
    ok: "Your head finishes right over the ball at contact — that's textbook balance at the crease.",
  },
  frontKneeFlexionChangeDeg: {
    label: "Weight transfer",
    phase: "impact",
    low: {
      issue: "You're not getting into the shot — your front leg stays too stiff instead of bending into it.",
      why: "Without bending the front knee into the shot, your weight stays back, so you lose power and balance at contact.",
      drill: "Walk-into-the-shot drill: take a small step and consciously bend the front knee as bat meets ball, 15 reps a day.",
    },
    ok: "Good weight transfer — your front leg bends and braces into the shot the way it should.",
  },
  backliftStraightnessDeviation: {
    label: "Backlift & downswing path",
    phase: "backlift",
    high: {
      issue: "The bat isn't coming down in a straight line — it's swinging round the corner instead of straight down the line of the stumps.",
      why: "A round-the-corner swing is a classic sign of bottom-hand dominance or a gap in the grip, and it's why balls that swing or seam get you bowled or lbw.",
      drill: "Bat-drop drill against a wall or net: lift the bat straight up, let it fall straight down, with your top hand doing the steering. Check your grip — hands should be close together with the V's roughly matching.",
    },
    ok: "Your bat comes down nice and straight — a technically sound base to build shots on.",
  },
  frontElbowAboveShoulderRatio: {
    label: "Front elbow position",
    phase: "impact",
    low: {
      issue: "Your front elbow drops low through the shot instead of staying up.",
      why: "A low front elbow usually means bottom-hand dominance — the bottom (power) hand is taking over from the top (control) hand — which costs you control, especially driving through the off side.",
      drill: "Throwdowns with a focus cue: keep the front elbow pointing at the bowler as long as possible through the shot. Practice drives in slow motion first.",
    },
    ok: "Your front elbow stays up nicely through the shot, giving you good control on drives.",
  },
  followThroughWobbleRatio: {
    label: "Balance & finish",
    phase: "follow_through",
    high: {
      issue: "You lose your balance after playing the shot — there's a wobble in your finish instead of a controlled stop.",
      why: "A shaky finish usually means the shot was rushed or off-balance somewhere earlier, and it makes it harder to react to a second ball quickly.",
      drill: "Freeze-and-hold drill: play the shot and hold your finishing position for 3 full seconds without moving your feet. Repeat 15 times.",
    },
    ok: "You finish the shot balanced and under control — a sign the whole movement was well-timed.",
  },
};

const PHASES = ["stance", "backlift", "downswing", "impact", "follow_through"];

function scoreFromBenchmarks(benchmarks) {
  let score = 100;
  for (const b of Object.values(benchmarks)) {
    if (b.withinBenchmark) continue;
    const range = b.max - b.min || 1;
    const miss = b.value < b.min ? b.min - b.value : b.value - b.max;
    const severity = clamp(miss / range, 0, 1.5);
    score -= 6 + severity * 10;
  }
  return Math.round(clamp(score, 25, 97));
}

function pickDirection(entry) {
  if (entry.withinBenchmark) return "ok";
  return entry.value < entry.min ? "low" : "high";
}

/**
 * Builds a coaching report in the same shape the AI version used to return,
 * from computed metrics alone — no external call.
 */
export function generateTechniqueReport({ benchmarks, videoCount, priorSessionsSummary }) {
  const strengths = [];
  const weaknesses = [];
  const phaseNotes = { stance: [], backlift: [], downswing: [], impact: [], follow_through: [] };
  let worst = null;
  let worstSeverity = -1;

  for (const [key, entry] of Object.entries(benchmarks)) {
    const content = METRIC_COACHING[key];
    if (!content) continue;
    const dir = pickDirection(entry);
    if (dir === "ok") {
      strengths.push(content.ok);
      phaseNotes[content.phase]?.push(content.ok);
      continue;
    }
    const detail = content[dir] || content.high || content.low;
    if (!detail) continue;
    weaknesses.push(detail);
    phaseNotes[content.phase]?.push(detail.issue);

    const range = entry.max - entry.min || 1;
    const miss = entry.value < entry.min ? entry.min - entry.value : entry.value - entry.max;
    const severity = miss / range;
    if (severity > worstSeverity) { worstSeverity = severity; worst = detail; }
  }

  if (!strengths.length) strengths.push("You completed every phase of the shot with a clear, repeatable rhythm — that consistency is worth building on.");

  const phase_breakdown = {};
  for (const p of PHASES) {
    phase_breakdown[p] = phaseNotes[p].length ? phaseNotes[p].join(" ") : "Nothing stood out here — solid, unremarkable technique.";
  }

  const technical_score = scoreFromBenchmarks(benchmarks);
  const priority_focus = worst
    ? `${worst.issue} ${worst.why}`
    : "Keep doing exactly what you're doing — there's no single glaring flaw here, so focus on consistency and match temperament next.";

  let trend = "";
  if (priorSessionsSummary && priorSessionsSummary.length) {
    const prevScore = priorSessionsSummary[0]?.technical_score;
    if (typeof prevScore === "number") {
      if (technical_score > prevScore + 3) trend = ` Compared to your last session (${prevScore}), that's real improvement — keep it up.`;
      else if (technical_score < prevScore - 3) trend = ` That's a dip from your last session (${prevScore}) — nothing to panic about, but worth a closer look at what changed.`;
      else trend = ` That's about the same as your last session (${prevScore}) — steady.`;
    }
  }

  const summary = `Based on ${videoCount} video${videoCount === 1 ? "" : "s"}, your technique scores ${technical_score}/100. ` +
    `${strengths.length} thing${strengths.length === 1 ? "" : "s"} are working well, and ${weaknesses.length} area${weaknesses.length === 1 ? "" : "s"} need work.${trend}`;

  const reportLines = [summary, "", "Strengths:", ...strengths.map((s) => "- " + s), ""];
  if (weaknesses.length) {
    reportLines.push("What to work on:");
    weaknesses.forEach((w) => {
      reportLines.push(`- ${w.issue} ${w.why} Drill: ${w.drill}`);
    });
    reportLines.push("");
  }
  reportLines.push(`Priority for your next net session: ${priority_focus}`);

  return {
    technical_score,
    summary,
    strengths,
    weaknesses: weaknesses.map((w) => ({ issue: w.issue, why_it_matters: w.why, drill: w.drill })),
    phase_breakdown,
    priority_focus,
    coach_report: reportLines.join("\n"),
  };
}

const DISMISSAL_METRIC_HINTS = [
  { match: /caught.*(behind|keeper|slip|wicket)/i, key: "headLateralDriftRatio", note: "head fall" },
  { match: /bowled/i, key: "backliftStraightnessDeviation", note: "bat coming down round the corner" },
  { match: /lbw/i, key: "headOverFrontKneeAtImpactRatio", note: "head not over the ball" },
  { match: /caught/i, key: "frontElbowAboveShoulderRatio", note: "bottom-hand dominance" },
];

function average(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }

export function generateCareerReport({ careerStats, benchmarks, priorSessionsSummary }) {
  const entries = (careerStats?.entries || []).filter((e) => e.runs != null);
  const sorted = entries.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const runsArr = sorted.map((e) => e.runs);
  const outs = sorted.filter((e) => e.dismissal && !/not\s*out/i.test(e.dismissal));
  const totalRuns = runsArr.reduce((a, b) => a + b, 0);
  const average_ = outs.length ? totalRuns / outs.length : average(runsArr);
  const high = runsArr.length ? Math.max(...runsArr) : 0;
  const fifties = sorted.filter((e) => e.runs >= 50 && e.runs < 100).length;
  const hundreds = sorted.filter((e) => e.runs >= 100).length;

  const half = Math.floor(sorted.length / 2);
  const firstHalfAvg = average(sorted.slice(0, half).map((e) => e.runs));
  const secondHalfAvg = average(sorted.slice(half).map((e) => e.runs));
  let trend;
  if (sorted.length < 4) trend = "Not enough innings logged yet to call a trend — keep adding scores and this will get sharper.";
  else if (secondHalfAvg > firstHalfAvg * 1.15) trend = `You're trending up — your more recent innings average ${secondHalfAvg.toFixed(1)} against ${firstHalfAvg.toFixed(1)} earlier on.`;
  else if (secondHalfAvg < firstHalfAvg * 0.85) trend = `You've dipped recently — averaging ${secondHalfAvg.toFixed(1)} lately against ${firstHalfAvg.toFixed(1)} earlier. Worth figuring out what changed.`;
  else trend = `You've been fairly consistent — averaging around ${average_.toFixed(1)} throughout.`;

  let pro_comparison;
  if (average_ < 20) pro_comparison = `An average of ${average_.toFixed(1)} is club/school level — the aim now is simply converting more starts into 20s and 30s.`;
  else if (average_ < 30) pro_comparison = `An average of ${average_.toFixed(1)} is solid club level. Strong first-class batters are typically averaging 35+, so the next step is turning your 20s and 30s into 50s.`;
  else if (average_ < 40) pro_comparison = `An average of ${average_.toFixed(1)} is a genuinely strong club/age-group level. First-class regulars average 35-45 — you're in that conversation if you can push your conversion rate.`;
  else if (average_ < 50) pro_comparison = `An average of ${average_.toFixed(1)} is first-class-track. Serious professional/international-level batters generally average 45+ with a high conversion of 50s into 100s — that's the next bar.`;
  else pro_comparison = `An average of ${average_.toFixed(1)} is a serious, professional-level number. At this stage it's about doing it against tougher bowling and converting big scores into really big ones.`;

  const dismissalCounts = {};
  sorted.forEach((e) => {
    if (!e.dismissal || /not\s*out/i.test(e.dismissal)) return;
    const k = e.dismissal.trim().toLowerCase();
    dismissalCounts[k] = (dismissalCounts[k] || 0) + 1;
  });
  const topDismissal = Object.entries(dismissalCounts).sort((a, b) => b[1] - a[1])[0];

  const weaknesses = [];
  if (topDismissal) {
    const [name, count] = topDismissal;
    let link = "";
    const hint = DISMISSAL_METRIC_HINTS.find((h) => h.match.test(name));
    if (hint && benchmarks && benchmarks[hint.key] && !benchmarks[hint.key].withinBenchmark) {
      link = ` This lines up with the ${hint.note} flagged in your last technical session — that's very likely the root cause.`;
    }
    weaknesses.push({
      issue: `Your most common dismissal is "${name}" (${count} time${count === 1 ? "" : "s"}).`,
      why_it_matters: `A repeated dismissal pattern usually points to one specific technical habit, not bad luck.${link}`,
      drill: hint ? `Work the drill for that flaw in your Analyze tab — fixing the root cause should directly cut down this dismissal.` : "Track the situation each time you get out this way (ball type, bowler pace, shot played) to spot the pattern.",
    });
  }
  const startsNotConverted = sorted.filter((e) => e.runs >= 20 && e.runs < 50).length;
  if (startsNotConverted >= 3 && hundreds + fifties < startsNotConverted) {
    weaknesses.push({
      issue: `You have ${startsNotConverted} innings between 20 and 49 that didn't go on to a 50.`,
      why_it_matters: "Starts that aren't converted are the single biggest lever on a batting average — getting in is the hard part, cashing in is a mindset/concentration habit.",
      drill: "Set yourself a rule for your next 5 innings: once past 20, mentally 'restart' your innings and bat the first 10 balls again like you're new to the crease.",
    });
  }

  const strengths = [];
  if (hundreds > 0) strengths.push(`You've converted starts into ${hundreds} century${hundreds === 1 ? "" : "ies"} — you know how to go big once in.`);
  if (average_ >= 25) strengths.push(`A career average of ${average_.toFixed(1)} shows real consistency over time.`);
  if (!strengths.length) strengths.push("You're building a track record — the more innings you log here, the clearer your patterns will get.");

  const career_score = Math.round(clamp(30 + average_ * 1.1 + hundreds * 3 + fifties * 1.5 - (topDismissal ? topDismissal[1] : 0), 15, 96));
  const summary = `Across ${sorted.length} logged innings, you average ${average_.toFixed(1)} with a high score of ${high}, including ${fifties} fifty${fifties === 1 ? "" : "ies"} and ${hundreds} hundred${hundreds === 1 ? "" : "s"}. ${trend}`;
  const priority_focus = weaknesses[0]
    ? weaknesses[0].issue + " " + weaknesses[0].why_it_matters
    : "Keep logging innings — your biggest lever right now is simply more data to spot patterns.";

  const reportLines = [summary, "", pro_comparison, ""];
  if (strengths.length) reportLines.push("Strengths:", ...strengths.map((s) => "- " + s), "");
  if (weaknesses.length) {
    reportLines.push("What to work on:");
    weaknesses.forEach((w) => reportLines.push(`- ${w.issue} ${w.why_it_matters} ${w.drill}`));
  }

  return {
    career_score,
    summary,
    strengths,
    weaknesses,
    trend,
    pro_comparison,
    priority_focus,
    coach_report: reportLines.join("\n"),
  };
}
