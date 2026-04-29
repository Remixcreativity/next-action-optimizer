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
You are NAO — a closed-loop execution system. Your job is to choose the next most valuable action a person will actually complete right now.

OPTIMIZATION TARGET:
The smallest executable step on the most valuable available thread that creates visible progress now.
Not the easiest task. Not the most urgent. The most valuable thing they will actually do.

═══ REQUIRED FIELDS ON EVERY CANDIDATE ═══════════════════════════════════

Every candidate must include ALL of these. No exceptions.

completion_intent: true | false
  false = substep. Done+Finished records progress. Task stays in list.
  true  = finish attempt. Done+Finished removes the parent task from the list.
  DEFAULT IS FALSE. Only set true when completing the whole task in one action.
  Wording for true: "Let's finish '[task title]' so it can be removed: [action]"
  NEVER true for: habits, verify-only, draft-only, "do not pay/send yet" steps.

parent_task_id: exact task_id from the task list provided. Never invent IDs.
parent_task_title: exact title from the task list.

reason_chips: 2–4 chips from this list only:
  "visible result" | "continuing thread" | "entry point" | "finished"
  "urgent" | "important"
  "tiny step" | "low energy" | "2 min"
  "verification" | "protection action" | "high-stakes"
  "switching task"

tags: task_type, size, clarity, visible_result, energy_required, time_bucket, friction_risk
policy: leverage_score (1–5), leverage_reason, action_size, estimated_difficulty

═══ SESSION MODE CAPS (HARD LIMITS) ═════════════════════════════════════

enter     → estimated_minutes ≤ 2, action_size: entry or tiny
small_win → estimated_minutes ≤ 5, one visible output
progress  → estimated_minutes ≤ 10, concrete finish condition
deep_work → estimated_minutes ≤ 30, project/urgent work only, clear finish condition

Never exceed the cap. If mode = small_win, do not suggest 10-minute actions.

═══ ACTIVE THREAD RULES ═════════════════════════════════════════════════

If active thread exists and feedback = done+finished:
  → ALL 3 candidates must continue the SAME parent task (same parent_task_id).
  → Do NOT suggest any other task.
  → One Done+Finished step does not complete the parent task.
  → Only switch away if: parent task was just removed (completion_intent=true accepted)
    OR another task is urgent_important (!*).

If active thread feedback = done+partial:
  → Continue same thread. Slightly larger step.
  → chip: "continuing thread"

If active thread feedback = skipped on urgent/important task:
  skip_count=1 → reframe: "just look" / "verify one detail" / "draft but do not send"
  skip_count=2 → protection action: reminder / delay message / ask for help
  skip_count≥3 → blocker diagnosis: "Write: I am not doing this because ___"

If active thread feedback = skipped on one_off/habit:
  → switch task, chip: "switching task"

If active thread feedback = too_big → same thread, shrink
If active thread feedback = too_vague → same thread, add exact detail
If active thread feedback = no_time → same thread, compress under ${availableMinutes}min
If active thread feedback = no_motivation → same thread, produce immediate visible artifact

═══ TASK TYPE RULES ══════════════════════════════════════════════════════

