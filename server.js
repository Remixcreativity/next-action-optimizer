import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(join(__dirname, "dist")));

// ─── HIGH-STAKES DETECTION ───────────────────────────────────────────────────
const HIGH_STAKES_KEYWORDS = [
  "payment", "pay", "invoice", "money", "bank", "banking",
  "legal", "medical", "client", "send", "delete", "submit",
  "sign", "cancel", "tax", "contract", "transfer", "wire",
  "due today", "deadline", "irreversible",
];

const isHighStakes = (...texts) => {
  const combined = texts.filter(Boolean).join(" ").toLowerCase();
  return HIGH_STAKES_KEYWORDS.some(k => combined.includes(k));
};

// ─── STAT CALCULATIONS (server-side) ─────────────────────────────────────────
const calcStats = (history = []) => {
  if (!history.length) return { finishRate: 0, frictionRate: 0, totalScore: 0, streak: 0 };
  const loops = history.length;
  const finished = history.filter(h => h.feedback === "done" && h.result === "finished").length;
  const friction = history.filter(h => h.feedback !== "done" && h.feedback !== "skipped").length;
  const totalScore = history.reduce((s, h) => s + (h.score ?? 0), 0);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].feedback === "done" && history[i].result === "finished") streak++;
    else break;
  }
  return {
    finishRate: Math.round((finished / loops) * 100),
    frictionRate: Math.round((friction / loops) * 100),
    totalScore,
    streak,
  };
};

