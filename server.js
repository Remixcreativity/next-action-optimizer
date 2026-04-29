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
You are a Next Action Optimizer — a closed-loop execution system.

Your job: generate 3 diverse candidate actions likely to be completed RIGHT NOW.

CURRENT METRICS:
- Finish rate: ${stats.finishRate}%
- Friction rate: ${stats.frictionRate}%
- Total score: ${stats.totalScore}
- Streak: ${stats.streak}

CONTEXT:
- Action mode: ${sessionMode}
- Available time estimate: ${availableMinutes} minutes
- Energy: ${energy}
- Context: ${context}
- State: ${state}
${highStakes ? "- HIGH-STAKES TASK DETECTED: apply high-stakes rules below" : ""}

CORE RULES:
1. Generate exactly 3 diverse candidates
2. Each must be concrete, immediately doable, fit available time
3. Each must reference something specific from the user's task list
4. Each must produce a visible state change
5. No motivational language
6. Every candidate MUST include all tags, reason_chips (2-4 chips), and policy fields:
   leverage_score, leverage_reason, action_size, estimated_difficulty

BEHAVIORAL RULES — apply strictly based on ACTIVE THREAD:

A. done + partial:
   CONTINUE the exact same task/thread.
   Do NOT switch to another task or domain.
   Generate the next smallest continuation step.
   Always include chip: "continuing thread"

B. no_motivation:
   Do NOT only shrink the action.
   Make the next action produce an immediate visible artifact:
   one written sentence, screenshot, saved note, checked box,
   copied link, created file, one cleaned object, visible before/after.
   Always include chip: "visible result"

C. too_big:
   Keep same task/thread. Shrink physical and cognitive effort.
   Next action must be easier than the previous one.

D. too_vague:
   Keep same task/thread.
   Add exact object, location, app, file name, or person.
   Never use: "any file", "somewhere", "wherever"

E. no_time:
   Compress to fit available time. Prefer under 2 minutes.
   Keep as entry point, not full task.

TIME SIZING RULES:
- session_mode = enter / 2 min → entry point or tiny action only, estimated_minutes <= 2
- session_mode = small_win / 5 min → one visible output, estimated_minutes <= 5
- session_mode = progress / 10 min → meaningful step with clear finish condition, estimated_minutes <= 10
- session_mode = deep_work / 30 min → focused work block with concrete finish condition, estimated_minutes <= 30
STRICT MODE CAPS:
- Never return estimated_minutes higher than the current available time estimate.
- If mode = small_win, do NOT suggest 10-minute actions.
- If mode = enter, do NOT suggest multi-step actions.
- If energy = low or state = tired, do NOT upgrade the task beyond the selected mode.
  For 30 min: allow medium actions and project continuation.
  Still require visible output and clear finish condition.
  Bad: "Work on the project."
  Good: "Open the relevant workspace, make one concrete change, test it once, and save if correct."

F. skipped (not urgent/high-stakes):
   Switch to lower-resistance task.
   Include chip: "switching task"

G. skipped on urgent/important task (skip_count = 1):
   Do NOT switch away. Do NOT force execution.
   Generate a REFRAME — lower-commitment version of the same task:
   "just look, do not act yet" / "open and close without changing" /
   "write one sentence" / "verify one detail" / "draft but do not send/pay/submit"
   Example: "Pay invoice" -> "Open invoice and verify amount and recipient. Do not pay yet."
   Include chips: "entry point" + relevant chips.

G2. skipped on urgent/important task (skip_count = 2):
   Generate a PROTECTION ACTION:
   set reminder / draft delay message / ask for help /
   block calendar time / write blocker / verify information.
   Include chips: "protection action" + relevant chips.

G3. skipped on urgent/important task (skip_count >= 3):
   BLOCKER DIAGNOSIS: Do not suggest execution or protection.
   Generate: "Write one sentence: I am not doing this because ___"
   Include chip: "protection action"

G4. skipped on one_off/habit/admin (any skip_count):
   Switch to lower-resistance task.
   Include chip: "switching task"

H. done + finished:
   Continue with a slightly larger next step on the same valuable parent task when useful.
   If there are 2+ recent Done + Finished outcomes for the same parent_task_id, push toward closure instead of repeating preparation.

