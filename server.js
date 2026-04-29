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
const buildSystemPrompt = ({ patterns, frictionStats, stats, availableMinutes, energy, context, state, highStakes }) => `
You are a Next Action Optimizer — a closed-loop execution system.

Your job: generate 3 diverse candidate actions likely to be completed RIGHT NOW.

CURRENT METRICS:
- Finish rate: ${stats.finishRate}%
- Friction rate: ${stats.frictionRate}%
- Total score: ${stats.totalScore}
- Streak: ${stats.streak}

CONTEXT:
- Available time: ${availableMinutes} minutes
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
6. Every candidate MUST include all tags AND reason_chips (2-4 chips each)

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
- 2 min  → entry point or tiny action only
- 5 min  → small visible action with one clear output
- 10 min → meaningful next step with clear finish condition
- 30 min → focused work block with concrete finish condition
  For 30 min: allow medium actions and project continuation.
  Still require visible output and clear finish condition.
  Bad: "Work on NAO app."
  Good: "Implement parent_task_id in candidates and test one completed one-off."

F. skipped (not urgent/high-stakes):
   Switch to lower-resistance task.
   Include chip: "switching task"

G. skipped + urgent OR skipped 2+ times same thread:
   Do NOT push same execution action.
   Generate a protection action:
   set reminder / draft delay message / ask for help /
   block calendar time / write blocker / verify information.
   Include chips: "protection action" + relevant context chips.

H. done + finished:
   Continue with slightly larger next step OR choose next best task.
   Increase scope only slightly.

I. done + none:
   Make next action more result-based. Require visible output.

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
- time = 2 min     → "2 min"
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

OUTPUT: Respond ONLY with valid JSON. No preamble. No markdown.
{"candidates":[{"action":"...","why":"...","estimated_minutes":5,"confidence":0.8,"reason_chips":["tiny step","entry point"],"tags":{"task_type":"...","size":"...","clarity":"...","visible_result":true,"energy_required":"...","time_bucket":"...","friction_risk":"..."}}]}
`.trim();

// ─── MESSAGE BUILDER ──────────────────────────────────────────────────────────
const buildMessages = ({ tasks, history, feedbackContext, availableMinutes, energy, activeThread }) => {
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

Adaptation rule for this feedback:
${activeThread.latest_feedback === "done" && activeThread.latest_result === "partial"
  ? "→ CONTINUE exact same thread. Do not switch tasks. Generate next smallest step."
  : activeThread.latest_feedback === "no_motivation"
    ? "→ Make next action produce immediate visible artifact. Do not only shrink."
    : activeThread.latest_feedback === "skipped" && activeThread.skip_count >= 2
      ? "→ PROTECTION ACTION required. Do not push execution again."
      : activeThread.latest_feedback === "skipped"
        ? "→ Switch to lower-resistance task unless urgent/high-stakes."
        : activeThread.latest_feedback === "too_big"
          ? "→ Shrink same action. Keep same thread."
          : activeThread.latest_feedback === "too_vague"
            ? "→ Add exact specifics. Keep same thread."
            : activeThread.latest_feedback === "no_time"
              ? "→ Compress under available time. Keep same thread."
              : activeThread.latest_feedback === "done" && activeThread.latest_result === "finished"
                ? "→ Continue with slightly larger step or next best task."
                : activeThread.latest_feedback === "done" && activeThread.latest_result === "none"
                  ? "→ Make next action more result-based."
                  : "→ Adapt based on feedback above."
}` : "";

  return [{
    role: "user",
    content: `Tasks:
${tasks}

Context: ${dayOfWeek} ${hour}:00, ${availableMinutes}m available, ${energy} energy

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
      rawTasks,
      history = [],
      feedbackContext = null,
      availableMinutes = 5,
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
      energy,
      context,
      state,
      highStakes,
    });

    const messages = buildMessages({
      tasks,
      history,
      feedbackContext,
      availableMinutes,
      energy,
      activeThread,
    });

    console.log("[NAO] Calling API — feedback:", feedbackContext?.feedback || "none");
    console.log("[NAO] Active thread:", activeThread?.latest_feedback || "none", "| skip_count:", activeThread?.skip_count ?? 0);
    console.log("[NAO] High-stakes:", highStakes);
    console.log("[NAO] Context:", context, "| State:", state);

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