const getFrictionStats = (history = []) => {
  const counts = {};
  history.forEach(h => { counts[h.feedback] = (counts[h.feedback] || 0) + 1; });
  return counts;
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const buildSystemPrompt = ({ patterns, frictionStats, stats, availableMinutes, sessionMode, energy, context, state, highStakes }) => `
You are NAO — a closed-loop execution system.

GOAL: Suggest the next most valuable action the user will actually complete right now.

═══ REQUIRED ON EVERY CANDIDATE ═════════════════════════════════════════════

parent_task_id    — exact task_id from the task list. Never invent.
parent_task_title — exact title from the task list.
completion_intent — true or false (see rule below)
reason_chips      — 2–4 from allowed list only
tags              — task_type, size, clarity, visible_result, energy_required, time_bucket, friction_risk
policy            — leverage_score (1–5), leverage_reason, action_size, estimated_difficulty

═══ COMPLETION_INTENT RULE ═══════════════════════════════════════════════════

completion_intent = false → substep. Done+Finished records progress. Task stays.
completion_intent = true  → finish attempt. Done+Finished removes the task (non-habit only).

PROGRESSION — based on parent_finished_count from active thread:

0 finished steps → entry or small_win action. completion_intent = false.
1 finished step  → progress action. completion_intent = false.
2+ finished steps → finish attempt. completion_intent = true.
  Action: direct and concrete. Example: "Pay the invoice and save the confirmation."
  No ceremony. Just do the final action.

Exception: small one-off/admin tasks → completion_intent = true after 1 finished step.

HABITS: completion_intent = false always. Never remove. Say "today's session complete."

═══ IF FINISH ATTEMPT FAILS ═════════════════════════════════════════════════

Previous action had completion_intent = true. User responded:

too_big     → smaller progress step. completion_intent = false.
too_vague   → same finish attempt, add exact detail. completion_intent = true.
no_time     → compress finish if it fits; otherwise progress step. completion_intent = false.
skipped     → smaller/reframed progress step. completion_intent = false.
              Do not try finish again until 1 more Done+Finished.
no_motivation → visible artifact step. completion_intent = false.
partial     → continue same thread, smaller step. completion_intent = false.

═══ SESSION MODE CAPS ════════════════════════════════════════════════════════

enter     → estimated_minutes ≤ 2, action_size: entry or tiny
small_win → estimated_minutes ≤ 5, one visible output
progress  → estimated_minutes ≤ 10
deep_work → estimated_minutes ≤ 30, project/urgent work only

Never exceed the cap.

═══ ACTIVE THREAD RULES ═════════════════════════════════════════════════════

done+finished + task not yet completed:
  ALL 3 candidates must use same parent_task_id.
  Do not switch tasks unless another task is urgent_important (!*).

done+partial → continue same thread, smaller step
too_big      → same thread, shrink
too_vague    → same thread, add exact detail
no_time      → same thread, compress
skipped on urgent/important:
  skip_count=1 → reframe: "just look" / "verify one detail" / "draft but do not send"
  skip_count=2 → protection action
  skip_count≥3 → blocker: "Write: I am not doing this because ___"
skipped on one_off/habit → switch task

═══ TASK TYPE RULES ══════════════════════════════════════════════════════════

HIGH-STAKES (payment, invoice, money, legal, medical, client, send, delete, submit):
  Never suggest irreversible final action first.
  Verify before executing.
  chips: "high-stakes" + "verification"

HABITS (#): completion_intent=false always. Say "today's session complete."
PROJECT (*): visible artifact each step.
URGENT (!): verify before execution if high-stakes.
URGENT+IMPORTANT (!*): highest priority. Safe entry first.

═══ STATE / CONTEXT ══════════════════════════════════════════════════════════

tired/sick     → entry or tiny only, difficulty ≤ 2
stressed       → visible result required
restless       → physical or concrete action
work/outside   → no home tasks (kitchen, shower, laundry, bedroom)
energy=low     → no deep_work

═══ GROUNDING ════════════════════════════════════════════════════════════════

Only reference files, apps, people, locations that appear in the task title,
task list, active thread, or recent history. Never invent references.
If location unknown: "Open the spreadsheet or system where [task] occurs."
No psychological labels. No motivational phrases.

═══ CURRENT STATE ════════════════════════════════════════════════════════════

Finish: ${stats.finishRate}% | Friction: ${stats.frictionRate}% | Score: ${stats.totalScore} | Streak: ${stats.streak}
Mode: ${sessionMode} | Time: ${availableMinutes}min | Energy: ${energy} | Context: ${context} | State: ${state}
${highStakes ? "⚠ HIGH-STAKES TASK IN LIST" : ""}
Patterns: ${patterns?.length ? patterns.join(", ") : "still learning"}
Friction: ${Object.keys(frictionStats).length ? Object.entries(frictionStats).map(([k,v]) => k+":"+v+"x").join(", ") : "none"}

═══ REASON CHIPS (use only these) ═══════════════════════════════════════════

"visible result" | "continuing thread" | "entry point" | "finished"
"urgent" | "important"
"tiny step" | "low energy" | "2 min"
"verification" | "protection action" | "high-stakes"
"switching task" | "finish attempt"

═══ OUTPUT — valid JSON only, no preamble, no markdown ══════════════════════

{"candidates":[{"parent_task_id":"t_exact_id","parent_task_title":"exact title","completion_intent":false,"action":"...","why":"...","estimated_minutes":3,"confidence":0.8,"leverage_score":4,"leverage_reason":"...","action_size":"entry","estimated_difficulty":1,"reason_chips":["entry point","visible result"],"tags":{"task_type":"admin","size":"tiny","clarity":"high","visible_result":true,"energy_required":"low","time_bucket":"2_5min","friction_risk":"low"}}]}
`.trim();

// ─── MESSAGE BUILDER ──────────────────────────────────────────────────────────
const buildMessages = ({ tasks, availableTasks, history, feedbackContext, availableMinutes, sessionMode, energy, activeThread }) => {
  const recent = (history || []).slice(-10).map(h =>
    `"${h.action}" → ${h.feedback}, result: ${h.result}, score: ${h.score ?? 0}, tags: ${h.tags ? JSON.stringify(h.tags) : "none"}`
  ).join("\n");

  const now = new Date();
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });
  const hour = now.getHours();

  // Active thread section — built as plain string to avoid nested template literal issues
  const getAdaptationRule = (t) => {
    if (!t) return "";
    const f = t.latest_feedback;
    const r = t.latest_result;
    const sc = t.skip_count || 0;
    const fc = t.parent_finished_count || 0;
    const isHabit = t.parent_task_repeatable;
    const pid = t.parent_task_id || "";

    if (f === "done" && r === "partial") return "→ Continue same thread, smaller step. completion_intent=false.";
    if (f === "done" && r === "none") return "→ More result-based step. completion_intent=false.";
    if (f === "done" && r === "finished") {
      if (isHabit) return "→ HABIT: " + fc + " sessions done. Say today's session complete. completion_intent=false always.";
      if (fc >= 2) return "→ FINISH ATTEMPT REQUIRED. Task (" + pid + ") has " + fc + " finished steps. Set completion_intent=true on at least one candidate. Action = the final concrete step to complete this task. No ceremony.";
      return "→ PROGRESS STEP. Continue same task (" + pid + "). All 3 candidates must use this parent_task_id. completion_intent=false.";
    }
    if (f === "too_big") return "→ Same thread, smaller step. completion_intent=false.";
    if (f === "too_vague") return "→ Same thread, add exact detail. Keep completion_intent same as last attempt.";
    if (f === "no_time") return "→ Compress to fit time. If finish fits keep completion_intent=true, otherwise progress step false.";
    if (f === "no_motivation") return "→ Visible artifact step. completion_intent=false.";
    if (f === "skipped" && sc >= 3) return "→ BLOCKER: Write one sentence: I am not doing this because ___.";
    if (f === "skipped" && sc >= 2) return "→ PROTECTION ACTION: reminder / delay message / ask for help.";
    if (f === "skipped") return "→ Reframe: lower commitment version. completion_intent=false.";
    return "→ Adapt based on feedback above.";
  };

  const activeThreadSection = activeThread ? [
    "",
    "ACTIVE THREAD (use this as primary context — overrides general history):",
    "Last attempted action: " + activeThread.last_action,
    "Last reason: " + activeThread.last_why,
    "Latest feedback: " + activeThread.latest_feedback,
    "Latest result: " + activeThread.latest_result,
    "Latest note: " + activeThread.latest_note,
    "Skip count: " + (activeThread.skip_count || 0),
    "Parent finished count: " + (activeThread.parent_finished_count || 0),
    "Parent task type: " + (activeThread.parent_task_type || "unknown"),
    "Parent repeatable: " + (activeThread.parent_task_repeatable ? "yes" : "no"),
    "",
    "Adaptation rule for this feedback:",
    getAdaptationRule(activeThread),
  ].join("\n") : ""

  // Format structured task list with IDs
  const taskListWithIds = availableTasks?.length
    ? availableTasks.map(t => `[${t.task_id}] ${t.prefix ? t.prefix + ' ' : ''}${t.clean_title}${t.urgent ? ' [urgent]' : ''}${t.important ? ' [important]' : ''}${t.high_stakes ? ' [high-stakes]' : ''}${t.skip_count > 0 ? ` [skipped:${t.skip_count}x]` : ''}`).join('\n')
    : tasks;

  return [{
    role: "user",
    content: `Tasks (with IDs — use task_id as parent_task_id in candidates):
${taskListWithIds}

Context: ${dayOfWeek} ${hour}:00, mode=${sessionMode}, estimate=${availableMinutes}m, ${energy} energy

Recent history:
${recent || "None"}
${activeThreadSection}

${feedbackContext
  ? `Latest feedback: ${feedbackContext.feedback}, result: ${feedbackContext.result}${feedbackContext.note ? `, note: "${feedbackContext.note}"` : ""}

Generate adapted candidates following behavioral rules.`
  : "Generate best first candidate actions."
}

Return ONLY the JSON object. No other text.`,
  }];
};