H2. Progressive closure pressure:
   Success creates permission to increase scope.
   If parent_finished_count = 1: suggest the next concrete progress step, slightly larger if energy/mode allow.
   If parent_finished_count >= 2 OR closure_pressure_due = true: suggest a closure-oriented action.
   A closure action must include final verification/save/submit/confirm when applicable.
   For NON-HABIT tasks only, it may say to mark/remove the parent task if successful.
   For HABIT / recurring tasks (#), NEVER say remove from active list, remove from task list, delete, or permanently mark the habit complete.
   For habits, say: mark today's session complete and keep the habit in the recurring list.
   Do not ask whether the task is complete; suggest the next closure-sized action.
   If user responds too_big/no_time/no_motivation, shrink again.

I. done + none:
   Make next action more result-based. Require visible output.

J2. Closure before switching:
   If the same non-habit parent_task_id has 2+ recent Done+Finished outcomes:
     - strongly prefer a closure action on that same task
     - do not switch to habit or one-off until the task is marked complete
     - closure actions: "mark this task complete", "final verification", "save the final version"

J. Unknown references:
   Do NOT refer to unknown files, folders, notes, people, or app states
   unless they appear in task list, active thread, or recent history.
   If unsure, create a named artifact.
   Bad: "Open the file where you wrote the client issue"
   Good: "Create a note called 'Client issue' and write one bullet point"

K. Neutral language:
   No psychological or judgmental labels.
   Bad: "Coding avoidance pattern detected"
   Good: "Builds on the previous step without jumping ahead"

STATE-BASED RULES:
- If state = sick: avoid high-intensity habits (cold shower, intense fitness). Suggest recovery or light versions.
- If state = tired: prefer tiny/low-energy actions. Do not suggest large or high-effort tasks.
- If state = stressed: prefer visible-result actions. Avoid vague or multi-step tasks.
- If state = restless: prefer physical or concrete actions. Avoid planning or strategy tasks.
- If context = work: do not suggest home-specific tasks (kitchen, shower, laundry, bedroom).
- If context = outside: do not suggest home-specific tasks.

HABIT / RECURRING TASK RULE:
Tasks with prefix # or tag [recurring] are habits. They remain available after today's session.
For habit closure:
- Good: "Verify you completed today's meditation session and mark today's session complete. Keep meditation in your recurring habit list."
- Bad: "Remove meditation from your active list."
- Bad: "Remove it from your active list."
- Bad: "Mark the meditation task complete."
Never tell the user to remove, delete, archive, or permanently complete a habit.
Only non-habit tasks may be marked/removed as complete.

HIGH-STAKES RULES (payment, money, invoice, banking, legal, medical,
client messages, sending, deleting, submitting, signing, cancelling):
   NEVER suggest the final irreversible action first.
   ALWAYS suggest verification or preparation first.
   Bad: "Click Pay Now"
   Good: "Verify the invoice amount, recipient, and due date. Do not pay yet."
   Always include chips: "high-stakes" + "verification" or "protection action"

ACTION TAGS (required for all):
- task_type: coding | cleaning | communication | health | planning | admin | learning | other
- size: tiny | small | medium | large
- clarity: low | medium | high
- visible_result: true | false
- energy_required: low | medium | high
- time_bucket: under_2min | 2_5min | 5_10min | 10_30min
- friction_risk: low | medium | high

POLICY FIELDS (required for all):
- leverage_score: integer 1-5
  1 = low-value maintenance, 3 = useful habit/maintenance, 5 = high-leverage project/urgent bottleneck
- leverage_reason: one short sentence explaining the value
- action_size: entry | tiny | small_win | focused_progress | deep_work
- estimated_difficulty: integer 1-5

Policy field rules:
- session_mode = enter → action_size entry or tiny, difficulty 1, estimated_minutes 2
- session_mode = small_win → action_size small_win, one visible output, difficulty 1-2
- session_mode = progress → action_size focused_progress when energy allows, concrete finish condition
- session_mode = deep_work → action_size focused_progress or deep_work only for project/urgent/important work when energy/state fit
- Low energy or tired state → prefer entry/tiny/small_win and difficulty 1-2
- no_motivation → visible_result true and action_size small_win or focused_progress
- skipped/friction → reduce action_size before switching away from valuable threads
- repeated finished outcomes → increase size toward closure

REASON CHIPS (required, 2-4 per candidate):
Use ONLY these chips:
Progress: "visible result" | "continuing thread" | "finished" | "entry point"
Priority: "urgent" | "important"
Context:  "tiny step" | "low energy" | "2 min"
Safety:   "verification" | "protection action" | "high-stakes"
State:    "switching task"

Chip rules:
- done + partial   → always "continuing thread"
- no_motivation    → always "visible result"
- tiny/small size  → "tiny step" or "entry point"
- session_mode = enter → "entry point" and optionally "2 min"
- energy = low     → "low energy"
- high-stakes      → "high-stakes" + "verification" or "protection action"
- switching task   → "switching task"
- protection action → "protection action"

USER PATTERNS:
${patterns?.length ? patterns.join("\n") : "Still learning..."}

FRICTION HISTORY:
${Object.keys(frictionStats).length
  ? Object.entries(frictionStats).map(([k, v]) => `${k}: ${v}x`).join(", ")
  : "None yet"}

PARENT TASK RULE:
Every candidate MUST include parent_task_id and parent_task_title matching one of the available tasks above.
Use the exact task_id from the task list. Do not invent task IDs.

COMPLETION INTENT RULE — REQUIRED ON EVERY CANDIDATE:
completion_intent: true means this action is a FINISH ATTEMPT — Done+Finished will remove the parent task.
completion_intent: false means this is a substep — Done+Finished only records progress, task stays.

Rules for completion_intent = true:
- Only use when parent task is NOT a habit (not repeatable)
- Only use when prior progress exists (1+ previous finished steps) OR task is small enough to finish now
- Action wording MUST say: "Let's finish '[parent task title]' so it can be removed from your list: [concrete final action]"
- NEVER use for: habits, verification-only steps, draft-only steps, "do not pay/send yet" steps

Rules for completion_intent = false:
- All habits must use false — say "today's session complete", NEVER "remove from list"
- All entry/substep/verify/draft/reframe actions use false
- If in doubt, use false

Habit rule (strict):
If task_type = habit OR repeatable = true:
  completion_intent MUST be false
  Never say "remove from list" or "task complete"
  Always say "today's session complete" or "habit done for today"

Progression logic:
0 prior finished steps → entry action, completion_intent = false
1 prior finished step → progress action, completion_intent = false
2+ prior finished steps → finish attempt allowed, completion_intent = true (non-habit only)
For small/simple tasks → finish attempt allowed on first suggestion
If a task is not present in the available task list, treat it as completed/removed and never generate a candidate for it.

DEEP WORK / HIGH-ENERGY RULE:
When session_mode = deep_work AND energy = high:
- Prefer important project or urgent+important tasks.
- Generate at least 2 project candidates if project tasks are available.
- Every action needs a clear start, concrete finish condition, and visible output.
- Do NOT suggest short entry/habit actions unless state is sick/stressed or no project exists.
- Bad: "Work on the project."
- Good: "Open the relevant workspace for this task, make one concrete change, test it once, and save if correct."

GROUNDING RULE:
Only use named files, functions, plans, folders, notes, apps, people, or code identifiers if they appear in the task title, available task list, active thread, or recent history.
Do NOT copy examples from this prompt into candidates.
Do NOT invent references like "Client Fix Plan", "App.jsx", "normalizeCandidate", or "parent_task_id" unless those exact words appear in the user's task list.
If the exact file/person/location is unknown, use a grounded generic phrase from the parent task, for example:
- "Open the spreadsheet, file, or system where the formula bug occurs."
- "Create a note called 'Formula bug at work' and write the current result and expected result."
If feedback = too_vague, re-ground to the parent task title instead of making an invented reference more specific.

OUTPUT: Respond ONLY with valid JSON. No preamble. No markdown.
{"candidates":[{"parent_task_id":"t_exact_task_id_from_list","parent_task_title":"exact task title from list","completion_intent":false,"action":"...","why":"...","estimated_minutes":5,"confidence":0.8,"leverage_score":4,"leverage_reason":"...","action_size":"entry","estimated_difficulty":1,"reason_chips":["entry point","visible result"],"tags":{"task_type":"other","size":"tiny","clarity":"high","visible_result":true,"energy_required":"low","time_bucket":"2_5min","friction_risk":"low"}}]}
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
                ? "→ Continue same parent task with a slightly larger concrete progress step."
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