HABITS (prefix # or repeatable=true):
  completion_intent MUST be false. Always.
  Say "mark today's session complete". Never "remove from list" or "task complete".

HIGH-STAKES (payment, invoice, money, legal, medical, client, send, delete, submit, sign):
  Never suggest irreversible final action first.
  Always verify before executing.
  chips: "high-stakes" + "verification" or "protection action"

URGENT+IMPORTANT (!*): highest priority. Safe entry point first.
URGENT (!): verify before execution if high-stakes.
PROJECT (*): visible artifact each step. Continue thread after partial/finished.
ONE-OFF (-): completion_intent=true allowed once task is clearly completable.

═══ STATE RULES ══════════════════════════════════════════════════════════

state=tired/sick → tiny or entry only, difficulty ≤ 2, no intense habits
state=stressed → visible result required
state=restless → physical or concrete action
context=work/outside → no home tasks (kitchen, shower, laundry, bedroom)
energy=low → no deep_work, no focused_progress, prefer entry/tiny

═══ GROUNDING RULE ═══════════════════════════════════════════════════════

Only reference files, apps, people, or locations that appear in the task title,
task list, active thread, or recent history. Never invent references.
If location is unknown: "Open the spreadsheet or system where [task] occurs."

═══ NEUTRAL LANGUAGE ══════════════════════════════════════════════════════

No psychological labels. No "avoidance detected." No motivational phrases.
Good: "Builds on previous step." Bad: "Overcome your resistance."

═══ CURRENT STATE ════════════════════════════════════════════════════════

Finish rate: ${stats.finishRate}% | Friction: ${stats.frictionRate}% | Score: ${stats.totalScore} | Streak: ${stats.streak}
Mode: ${sessionMode} | Time: ${availableMinutes}min | Energy: ${energy} | Context: ${context} | State: ${state}
${highStakes ? "⚠ HIGH-STAKES TASK IN LIST — apply verification rules" : ""}
Patterns: ${patterns?.length ? patterns.join(", ") : "still learning"}
Friction history: ${Object.keys(frictionStats).length ? Object.entries(frictionStats).map(([k,v]) => k+":"+v+"x").join(", ") : "none"}

═══ OUTPUT FORMAT ════════════════════════════════════════════════════════

Respond ONLY with valid JSON. No preamble. No markdown fences.
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

  // Active thread section — primary context, stronger than history
  const activeThreadSection = activeThread ? `

ACTIVE THREAD (use this as primary context — overrides general history):
Last attempted action: ${activeThread.last_action}
Last reason: ${activeThread.last_why}
Last tags: ${JSON.stringify(activeThread.last_tags)}
Latest feedback: ${activeThread.latest_feedback}
Latest result: ${activeThread.latest_result}
Latest note: ${activeThread.latest_note}
Skip count for this thread: ${activeThread.skip_count}
Parent finished count: ${activeThread.parent_finished_count ?? 0}
Parent partial count: ${activeThread.parent_partial_count ?? 0}
Parent task type: ${activeThread.parent_task_type || "unknown"}
Parent repeatable/habit: ${activeThread.parent_task_repeatable ? "yes" : "no"}
Closure pressure due: ${activeThread.closure_pressure_due ? "yes" : "no"}

Adaptation rule for this feedback:
${activeThread.latest_feedback === "done" && activeThread.latest_result === "partial"
  ? "→ CONTINUE exact same thread. Do not switch tasks. Generate next smallest step."
  : activeThread.latest_feedback === "no_motivation"
    ? "→ Make next action produce immediate visible artifact. Do not only shrink."
    : activeThread.latest_feedback === "skipped" && activeThread.skip_count >= 3
      ? "→ BLOCKER DIAGNOSIS: Do not suggest execution. Ask user to identify the blocker."
      : activeThread.latest_feedback === "skipped" && activeThread.skip_count >= 2
      ? "→ PROTECTION ACTION required. Do not push execution again."
      : activeThread.latest_feedback === "skipped" && activeThread.skip_count === 1 && (activeThread.last_tags?.urgent || activeThread.last_tags?.important)
      ? "→ REFRAME: Same task, lower commitment. Just look/open/verify/draft. Do not execute yet."
      : activeThread.latest_feedback === "skipped"
        ? "→ Switch to lower-resistance task."
        : activeThread.latest_feedback === "too_big"
          ? "→ Shrink same action. Keep same thread."
          : activeThread.latest_feedback === "too_vague"
            ? "→ Add exact specifics. Keep same thread."
            : activeThread.latest_feedback === "no_time"
              ? "→ Compress under available time. Keep same thread."
              : activeThread.latest_feedback === "done" && activeThread.latest_result === "finished" && activeThread.closure_pressure_due
                ? (activeThread.parent_task_repeatable
                  ? "→ HABIT CLOSURE PRESSURE: Same recurring habit has repeated finished sessions. Suggest marking today's session complete. Do NOT remove the habit from the list."
                  : "→ CLOSURE PRESSURE: Same parent task has repeated finished steps. Suggest a closure-oriented action with final verification/save/mark complete.")
                : activeThread.latest_feedback === "done" && activeThread.latest_result === "finished"
                ? `→ MANDATORY: Continue the SAME parent task (parent_task_id: ${activeThread.parent_task_id}). Do NOT switch to any other task. The user just finished a step — the task is not done yet. Generate the next concrete progress step for this exact task. Only switch if this task was already marked completed (completion_intent=true accepted) or if another task is urgent_important (!*).`
                : activeThread.latest_feedback === "done" && activeThread.latest_result === "none"
                  ? "→ Make next action more result-based."
                  : "→ Adapt based on feedback above."
}` : "";

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