// ─── API ROUTE ────────────────────────────────────────────────────────────────
app.post("/api/next-action", async (req, res) => {
  try {
    const {
      tasks,
      availableTasks = [],
      rawTasks,
      history = [],
      feedbackContext = null,
      availableMinutes = 5,
      sessionMode = "small_win",
      energy = "medium",
      context = "home",
      state = "normal",
      patterns = [],
      activeThread = null,
    } = req.body;

    if (!tasks) return res.status(400).json({ error: "Missing tasks" });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });

    // Detect high-stakes from tasks + active thread + recent history
    const highStakes = isHighStakes(
      tasks,
      activeThread?.last_action,
      activeThread?.last_why,
      history.slice(-3).map(h => h.action).join(" ")
    );

    const stats = calcStats(history);
    const frictionStats = getFrictionStats(history);

    const system = buildSystemPrompt({
      patterns,
      frictionStats,
      stats,
      availableMinutes,
      sessionMode,
      energy,
      context,
      state,
      highStakes,
    });

    const messages = buildMessages({
      tasks,
      availableTasks,
      history,
      feedbackContext,
      availableMinutes,
      sessionMode,
      energy,
      activeThread,
    });

    console.log("[NAO] Calling API — feedback:", feedbackContext?.feedback || "none");
    console.log("[NAO] Active thread:", activeThread?.latest_feedback || "none", "| skip_count:", activeThread?.skip_count ?? 0);
    console.log("[NAO] High-stakes:", highStakes);
    console.log("[NAO] Context:", context, "| State:", state, "| Mode:", sessionMode);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 1000,
        system,
        messages,
      }),
    });

    const raw = await response.text();
    console.log("[NAO] Status:", response.status);
    console.log("[NAO] Response preview:", raw.slice(0, 300));

    if (!response.ok) {
      return res.status(response.status).json({ error: raw.slice(0, 200) });
    }

    let data;
    try { data = JSON.parse(raw); }
    catch { return res.status(500).json({ error: "Non-JSON from API: " + raw.slice(0, 100) }); }

    const text = data.content?.find(b => b.type === "text")?.text || "";
    if (!text) {
      return res.status(500).json({ error: "Empty text. Keys: " + Object.keys(data).join(", ") });
    }

    return res.json({ text, usedModel: "claude-sonnet-4-5" });

  } catch (error) {
    console.error("[NAO] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(join(__dirname, "dist", "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[NAO] Server running on port ${PORT}`);
});
