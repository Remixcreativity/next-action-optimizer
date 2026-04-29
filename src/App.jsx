import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = "nao_v14";
const EXPLORE_RATE = 0.15;
const MIN_ATTEMPTS_FOR_TRUST = 5;
const MIN_ATTEMPTS_FOR_DISPLAY = 3;

const SCORE_MAP = {
  done_finished: 10, done_partial: 5, done_none: 0, skipped: 0,
  too_big: -1, too_vague: -1, no_time: -1, no_motivation: -1,
};

// ─── PASS 3: PREFIX PARSER + TASK LEDGER ─────────────────────────────────────
const STORAGE_VERSION = 3;

// Pass 4: Value-aware scoring multipliers
const TASK_TYPE_MULTIPLIERS = {
  urgent_important: 1.5,
  urgent:           1.25,
  project:          1.25,
  habit:            1.0,
  one_off:          0.6,
  default:          1.0,
};

// Pass 6A: policy controls validated in simulation
const ENABLE_POLICY_LEARNING = false; // keep disabled until 50+ real loops
const POLICY_HISTORY_WINDOWS = { fatigue: 5, easyWin: 20 };

const TASK_VALUE_SCORES = {
  urgent_important: 6,
  urgent: 5,
  project: 5,
  important_project: 5,
  habit: 3,
  one_off: 1,
  normal: 1,
  default: 1,
};

const DEFAULT_LEVERAGE_BY_TASK_TYPE = {
  urgent_important: 5,
  urgent: 4,
  project: 5,
  habit: 3,
  one_off: 1,
  normal: 1,
  default: 2,
};

const getTaskMultiplier = (taskLedger, parentTaskId) => {
  if (!parentTaskId) return TASK_TYPE_MULTIPLIERS.default;
  const task = taskLedger[parentTaskId];
  if (!task) return TASK_TYPE_MULTIPLIERS.default;
  return TASK_TYPE_MULTIPLIERS[task.task_type] ?? TASK_TYPE_MULTIPLIERS.default;
};

const applyWeightedScore = (baseScore, multiplier) => {
  // Only multiply positive scores — friction stays -1, zero stays 0
  if (baseScore <= 0) return baseScore;
  return Math.round(baseScore * multiplier);
};

const PREFIX_MAP = {
  '#':  { task_type: 'habit',            urgent: false, important: false, repeatable: true  },
  '-':  { task_type: 'one_off',          urgent: false, important: false, repeatable: false },
  '!':  { task_type: 'urgent',           urgent: true,  important: false, repeatable: false },
  '*':  { task_type: 'project',          urgent: false, important: true,  repeatable: false },
  '!*': { task_type: 'urgent_important', urgent: true,  important: true,  repeatable: false },
  '*!': { task_type: 'urgent_important', urgent: true,  important: true,  repeatable: false },
};

const HIGH_STAKES_TASK_KEYWORDS = [
  'pay','payment','invoice','money','bank','banking','legal','medical',
  'client','send','delete','submit','sign','cancel','tax','contract',
  'transfer','wire','due today','deadline','irreversible',
];

const HOME_ONLY_KEYWORDS = [
  'kitchen','shower','laundry','dishes','clean','vacuum','tidy',
  'cook','bedroom','bathroom','living room','garden',
];

const WORK_BLOCKED_KEYWORDS = [...HOME_ONLY_KEYWORDS];

// Parse prefix from raw task text
const parsePrefix = (raw) => {
  const t = raw.trim();
  if (t.startsWith('!*') || t.startsWith('*!')) return '!*';
  if (t.startsWith('!')) return '!';
  if (t.startsWith('*')) return '*';
  if (t.startsWith('#')) return '#';
  if (t.startsWith('-')) return '-';
  return '';
};

// Extract clean title (strip prefix)
const cleanTitle = (raw) => raw.trim().replace(/^[!*#\-]+\s*/, '').trim();

// Detect high-stakes from title
const isHighStakesTask = (title) => {
  const lower = title.toLowerCase();
  return HIGH_STAKES_TASK_KEYWORDS.some(k => lower.includes(k));
};

// Check context suitability
const isContextSuitable = (task, context) => {
  if (!context || context === 'home') return true;
  const lower = task.clean_title.toLowerCase();
  const isHomeOnly = HOME_ONLY_KEYWORDS.some(k => lower.includes(k));
  if (isHomeOnly && ['work', 'outside', 'break'].includes(context)) return false;
  return true;
};

// Build or update task ledger from raw textarea
const buildTaskLedger = (rawText, existingLedger = {}) => {
  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  const newLedger = {};
  const seenIds = new Set();

  lines.forEach((line, idx) => {
    const prefix = parsePrefix(line);
    const title = cleanTitle(line);
    if (!title) return;

    // Use deterministic ID based on title
    const task_id = 't_' + title.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 30);
    seenIds.add(task_id);

    const existing = existingLedger[task_id];
    const prefixMeta = PREFIX_MAP[prefix] || PREFIX_MAP['-'];

    newLedger[task_id] = {
      task_id,
      raw_text: line,
      clean_title: title,
      prefix,
      task_type: prefixMeta.task_type,
      urgent: prefixMeta.urgent,
      important: prefixMeta.important,
      high_stakes: isHighStakesTask(title),
      repeatable: prefixMeta.repeatable,
      status: existing?.status || 'available',
      skip_count: existing?.skip_count || 0,
      completion_count: existing?.completion_count || 0,
      last_action_at: existing?.last_action_at || null,
      created_at: existing?.created_at || Date.now(),
      updated_at: Date.now(),
      order: idx,
    };

    // Recurring tasks are always available
    if (prefixMeta.repeatable) {
      newLedger[task_id].status = 'available';
    }
  });

  return newLedger;
};

// Eisenhower priority score (lower = higher priority)
const priorityScore = (task) => {
  if (task.task_type === 'urgent_important') return 1;
  if (task.task_type === 'urgent')           return 2;
  if (task.task_type === 'project')          return 3;
  if (task.task_type === 'habit')            return 4;
  if (task.task_type === 'one_off')          return 5;
  return 6;
};

// Get available + context-suitable tasks sorted by priority
const getAvailableTasks = (taskLedger, context) => {
  return Object.values(taskLedger)
    .filter(t => t.status === 'available')
    .filter(t => isContextSuitable(t, context))
    .sort((a, b) => priorityScore(a) - priorityScore(b) || a.order - b.order);
};

// Format available tasks for server (clean, filtered list)
const formatTasksForServer = (availableTasks) => {
  if (!availableTasks.length) return 'No available tasks.';
  return availableTasks.map(t => {
    const prefix = t.prefix ? t.prefix + ' ' : '';
    const tags = [];
    if (t.urgent) tags.push('urgent');
    if (t.important) tags.push('important');
    if (t.high_stakes) tags.push('high-stakes');
    if (t.task_type === 'habit') tags.push('recurring');
    if (t.skip_count > 0) tags.push('skipped:' + t.skip_count + 'x');
    return prefix + t.clean_title + (tags.length ? ' [' + tags.join(', ') + ']' : '');
  }).join('\n');
};


const getTaskIdFromRawLine = (line = '') => {
  const title = cleanTitle(line);
  if (!title) return null;
  return 't_' + title.toLowerCase().replace(/s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 30);
};

// Remove completed non-habit parent tasks from the raw textarea while preserving other lines.
const removeTaskLinesByIds = (rawText = '', taskIdsToRemove = new Set()) => {
  if (!taskIdsToRemove?.size) return rawText;
  return rawText
    .split('
')
    .filter(line => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const taskId = getTaskIdFromRawLine(trimmed);
      return !taskIdsToRemove.has(taskId);
    })
    .join('
')
    .replace(/
{3,}/g, '

')
    .trim();
};

const removeTaskLineFromText = (rawText = '', taskToRemove) => {
  if (!taskToRemove?.task_id) return rawText;
  return removeTaskLinesByIds(rawText, new Set([taskToRemove.task_id]));
};

const actionTextIncludesPermanentCompletion = (action = {}) => {
  const text = String((action.action || '') + ' ' + (action.why || '')).toLowerCase();
  return /mark .*complete|mark .*done|remove .*active list|remove .*task list|close .*task/.test(text);
};

const shouldAutoRemoveCompletedTask = ({ selectedFeedback, finalResult, action, task, historyAfter = [] }) => {
  if (selectedFeedback !== 'done' || finalResult !== 'finished') return false;
  if (!task || task.repeatable || task.task_type === 'habit') return false;

  const parentProgress = getParentTaskProgress(historyAfter, task.task_id);
  const closureLike = isClosureLikeAction(action);
  const hasFinishedChip = action?.reason_chips?.includes('finished');
  const oneOffFinished = task.task_type === 'one_off';
  const repeatedFinishedProgress = parentProgress.finished >= 2;
  const explicitCompletion = actionTextIncludesPermanentCompletion(action);

  return Boolean(closureLike || hasFinishedChip || explicitCompletion || oneOffFinished || repeatedFinishedProgress);
};

const getCompletedNonHabitTaskIdsFromState = (rawText = '', ledger = {}, history = []) => {
  const taskIds = new Set();
  const rawIds = new Set(rawText.split('
').map(getTaskIdFromRawLine).filter(Boolean));

  Object.values(ledger || {}).forEach(task => {
    if (!task?.task_id || task.repeatable || task.task_type === 'habit') return;
    if (task.status === 'completed') taskIds.add(task.task_id);
  });

  (history || []).forEach(entry => {
    if (!entry?.parent_task_id || !rawIds.has(entry.parent_task_id)) return;
    const task = ledger?.[entry.parent_task_id];
    if (task?.repeatable || task?.task_type === 'habit') return;
    if (entry.feedback !== 'done' || entry.result !== 'finished') return;

    const closureLike = isClosureLikeAction(entry) || entry.reason_chips?.includes('finished') || entry.parent_task_removed || actionTextIncludesPermanentCompletion(entry);
    if (closureLike) taskIds.add(entry.parent_task_id);
  });

  return taskIds;
};

const syncCompletedNonHabitTasks = (rawText = '', ledger = {}, history = []) => {
  const completedIds = getCompletedNonHabitTaskIdsFromState(rawText, ledger, history);
  if (!completedIds.size) return { tasks: rawText, ledger, removedCount: 0 };

  const nextTasks = removeTaskLinesByIds(rawText, completedIds);
  const existing = { ...(ledger || {}) };
  completedIds.forEach(id => {
    if (existing[id]) existing[id] = { ...existing[id], status: 'completed' };
  });

  return {
    tasks: nextTasks,
    ledger: buildTaskLedger(nextTasks, existing),
    removedCount: completedIds.size,
  };
};

// Context suitability display names
const CONTEXT_OPTIONS = [
  { id: 'home',      label: 'Home'      },
  { id: 'work',      label: 'Work'      },
  { id: 'morning',   label: 'Morning'   },
  { id: 'evening',   label: 'Evening'   },
  { id: 'outside',   label: 'Outside'   },
  { id: 'break',     label: 'Break'     },
];

const STATE_OPTIONS = [
  { id: 'normal',    label: 'Normal'    },
  { id: 'tired',     label: 'Tired'     },
  { id: 'sick',      label: 'Sick'      },
  { id: 'stressed',  label: 'Stressed'  },
  { id: 'restless',  label: 'Restless'  },
];


const ALLOWED_REASON_CHIPS = [
  "visible result", "continuing thread", "finished", "entry point",
  "urgent", "important",
  "tiny step", "low energy", "2 min",
  "verification", "protection action", "high-stakes",
  "switching task",
];

const CHIP_COLORS = {
  "visible result":    { bg: "#4ade8018", border: "#4ade8040", color: "#4ade80" },
  "continuing thread": { bg: "#4ade8018", border: "#4ade8040", color: "#4ade80" },
  "finished":          { bg: "#4ade8018", border: "#4ade8040", color: "#4ade80" },
  "entry point":       { bg: "#4ade8018", border: "#4ade8040", color: "#4ade80" },
  "urgent":            { bg: "#fb923c18", border: "#fb923c40", color: "#fb923c" },
  "important":         { bg: "#fb923c18", border: "#fb923c40", color: "#fb923c" },
  "tiny step":         { bg: "#38bdf818", border: "#38bdf840", color: "#38bdf8" },
  "low energy":        { bg: "#38bdf818", border: "#38bdf840", color: "#38bdf8" },
  "2 min":             { bg: "#38bdf818", border: "#38bdf840", color: "#38bdf8" },
  "verification":      { bg: "#c084fc18", border: "#c084fc40", color: "#c084fc" },
  "protection action": { bg: "#c084fc18", border: "#c084fc40", color: "#c084fc" },
  "high-stakes":       { bg: "#c084fc18", border: "#c084fc40", color: "#c084fc" },
  "switching task":    { bg: "#8899bb18", border: "#8899bb40", color: "#8899bb" },
};

const FEEDBACK_OPTIONS = [
  { id: "done", label: "Done", icon: "✓", accent: "#4ade80" },
  { id: "too_big", label: "Too big", icon: "▣", accent: "#fb923c" },
  { id: "too_vague", label: "Too vague", icon: "◌", accent: "#c084fc" },
  { id: "no_time", label: "No time", icon: "◷", accent: "#38bdf8" },
  { id: "no_motivation", label: "No motivation", icon: "◉", accent: "#f472b6" },
  { id: "skipped", label: "Skipped", icon: "✕", accent: "#f87171" },
];

const RESULT_OPTIONS = [
  { id: "none", label: "No result", pts: "+0", color: "#bbc8dd" },
  { id: "partial", label: "Partial", pts: "+5", color: "#fb923c" },
  { id: "finished", label: "Finished", pts: "+10", color: "#4ade80" },
];

const ENERGY_OPTIONS = ["low", "medium", "high"];
const ACTION_MODE_OPTIONS = [
  { id: "enter", label: "Enter", minutes: 2, hint: "start only" },
  { id: "small_win", label: "Small win", minutes: 5, hint: "visible result" },
  { id: "progress", label: "Progress", minutes: 10, hint: "meaningful step" },
  { id: "deep_work", label: "Deep work", minutes: 30, hint: "focused block" },
];

const getSessionMode = (minutes) => (
  minutes >= 30 ? "deep_work" :
  minutes >= 10 ? "progress" :
  minutes >= 5 ? "small_win" :
  "enter"
);

const getSessionModeLabel = (minutes) => (
  ACTION_MODE_OPTIONS.find(o => o.minutes === minutes)?.label || "Progress"
);

const PATTERN_MAP = {
  too_big: "Needs smaller steps",
  too_vague: "Needs concrete references",
  no_time: "Prefers ultra-fast actions",
  no_motivation: "Needs visible results",
  skipped: "Avoids certain task types",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const safeNum = (n, fallback = 0) => (typeof n === "number" && !isNaN(n) && isFinite(n)) ? n : fallback;
const safePct = (n) => Math.round(safeNum(n, 0.5) * 100);

const loadState = () => {
  try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
};
const saveState = (state) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} };
const clearState = () => { try { localStorage.removeItem(STORAGE_KEY); } catch {} };

const getScore = (feedback, result) => {
  if (feedback === "done") return SCORE_MAP[`done_${result}`] ?? 0;
  return SCORE_MAP[feedback] ?? 0;
};

const calcStats = (history) => {
  if (!history.length) return { finishRate: 0, partialRate: 0, frictionRate: 0, skipRate: 0, totalScore: 0, avgScore: 0, streak: 0, loops: 0 };
  const loops = history.length;
  const finished = history.filter(h => h.feedback === "done" && h.result === "finished").length;
  const partial = history.filter(h => h.feedback === "done" && h.result === "partial").length;
  const skipped = history.filter(h => h.feedback === "skipped").length;
  const friction = history.filter(h => h.feedback !== "done" && h.feedback !== "skipped").length;
  const totalScore = history.reduce((s, h) => s + (h.weighted_score ?? h.score ?? 0), 0);
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].feedback === "done" && history[i].result === "finished") streak++;
    else break;
  }
  return {
    finishRate: Math.round((finished / loops) * 100),
    partialRate: Math.round((partial / loops) * 100),
    frictionRate: Math.round((friction / loops) * 100),
    skipRate: Math.round((skipped / loops) * 100),
    totalScore, avgScore: Math.round((totalScore / loops) * 10) / 10, streak, loops,
  };
};

const getFrictionStats = (history) => {
  const counts = {};
  history.forEach(e => { counts[e.feedback] = (counts[e.feedback] || 0) + 1; });
  return counts;
};

const getContext = () => {
  const now = new Date();
  return { hour: now.getHours(), day_of_week: now.toLocaleDateString("en-US", { weekday: "long" }) };
};

const getTagStats = (history) => {
  const stats = {};
  history.forEach(entry => {
    if (!entry.tags) return;
    Object.entries(entry.tags).forEach(([key, value]) => {
      const tagKey = `${key}:${value}`;
      if (!stats[tagKey]) {
        stats[tagKey] = { attempts: 0, finished: 0, partial: 0, friction: 0, skipped: 0, totalScore: 0 };
      }
      stats[tagKey].attempts += 1;
      stats[tagKey].totalScore += entry.weighted_score ?? entry.score ?? 0;
      if (entry.feedback === "done" && entry.result === "finished") stats[tagKey].finished += 1;
      if (entry.feedback === "done" && entry.result === "partial") stats[tagKey].partial += 1;
      if (entry.feedback === "skipped") stats[tagKey].skipped += 1;
      if (entry.feedback !== "done" && entry.feedback !== "skipped") stats[tagKey].friction += 1;
    });
  });
  Object.keys(stats).forEach(key => {
    const s = stats[key];
    s.finishRate = Math.round((s.finished / s.attempts) * 100);
    s.avgScore = Math.round((s.totalScore / s.attempts) * 10) / 10;
    s.empirical = s.finished / s.attempts;
    s.reliability = Math.min(1, s.attempts / MIN_ATTEMPTS_FOR_TRUST);
    s.trustworthy = s.attempts >= MIN_ATTEMPTS_FOR_TRUST;
  });
  return stats;
};

// SHRINKAGE-BASED SCORING — replaces the Wilson interval approach
// Pull empirical rate toward global rate based on sample size
const scoreCandidateFromHistory = (candidate, tagStats, stats) => {
  if (!candidate || !candidate.tags) {
    return { predictedFinishProbability: 0.5, evidenceScore: 0.5, explanation: "First loop — exploring", trusted: false };
  }
  const globalRate = stats.loops > 0 ? stats.finishRate / 100 : 0.5;

  const tagValues = Object.entries(candidate.tags)
    .map(([key, value]) => ({ key: `${key}:${value}`, stats: tagStats[`${key}:${value}`] }))
    .filter(t => t.stats && t.stats.attempts > 0);

  if (!tagValues.length) {
    return { predictedFinishProbability: globalRate, evidenceScore: 0, explanation: "Exploring new pattern", trusted: false };
  }

  const weighted = tagValues.reduce((acc, { stats: tag }) => {
    const weight = Math.min(tag.attempts, 10);
    // Shrinkage: blend empirical with global based on reliability
    const useValue = tag.reliability * tag.empirical + (1 - tag.reliability) * globalRate;
    acc.finishProb += useValue * weight;
    acc.score += tag.avgScore * weight;
    acc.weight += weight;
    return acc;
  }, { finishProb: 0, score: 0, weight: 0 });

  const baseProb = weighted.weight > 0 ? weighted.finishProb / weighted.weight : globalRate;
  const avgScore = weighted.weight > 0 ? weighted.score / weighted.weight : 0;

  const probability = Math.max(0.05, Math.min(0.95, safeNum(baseProb, globalRate)));
  const finalProb = stats.streak >= 3 ? Math.min(0.95, probability + 0.03) : probability;

  const trustedTags = tagValues.filter(t => t.stats.trustworthy);
  const evidenceCount = trustedTags.length;
  const explanation = evidenceCount > 0
    ? `${safePct(finalProb)}% — based on ${evidenceCount} trusted tag${evidenceCount > 1 ? 's' : ''}`
    : `${safePct(finalProb)}% — limited evidence`;

  return {
    predictedFinishProbability: finalProb,
    evidenceScore: safeNum(avgScore, 0),
    explanation,
    trusted: evidenceCount > 0,
  };
};


const getParentTask = (candidate, taskLedgerSnapshot = {}) => (
  candidate?.parent_task_id ? taskLedgerSnapshot[candidate.parent_task_id] : null
);

const getCandidateTaskType = (candidate, taskLedgerSnapshot = {}) => {
  const parent = getParentTask(candidate, taskLedgerSnapshot);
  return parent?.task_type || candidate?.priority || candidate?.task_type || candidate?.tags?.task_type || 'default';
};

const getCandidateValueScore = (candidate, taskLedgerSnapshot = {}) => {
  const type = getCandidateTaskType(candidate, taskLedgerSnapshot);
  return TASK_VALUE_SCORES[type] ?? TASK_VALUE_SCORES.default;
};

const getCandidateLeverageScore = (candidate, taskLedgerSnapshot = {}) => {
  if (typeof candidate?.leverage_score === 'number') return Math.max(1, Math.min(5, candidate.leverage_score));
  const type = getCandidateTaskType(candidate, taskLedgerSnapshot);
  return DEFAULT_LEVERAGE_BY_TASK_TYPE[type] ?? DEFAULT_LEVERAGE_BY_TASK_TYPE.default;
};

const inferActionSize = (candidate) => {
  if (candidate?.action_size) return candidate.action_size;
  const minutes = Number(candidate?.estimated_minutes || 5);
  const tagSize = candidate?.tags?.size;
  if (minutes <= 2 || tagSize === 'tiny') return 'entry';
  if (minutes <= 5 || tagSize === 'small') return 'small_win';
  if (minutes <= 15 || tagSize === 'medium') return 'focused_progress';
  return 'deep_work';
};

const inferDifficulty = (candidate) => {
  if (typeof candidate?.estimated_difficulty === 'number') return Math.max(1, Math.min(5, candidate.estimated_difficulty));
  const size = inferActionSize(candidate);
  if (size === 'entry' || size === 'tiny') return 1;
  if (size === 'small_win') return 2;
  if (size === 'focused_progress') return 3;
  if (size === 'deep_work') return 4;
  return 2;
};

const getRecentSelectionEntries = (history = [], n = 5) =>
  history.filter(h => h.parent_task_id).slice(-n);

const isProgressOutcome = (entry) => entry?.feedback === 'done' && ['partial', 'finished'].includes(entry?.result);
const isFrictionOutcome = (entry) => entry && !isProgressOutcome(entry) && entry.feedback !== 'done';

const getProgressSensitiveFatiguePenalty = (candidate, history = [], taskLedgerSnapshot = {}) => {
  if (!candidate?.parent_task_id) return 0;
  const parentTaskId = candidate.parent_task_id;
  const recent = getRecentSelectionEntries(history, POLICY_HISTORY_WINDOWS.fatigue);
  const recentCount = recent.filter(h => h.parent_task_id === parentTaskId).length;
  if (recentCount < 3) return 0;

  const lastSame = [...history].reverse().find(h => h.parent_task_id === parentTaskId);
  const taskType = getCandidateTaskType(candidate, taskLedgerSnapshot);
  const isUrgent = ['urgent', 'urgent_important'].includes(taskType);

  // Momentum: repeated progress is allowed, with only mild rotation after excessive repetition.
  if (isProgressOutcome(lastSame)) {
    if (recentCount >= 4) return isUrgent ? 0 : -1;
    return 0;
  }

  // Stuckness: repeated friction/skips on the same task gets penalized.
  if (isFrictionOutcome(lastSame)) {
    if (recentCount >= 4) return isUrgent ? -1 : -3;
    if (recentCount >= 3) return isUrgent ? 0 : -1;
  }

  return 0;
};

const hasFeasibleHighValueEntry = (candidates = [], energy = 'medium', taskLedgerSnapshot = {}) => {
  return candidates.some(c => {
    const type = getCandidateTaskType(c, taskLedgerSnapshot);
    const highValue = ['urgent_important', 'urgent', 'project'].includes(type) || getCandidateLeverageScore(c, taskLedgerSnapshot) >= 4;
    const size = inferActionSize(c);
    const difficulty = inferDifficulty(c);
    const feasible = energy !== 'low' || size === 'entry' || size === 'tiny' || difficulty <= 2;
    return highValue && feasible;
  });
};

const getEasyWinPenalty = (candidate, history = [], candidates = [], energy = 'medium', taskLedgerSnapshot = {}) => {
  const type = getCandidateTaskType(candidate, taskLedgerSnapshot);
  if (type !== 'one_off') return 0;
  if (energy === 'low' && !hasFeasibleHighValueEntry(candidates, energy, taskLedgerSnapshot)) return 0;
  const recent = history.filter(h => h.task_type).slice(-POLICY_HISTORY_WINDOWS.easyWin);
  if (!recent.length) return 0;
  const oneOffPct = recent.filter(h => h.task_type === 'one_off').length / recent.length;
  if (oneOffPct > 0.30) return -5;
  if (oneOffPct > 0.20) return -3;
  return 0;
};

const getLowEnergyPenalty = (candidate, energy = 'medium', state = 'normal') => {
  let penalty = 0;
  const size = inferActionSize(candidate);
  const difficulty = inferDifficulty(candidate);
  if (energy === 'low' && size === 'deep_work') penalty -= 2;
  if (energy === 'low' && difficulty >= 3) penalty -= 2;
  if (state === 'tired' && difficulty >= 3) penalty -= 1;
  return penalty;
};

const getModeCapMinutes = (availableMinutes = 5) => {
  const mode = getSessionMode(availableMinutes);
  if (mode === 'enter') return 2;
  if (mode === 'small_win') return 5;
  if (mode === 'progress') return 10;
  return 30;
};

const candidateFitsSessionMode = (candidate, availableMinutes = 5) => {
  const mode = getSessionMode(availableMinutes);
  const estimated = Number(candidate?.estimated_minutes || 5);
  const size = inferActionSize(candidate);
  const cap = getModeCapMinutes(availableMinutes);

  if (estimated > cap) return false;
  if (mode === 'enter') return ['entry', 'tiny'].includes(size);
  if (mode === 'small_win') return ['entry', 'tiny', 'small_win'].includes(size);
  if (mode === 'progress') return ['entry', 'tiny', 'small_win', 'focused_progress'].includes(size);
  return true;
};

const filterCandidatesBySessionMode = (candidates = [], availableMinutes = 5) => {
  if (!candidates?.length) return candidates;
  const fitting = candidates.filter(c => candidateFitsSessionMode(c, availableMinutes));
  if (fitting.length > 0) return fitting;

  return candidates.map(c => ({
    ...c,
    confidence: Math.min((c.confidence || 0.5) * 0.45, 0.35),
    mode_fit_penalty: (c.mode_fit_penalty || 0) - 8,
  }));
};

const getSessionModeFitPenalty = (candidate, availableMinutes = 5) => {
  const mode = getSessionMode(availableMinutes);
  const cap = getModeCapMinutes(availableMinutes);
  const estimated = Number(candidate?.estimated_minutes || 5);
  const size = inferActionSize(candidate);
  let penalty = candidate.mode_fit_penalty || 0;

  if (estimated > cap) penalty -= Math.min(8, 3 + Math.ceil((estimated - cap) / 2));
  if (mode === 'enter' && !['entry', 'tiny'].includes(size)) penalty -= 6;
  if (mode === 'small_win' && ['focused_progress', 'deep_work'].includes(size)) penalty -= 6;
  if (mode === 'progress' && size === 'deep_work') penalty -= 4;
  return penalty;
};

const getActiveThreadBonus = (candidate, history = []) => {
  if (!candidate?.parent_task_id || !history.length) return 0;
  const last = history[history.length - 1];
  if (last?.parent_task_id !== candidate.parent_task_id) return 0;
  if (last.feedback === 'done' && last.result === 'partial') return 4;
  if (last.feedback === 'done' && last.result === 'finished') return 2;
  return 0;
};

const getParentTaskProgress = (history = [], parentTaskId, window = 8) => {
  if (!parentTaskId) return { finished: 0, partial: 0, progress: 0, lastSame: null };
  const same = history.filter(h => h.parent_task_id === parentTaskId).slice(-window);
  const finished = same.filter(h => h.feedback === 'done' && h.result === 'finished').length;
  const partial = same.filter(h => h.feedback === 'done' && h.result === 'partial').length;
  return { finished, partial, progress: finished + partial, lastSame: same[same.length - 1] || null };
};

const isClosureLikeAction = (candidate) => {
  const text = String((candidate?.action || '') + ' ' + (candidate?.why || '')).toLowerCase();
  return /final|finish|complete|mark .*complete|mark .*done|close|closure|save|submit|verify|test|confirm/.test(text) ||
    candidate?.reason_chips?.includes('finished');
};

const getClosurePressureBonus = (candidate, history = []) => {
  if (!candidate?.parent_task_id) return 0;
  const progress = getParentTaskProgress(history, candidate.parent_task_id);
  const lastSame = progress.lastSame;
  if (!lastSame || lastSame.feedback !== 'done') return 0;

  const size = inferActionSize(candidate);
  const closureLike = isClosureLikeAction(candidate);

  if (lastSame.result === 'finished' && progress.finished === 1) {
    if (['small_win', 'focused_progress'].includes(size)) return 1;
    if (size === 'entry') return -1;
  }

  if (lastSame.result === 'finished' && progress.finished >= 2) {
    let bonus = 0;
    if (closureLike) bonus += 3;
    if (['focused_progress', 'deep_work'].includes(size)) bonus += 2;
    if (['entry', 'tiny'].includes(size)) bonus -= 2;
    return bonus;
  }

  if (lastSame.result === 'partial') {
    if (['entry', 'small_win', 'focused_progress'].includes(size)) return 1;
  }

  return 0;
};

const getPolicyControlScore = (candidate, allCandidates, history, availableMinutes, energy, state, taskLedgerSnapshot) => {
  const value_score = getCandidateValueScore(candidate, taskLedgerSnapshot);
  const leverage_score = getCandidateLeverageScore(candidate, taskLedgerSnapshot);
  const probability_score = (candidate.predicted_finish_probability ?? 0.5) * 5;
  const active_thread_bonus = getActiveThreadBonus(candidate, history);
  const fatigue_penalty = getProgressSensitiveFatiguePenalty(candidate, history, taskLedgerSnapshot);
  const easy_win_penalty = getEasyWinPenalty(candidate, history, allCandidates, energy, taskLedgerSnapshot);
  const low_energy_penalty = getLowEnergyPenalty(candidate, energy, state);
  const closure_bonus = getClosurePressureBonus(candidate, history);
  const time_fit_penalty = getSessionModeFitPenalty(candidate, availableMinutes);
  const grounding_penalty = candidate.grounding_penalty ?? 0;
  const weak_parent_overlap_penalty = candidate.parent_task_id && groundingOverlapScore(candidate, taskLedgerSnapshot) === 0 ? -2 : 0;

  const final_selection_score =
    value_score +
    (leverage_score * 2) +
    probability_score +
    active_thread_bonus +
    fatigue_penalty +
    easy_win_penalty +
    low_energy_penalty +
    closure_bonus +
    time_fit_penalty +
    grounding_penalty +
    weak_parent_overlap_penalty;

  return {
    value_score,
    leverage_score,
    probability_score: Math.round(probability_score * 100) / 100,
    active_thread_bonus,
    fatigue_penalty,
    easy_win_penalty,
    low_energy_penalty,
    closure_bonus,
    time_fit_penalty,
    grounding_penalty,
    weak_parent_overlap_penalty,
    learned_policy_score: 0,
    final_selection_score: Math.round(final_selection_score * 100) / 100,
  };
};

const filterCandidatesByAvailability = (candidates, taskLedgerSnapshot, ctx) => {
  if (!candidates?.length) return candidates;
  const filtered = candidates.filter(c => {
    if (!c.parent_task_id) return true; // no parent yet — allow, lower confidence handled below
    const task = taskLedgerSnapshot[c.parent_task_id];
    return task && task.status === 'available' && isContextSuitable(task, ctx);
  });
  // If all filtered out, return originals (better than empty)
  return filtered.length > 0 ? filtered : candidates.map(c => ({ ...c, confidence: Math.min(c.confidence * 0.5, 0.3) }));
};

const PROMPT_ARTIFACT_TERMS = [
  'client fix plan',
  'app.jsx',
  'normalizecandidate',
  'parent_task_id',
  'bug_screenshot.png',
];

const isCreateNamedArtifactAction = (text = '') => {
  const lower = text.toLowerCase();
  return lower.includes('create a note called') || lower.includes('create a file called') || lower.includes('save it as');
};

const hasUngroundedPromptArtifact = (candidate, taskLedgerSnapshot = {}, rawTasks = '') => {
  const action = String((candidate?.action || '') + ' ' + (candidate?.why || '')).toLowerCase();
  const parent = candidate?.parent_task_id ? taskLedgerSnapshot[candidate.parent_task_id] : null;
  const allowed = String((rawTasks || '') + ' ' + (parent?.raw_text || '') + ' ' + (parent?.clean_title || '')).toLowerCase();

  // These terms came from older prompts/examples. Allow them only when the user explicitly wrote them.
  for (const term of PROMPT_ARTIFACT_TERMS) {
    if (action.includes(term) && !allowed.includes(term)) return true;
  }

  // Quoted named artifacts are risky unless they are in the task list or the action creates them.
  const quoted = [...String(candidate?.action || '').matchAll(/["']([^"']{4,80})["']/g)].map(m => m[1]);
  for (const q of quoted) {
    const qLower = q.toLowerCase();
    if (!allowed.includes(qLower) && !isCreateNamedArtifactAction(candidate?.action)) return true;
  }

  return false;
};

const groundingOverlapScore = (candidate, taskLedgerSnapshot = {}) => {
  const parent = candidate?.parent_task_id ? taskLedgerSnapshot[candidate.parent_task_id] : null;
  if (!parent?.clean_title) return 0;
  const action = String((candidate.action || '') + ' ' + (candidate.why || '')).toLowerCase();
  const stop = new Set(['the','and','for','with','work','task','app','your','this','that','from','into','where','open']);
  const words = parent.clean_title.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stop.has(w));
  if (!words.length) return 0;
  return words.filter(w => action.includes(w)).length;
};

const filterGroundedCandidates = (candidates, taskLedgerSnapshot = {}, rawTasks = '') => {
  if (!candidates?.length) return candidates;
  const filtered = candidates.filter(c => !hasUngroundedPromptArtifact(c, taskLedgerSnapshot, rawTasks));

  // If all candidates are rejected, keep them but heavily penalize so the UI does not go blank.
  return filtered.length > 0
    ? filtered
    : candidates.map(c => ({ ...c, confidence: Math.min((c.confidence || 0.5) * 0.35, 0.25), grounding_penalty: -8 }));
};

const sanitizeHabitClosureCandidates = (candidates = [], taskLedgerSnapshot = {}) => {
  return candidates.map(candidate => {
    const parent = candidate?.parent_task_id ? taskLedgerSnapshot[candidate.parent_task_id] : null;
    if (!parent || parent.task_type !== 'habit' || !parent.repeatable) return candidate;

    const combined = String((candidate.action || '') + ' ' + (candidate.why || '')).toLowerCase();
    const hasPermanentRemovalLanguage =
      combined.includes('remove it from your active list') ||
      combined.includes('remove from your active list') ||
      combined.includes('remove it from the active list') ||
      combined.includes('remove from the task list') ||
      combined.includes('remove it from your task list') ||
      combined.includes('remove the habit') ||
      combined.includes('delete the habit') ||
      /mark\s+(the\s+)?[^.]{0,40}\s+task\s+(as\s+)?complete/.test(combined) ||
      /mark\s+(the\s+)?[^.]{0,40}\s+habit\s+(as\s+)?complete/.test(combined);

    if (!hasPermanentRemovalLanguage) return candidate;

    const title = parent.clean_title || candidate.parent_task_title || 'habit';
    const chips = Array.from(new Set([
      ...(candidate.reason_chips || []).filter(chip => chip !== 'switching task'),
      'finished',
      'visible result',
      'tiny step',
    ])).slice(0, 4);

    return {
      ...candidate,
      action: `Verify you completed today's ${title} session and mark today's session complete. Keep ${title} in your recurring habit list.`,
      why: 'Habit tasks are recurring, so this closes today’s session without removing the habit.',
      reason_chips: chips,
      tags: {
        ...(candidate.tags || {}),
        task_type: candidate.tags?.task_type || 'health',
        visible_result: true,
        clarity: 'high',
      },
      grounding_penalty: 0,
    };
  });
};

const chooseCandidate = (candidates, history, availableMinutes = 5, energy = "medium", taskLedgerSnapshot = {}, state = "normal") => {
  if (!candidates || !candidates.length) return null;
  const stats = calcStats(history);
  const tagStats = getTagStats(history);

  const scored = candidates.map(c => {
    const p = scoreCandidateFromHistory(c, tagStats, stats);
    return {
      ...c,
      predicted_finish_probability: p.predictedFinishProbability,
      selection_reason: p.explanation,
      evidence_score: p.evidenceScore,
      trusted: p.trusted,
      action_size: inferActionSize(c),
      estimated_difficulty: inferDifficulty(c),
    };
  });

  const adjustedScored = scored.map(candidate => {
    let probabilityBoost = 0;
    const tags = candidate.tags || {};
    const parentTask = candidate.parent_task_id ? taskLedgerSnapshot[candidate.parent_task_id] : null;
    const ledgerType = parentTask?.task_type;

    // Deep-work mode: when the user explicitly has 30m/high energy, prefer valuable project work.
    if (availableMinutes >= 30 && energy === 'high') {
      if (['project', 'urgent_important', 'urgent'].includes(ledgerType)) probabilityBoost += 0.15;
      if ((candidate.estimated_minutes || 5) >= 15) probabilityBoost += 0.10;
      if (tags.size === 'medium') probabilityBoost += 0.05;
      if ((candidate.estimated_minutes || 5) <= 10 && ledgerType !== 'urgent') probabilityBoost -= 0.10;
      if (ledgerType === 'habit' || tags.task_type === 'health') probabilityBoost -= 0.05;
    }

    const withProbability = {
      ...candidate,
      predicted_finish_probability: Math.max(0.05, Math.min(0.95, (candidate.predicted_finish_probability || 0.5) + probabilityBoost)),
    };

    const policy = getPolicyControlScore(
      withProbability,
      scored,
      history,
      availableMinutes,
      energy,
      state,
      taskLedgerSnapshot
    );

    return {
      ...withProbability,
      ...policy,
      selection_reason: `${withProbability.selection_reason} · selection score ${policy.final_selection_score}`,
    };
  });

  const shouldExplore = Math.random() < EXPLORE_RATE && adjustedScored.length > 1;
  if (shouldExplore) {
    const idx = Math.floor(Math.random() * adjustedScored.length);
    return { ...adjustedScored[idx], selection_mode: "exploration" };
  }
  return {
    ...adjustedScored.sort((a, b) =>
      b.final_selection_score - a.final_selection_score ||
      b.predicted_finish_probability - a.predicted_finish_probability ||
      b.evidence_score - a.evidence_score
    )[0],
    selection_mode: "exploitation",
  };
};

// ─── TOLERANT PARSER ──────────────────────────────────────────────────────────
const extractJsonObject = (text) => {
  if (!text || typeof text !== "string") return null;
  let cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try { return JSON.parse(cleaned); } catch {}
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    try { return JSON.parse(fencedMatch[1].trim()); } catch {}
  }
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch {}
  }
  const firstBracket = text.indexOf("[");
  const lastBracket = text.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    try { return JSON.parse(text.slice(firstBracket, lastBracket + 1)); } catch {}
  }
  return null;
};

const normalizeCandidate = (candidate) => {
  if (!candidate || typeof candidate !== "object") return null;
  const action = candidate.action || candidate.next_action || candidate.task;
  if (!action || typeof action !== "string") return null;
  return {
    action,
    why: candidate.why || candidate.reason || candidate.reasoning || "Best next move",
    estimated_minutes: Number(candidate.estimated_minutes || candidate.minutes) || 5,
    confidence: typeof candidate.confidence === "number" ? candidate.confidence : 0.5,
    leverage_score: typeof candidate.leverage_score === "number" ? Math.max(1, Math.min(5, candidate.leverage_score)) : null,
    leverage_reason: candidate.leverage_reason || null,
    action_size: candidate.action_size || null,
    estimated_difficulty: typeof candidate.estimated_difficulty === "number" ? Math.max(1, Math.min(5, candidate.estimated_difficulty)) : null,
    active_thread_match: Boolean(candidate.active_thread_match ?? false),
    parent_task_id: candidate.parent_task_id || null,
    parent_task_title: candidate.parent_task_title || null,
    reason_chips: Array.isArray(candidate.reason_chips)
      ? candidate.reason_chips.filter(chip => ALLOWED_REASON_CHIPS.includes(chip)).slice(0, 4)
      : [],
    tags: {
      task_type: candidate.tags?.task_type || candidate.task_type || "other",
      size: candidate.tags?.size || candidate.size || "small",
      clarity: candidate.tags?.clarity || candidate.clarity || "medium",
      visible_result: typeof candidate.tags?.visible_result === "boolean"
        ? candidate.tags.visible_result
        : Boolean(candidate.visible_result ?? true),
      energy_required: candidate.tags?.energy_required || candidate.energy_required || "medium",
      time_bucket: candidate.tags?.time_bucket || candidate.time_bucket || "2_5min",
      friction_risk: candidate.tags?.friction_risk || candidate.friction_risk || "medium",
    },
  };
};

const safeParseCandidates = (text) => {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  let rawCandidates = [];
  if (Array.isArray(parsed.candidates)) rawCandidates = parsed.candidates;
  else if (Array.isArray(parsed)) rawCandidates = parsed;
  else if (parsed.action || parsed.next_action || parsed.task) rawCandidates = [parsed];
  else if (Array.isArray(parsed.actions)) rawCandidates = parsed.actions;
  const candidates = rawCandidates.map(normalizeCandidate).filter(Boolean).slice(0, 5);
  return candidates.length > 0 ? { candidates } : null;
};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

// ─── PROFILE ──────────────────────────────────────────────────────────────────
const buildProfile = (history) => {
  if (history.length < MIN_ATTEMPTS_FOR_DISPLAY) {
    return { ready: false, message: `Need ${MIN_ATTEMPTS_FOR_DISPLAY - history.length} more loop${MIN_ATTEMPTS_FOR_DISPLAY - history.length > 1 ? 's' : ''} to build your profile.` };
  }
  const tagStats = getTagStats(history);
  const stats = calcStats(history);
  const dimensions = {};
  Object.entries(tagStats).forEach(([key, s]) => {
    const [dim, val] = key.split(":");
    if (!dimensions[dim]) dimensions[dim] = [];
    if (s.attempts >= MIN_ATTEMPTS_FOR_DISPLAY) {
      dimensions[dim].push({ value: val, ...s });
    }
  });
  const insights = [];
  Object.entries(dimensions).forEach(([dim, values]) => {
    if (values.length < 2) return;
    const sorted = [...values].sort((a, b) => b.empirical - a.empirical);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    if (best.empirical - worst.empirical > 0.15) {
      insights.push({
        dimension: dim,
        best: { value: best.value, finishRate: best.finishRate, attempts: best.attempts, trusted: best.trustworthy },
        worst: { value: worst.value, finishRate: worst.finishRate, attempts: worst.attempts, trusted: worst.trustworthy },
      });
    }
  });
  const energyStats = {};
  history.forEach(h => {
    if (!h.energy) return;
    if (!energyStats[h.energy]) energyStats[h.energy] = { attempts: 0, finished: 0 };
    energyStats[h.energy].attempts++;
    if (h.feedback === "done" && h.result === "finished") energyStats[h.energy].finished++;
  });
  const bestEnergy = Object.entries(energyStats)
    .filter(([, s]) => s.attempts >= MIN_ATTEMPTS_FOR_DISPLAY)
    .map(([e, s]) => ({ energy: e, finishRate: Math.round((s.finished / s.attempts) * 100), attempts: s.attempts }))
    .sort((a, b) => b.finishRate - a.finishRate);
  return { ready: true, stats, insights, bestEnergy, totalLoops: history.length, trustedSampleSize: history.length >= MIN_ATTEMPTS_FOR_TRUST };
};

// ─── UI COMPONENTS ────────────────────────────────────────────────────────────
const ScoreFlash = ({ score, onDone, multiplier = 1 }) => {
  useEffect(() => { const t = setTimeout(onDone, 1200); return () => clearTimeout(t); }, [onDone]);
  const color = score > 0 ? "#4ade80" : score < 0 ? "#f87171" : "#555";
  const label = score > 0 ? `+${score}${multiplier > 1 ? " ×" + multiplier.toFixed(1) : ""}` : score === 0 ? "±0" : score;
  return <div style={{ ...S.scoreFlash, color }}>{label}</div>;
};

const Sparkline = ({ history }) => {
  if (history.length < 2) return null;
  const scores = history.slice(-14).map(h => h.score ?? 0);
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 1);
  const range = max - min || 1;
  const W = 100, H = 28;
  const pts = scores.map((s, i) => `${(i / (scores.length - 1)) * W},${H - ((s - min) / range) * H}`).join(" ");
  const lastY = H - ((scores[scores.length - 1] - min) / range) * H;
  return (
    <svg width={W} height={H} style={{ overflow: "visible" }}>
      <polyline points={pts} fill="none" stroke="#4ade8030" strokeWidth="2" />
      <polyline points={pts} fill="none" stroke="#4ade8080" strokeWidth="1" />
      <circle cx={W} cy={lastY} r="2.5" fill="#4ade80" />
    </svg>
  );
};

const ActionCard = ({ action, variant = "default", isFirstLoop = false }) => {
  if (!action) return null;
  return (
    <div style={{ ...S.actionCard, ...(variant === "green" ? { borderColor: "#122012", background: "#0f2318" } : {}) }}>
      <p style={S.actionText}>{action.action}</p>
      {action.reason_chips?.length > 0 && (
        <div style={S.chipsRow}>
          {action.reason_chips.map((chip, i) => {
            const cs = CHIP_COLORS[chip] || CHIP_COLORS["switching task"];
            return (
              <span key={i} style={{
                fontSize: 9, padding: "3px 8px", borderRadius: 20,
                background: cs.bg, border: `1px solid ${cs.border}`,
                color: cs.color, letterSpacing: "0.06em", whiteSpace: "nowrap",
              }}>
                {chip}
              </span>
            );
          })}
        </div>
      )}
      <p style={variant === "green" ? { ...S.whyText, color: "#6ade9a" } : S.whyText}>{action.why}</p>
      <div style={S.actionFooter}>
        <span style={S.timePill}>~{action.estimated_minutes} min</span>
        <span style={S.potentialPts}>finish → <b style={{ color: "#4ade80" }}>+10 pts</b></span>
      </div>
      {action.tags && (
        <div style={S.tagRow}>
          <span style={S.tagChip}>{action.tags.task_type}</span>
          <span style={S.tagChip}>{action.tags.size}</span>
          <span style={S.tagChip}>{action.tags.energy_required} energy</span>
        </div>
      )}
      {action.selection_reason && (
        <p style={{ ...S.selectionReason, color: action.trusted ? "#2a4a2a" : "#252525" }}>
          {isFirstLoop ? "first loop — building your profile" : action.selection_reason}
        </p>
      )}
    </div>
  );
};

const ProfileScreen = ({ history, onClose, taskLedger = {} }) => {
  const profile = buildProfile(history);
  if (!profile.ready) {
    return (
      <div className="fadein">
        <p style={S.eyebrow}>your profile</p>
        <div style={S.profileEmpty}><p style={S.profileEmptyText}>{profile.message}</p></div>
        <button style={S.btnSecondary} onClick={onClose}>← tasks</button>
      </div>
    );
  }
  return (
    <div className="fadein">
      <p style={S.eyebrow}>your profile</p>
      <div style={S.profileHeader}>
        <p style={S.profileSubtle}>based on {profile.totalLoops} loops{!profile.trustedSampleSize && " · still building confidence"}</p>
      </div>
      {profile.insights.length > 0 && (
        <div style={S.profileSection}>
          <p style={S.profileSectionTitle}>what works for you</p>
          {profile.insights.map((insight, i) => (
            <div key={i} style={S.insightCard}>
              <p style={S.insightDim}>{insight.dimension.replace(/_/g, " ")}</p>
              <div style={S.insightRow}>
                <div style={S.insightWin}>
                  <span style={S.insightWinDot}>●</span>
                  <span style={S.insightVal}>{insight.best.value}</span>
                  <span style={S.insightRate}>{insight.best.finishRate}%</span>
                  <span style={S.insightCount}>{insight.best.attempts}x</span>
                </div>
                <div style={S.insightLose}>
                  <span style={S.insightLoseDot}>●</span>
                  <span style={S.insightVal}>{insight.worst.value}</span>
                  <span style={S.insightRate}>{insight.worst.finishRate}%</span>
                  <span style={S.insightCount}>{insight.worst.attempts}x</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {profile.bestEnergy.length > 0 && (
        <div style={S.profileSection}>
          <p style={S.profileSectionTitle}>your states</p>
          {profile.bestEnergy.map((e, i) => (
            <div key={i} style={S.energyRow}>
              <span style={S.energyLabel}>{e.energy} energy</span>
              <div style={S.energyBarTrack}>
                <div style={{ ...S.energyBarFill, width: `${e.finishRate}%` }} />
              </div>
              <span style={S.energyRate}>{e.finishRate}%</span>
            </div>
          ))}
        </div>
      )}
      {profile.insights.length === 0 && (
        <div style={S.profileEmpty}>
          <p style={S.profileEmptyText}>No clear patterns yet. Keep running loops — differences will emerge.</p>
        </div>
      )}
      <button style={{ ...S.btnSecondary, marginTop: 8 }} onClick={onClose}>← tasks</button>
    </div>
  );
};


// ─── BOTTOM SHEET ─────────────────────────────────────────────────────────────
const BottomSheet = ({ show, onClose, children }) => {
  if (!show) return null;
  return (
    <div style={BS.overlay} onClick={onClose}>
      <div style={BS.sheet} onClick={e => e.stopPropagation()} className="slideUp">
        <button style={BS.closeBtn} onClick={onClose}>×</button>
        {children}
      </div>
    </div>
  );
};

const BS = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'flex-end' },
  sheet: { width: '100%', maxHeight: '80vh', overflowY: 'auto', background: '#16213e', borderRadius: '16px 16px 0 0', padding: '24px 20px 40px', position: 'relative' },
  closeBtn: { position: 'absolute', top: 14, right: 18, background: 'none', border: 'none', color: '#8899bb', fontSize: 22, cursor: 'pointer', lineHeight: 1 },
};

// ─── GUIDE CONTENT ─────────────────────────────────────────────────────────────
const GuideSheet = ({ show, onClose }) => (
  <BottomSheet show={show} onClose={onClose}>
    <p style={GS.title}>how to use</p>

    <p style={GS.section}>Goal</p>
    <p style={GS.body}>NAO helps you move what matters without getting stuck. It chooses one next action, not the whole life plan.</p>

    <p style={GS.section}>1. Dump your tasks</p>
    <div style={GS.codeBlock}>
      <p style={GS.code}><span style={GS.prefix}>#</span> meditation <span style={GS.dim}>→ habit / routine</span></p>
      <p style={GS.code}><span style={GS.prefix}>*</span> work on app <span style={GS.dim}>→ important / project</span></p>
      <p style={GS.code}><span style={GS.prefix}>!</span> pay invoice <span style={GS.dim}>→ urgent</span></p>
      <p style={GS.code}><span style={GS.prefix}>*!</span> fix bug <span style={GS.dim}>→ urgent + important</span></p>
      <p style={GS.code}><span style={GS.prefix}>-</span> buy chair <span style={GS.dim}>→ normal one-off</span></p>
    </div>

    <p style={GS.section}>2. Choose mode</p>
    <div style={GS.codeBlock}>
      <p style={GS.code}>Enter <span style={GS.dim}>→ smallest possible start</span></p>
      <p style={GS.code}>Small win <span style={GS.dim}>→ one visible result</span></p>
      <p style={GS.code}>Progress <span style={GS.dim}>→ meaningful step forward</span></p>
      <p style={GS.code}>Deep work <span style={GS.dim}>→ focused block for important work</span></p>
    </div>

    <p style={GS.section}>3. Set energy honestly</p>
    <p style={GS.body}>Low = easier action. Medium = normal step. High = bigger action.</p>

    <p style={GS.section}>4. Do the suggested action</p>
    <p style={GS.body}>Finished means you completed the exact suggested action — not necessarily the whole parent task.</p>
    <div style={GS.codeBlock}>
      <p style={GS.code}>App says: “Open the file and identify the failing formula.”</p>
      <p style={GS.code}>You did that → Done + Finished</p>
    </div>

    <p style={GS.section}>5. Give feedback</p>
    <div style={GS.codeBlock}>
      <p style={GS.code}><span style={{ color: '#4ade80' }}>✓</span> Finished <span style={GS.dim}>→ exact action completed</span></p>
      <p style={GS.code}><span style={{ color: '#fb923c' }}>✓</span> Partial <span style={GS.dim}>→ only part of action completed</span></p>
      <p style={GS.code}><span style={{ color: '#fb923c' }}>▣</span> Too big <span style={GS.dim}>→ shrink</span></p>
      <p style={GS.code}><span style={{ color: '#c084fc' }}>◌</span> Too vague <span style={GS.dim}>→ clarify</span></p>
      <p style={GS.code}><span style={{ color: '#38bdf8' }}>◷</span> No time <span style={GS.dim}>→ compress</span></p>
      <p style={GS.code}><span style={{ color: '#f472b6' }}>◉</span> No motivation <span style={GS.dim}>→ make result visible</span></p>
      <p style={GS.code}><span style={{ color: '#f87171' }}>✕</span> Skipped <span style={GS.dim}>→ reframe or switch</span></p>
    </div>

    <p style={GS.section}>What NAO learns</p>
    <p style={GS.body}>Finished → slightly bigger next step. Finished twice → push toward closure. Partial → continue same thread. Too big → shrink. Too vague → clarify. No motivation → visible result. Repeated stuckness → change strategy.</p>

    <p style={GS.section}>One rule</p>
    <p style={GS.body}>NAO does not chase easy checkmarks. Easy tasks can create momentum, but valuable tasks should move forward.</p>
  </BottomSheet>
);

const GS = {
  title: { fontSize: 11, letterSpacing: '0.3em', textTransform: 'uppercase', color: '#8899bb', marginBottom: 20 },
  section: { fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#4ade80', marginTop: 20, marginBottom: 8 },
  body: { fontSize: 13, color: '#ccd5e8', lineHeight: 1.8, whiteSpace: 'pre-line' },
  codeBlock: { background: '#1a2a4a', borderRadius: 8, padding: '12px 14px' },
  code: { fontSize: 12, fontFamily: 'inherit', lineHeight: 2, margin: 0 },
  prefix: { color: '#4ade80', fontWeight: 500 },
  dim: { color: '#8899bb' },
};

// ─── MENU CONTENT ──────────────────────────────────────────────────────────────
const MenuSheet = ({ show, onClose, onExport, onImport, onClearTasks, onResetLearning }) => (
  <BottomSheet show={show} onClose={onClose}>
    <p style={GS.title}>options</p>

    <button style={MS.item} onClick={() => { onExport(); onClose(); }}>
      <span style={MS.icon}>↓</span>
      <div><p style={MS.label}>Export data</p><p style={MS.sub}>Download your history + profile as JSON</p></div>
    </button>

    <label style={MS.item}>
      <span style={MS.icon}>↑</span>
      <div><p style={MS.label}>Import data</p><p style={MS.sub}>Restore from a previous export</p></div>
      <input type="file" accept=".json" onChange={(e) => { onImport(e); onClose(); }} style={{ display: 'none' }} />
    </label>

    <div style={MS.divider} />

    <button style={MS.item} onClick={() => { onClearTasks(); onClose(); }}>
      <span style={MS.icon}>⌫</span>
      <div><p style={MS.label}>Clear task list</p><p style={MS.sub}>Keeps all learning history</p></div>
    </button>

    <button style={{ ...MS.item, ...MS.danger }} onClick={onResetLearning}>
      <span style={MS.icon}>⚠</span>
      <div><p style={{ ...MS.label, color: '#f87171' }}>Reset all learning</p><p style={MS.sub}>Delete history, profile, patterns</p></div>
    </button>
  </BottomSheet>
);

const MS = {
  item: { display: 'flex', alignItems: 'center', gap: 14, width: '100%', background: 'none', border: 'none', borderRadius: 8, padding: '12px 4px', cursor: 'pointer', textAlign: 'left', borderBottom: '1px solid #1e2e4e' },
  icon: { fontSize: 16, color: '#8899bb', width: 24, textAlign: 'center', flexShrink: 0 },
  label: { fontSize: 13, color: '#e8e8e8', margin: 0, marginBottom: 2 },
  sub: { fontSize: 11, color: '#8899bb', margin: 0 },
  divider: { height: 1, background: '#2a3a5c', margin: '8px 0' },
  danger: { marginTop: 4 },
};

// ─── CONFIRM RESET ─────────────────────────────────────────────────────────────
const ConfirmResetSheet = ({ show, onClose, options, setOptions, onConfirm }) => (
  <BottomSheet show={show} onClose={onClose}>
    <p style={GS.title}>reset all learning</p>
    <p style={{ fontSize: 13, color: '#8899bb', marginBottom: 20, lineHeight: 1.6 }}>
      This will permanently delete selected data. This cannot be undone.
    </p>

    {[
      { key: 'tasks', label: 'Clear task list', sub: 'Removes current tasks, keeps history' },
      { key: 'learning', label: 'Clear learning history', sub: 'Deletes all loops, scores, patterns and profile' },
    ].map(({ key, label, sub }) => (
      <button key={key} style={CR.row} onClick={() => setOptions(o => ({ ...o, [key]: !o[key] }))}>
        <div style={{ ...CR.checkbox, background: options[key] ? '#f87171' : 'transparent', borderColor: options[key] ? '#f87171' : '#2a3a5c' }}>
          {options[key] && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
        </div>
        <div>
          <p style={{ fontSize: 13, color: '#e8e8e8', margin: 0, marginBottom: 2 }}>{label}</p>
          <p style={{ fontSize: 11, color: '#8899bb', margin: 0 }}>{sub}</p>
        </div>
      </button>
    ))}

    <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
      <button style={CR.cancel} onClick={onClose}>Cancel</button>
      <button
        style={{ ...CR.confirm, opacity: (options.tasks || options.learning || options.profile) ? 1 : 0.3 }}
        onClick={onConfirm}
        disabled={!options.tasks && !options.learning && !options.profile}
      >
        Reset learning
      </button>
    </div>
  </BottomSheet>
);

const CR = {
  row: { display: 'flex', alignItems: 'center', gap: 12, width: '100%', background: 'none', border: 'none', borderBottom: '1px solid #1e2e4e', padding: '12px 4px', cursor: 'pointer', textAlign: 'left' },
  checkbox: { width: 20, height: 20, borderRadius: 4, border: '1px solid #2a3a5c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  cancel: { flex: 1, padding: '13px', background: '#1e2a45', color: '#8899bb', border: '1px solid #2a3a5c', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' },
  confirm: { flex: 1, padding: '13px', background: '#f87171', color: '#fff', border: 'none', borderRadius: 8, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.05em' },
};

// ─── TOAST ─────────────────────────────────────────────────────────────────────
const Toast = ({ toast, onDismiss }) => {
  if (!toast) return null;
  return (
    <div style={TS.container} className="fadeIn">
      <span style={TS.msg}>{toast.msg}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        {toast.undoFn && <button style={TS.undo} onClick={() => { toast.undoFn(); onDismiss(); }}>Undo</button>}
        <button style={TS.dismiss} onClick={onDismiss}>×</button>
      </div>
    </div>
  );
};

const TS = {
  container: { position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#1e2a45', border: '1px solid #2a3a5c', borderRadius: 10, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, zIndex: 300, maxWidth: 360, width: 'calc(100% - 40px)', boxShadow: '0 4px 20px rgba(0,0,0,0.4)' },
  msg: { fontSize: 12, color: '#ccd5e8', flex: 1, letterSpacing: '0.02em' },
  undo: { fontSize: 11, color: '#4ade80', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.1em', padding: 0 },
  dismiss: { fontSize: 16, color: '#8899bb', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1 },
};



// ─── SYSTEM MODEL PANEL ───────────────────────────────────────────────────────
const SystemModelPanel = ({ taskLedger }) => {
  const tasks = Object.values(taskLedger);
  if (!tasks.length) return null;

  const byType = {
    habit:            tasks.filter(t => t.task_type === 'habit'),
    urgent_important: tasks.filter(t => t.task_type === 'urgent_important'),
    urgent:           tasks.filter(t => t.task_type === 'urgent'),
    project:          tasks.filter(t => t.task_type === 'project'),
    one_off:          tasks.filter(t => t.task_type === 'one_off' && t.status === 'available'),
    completed:        tasks.filter(t => t.status === 'completed'),
    suppressed:       tasks.filter(t => t.status === 'suppressed'),
  };

  const typeLabels = {
    urgent_important: { label: 'Urgent + Important', color: '#fb923c' },
    urgent:           { label: 'Urgent',              color: '#fb923c' },
    project:          { label: 'Important Projects',  color: '#4ade80' },
    habit:            { label: 'Recurring Habits',    color: '#38bdf8' },
    one_off:          { label: 'One-off Tasks',       color: '#8899bb' },
    completed:        { label: 'Completed',           color: '#2a3a5c' },
    suppressed:       { label: 'Suppressed (skipped 2x)', color: '#2a3a5c' },
  };

  return (
    <div style={{ marginTop: 8 }}>
      <p style={{ fontSize: 9, color: '#8899bb', letterSpacing: '0.25em', textTransform: 'uppercase', marginBottom: 12 }}>system model</p>
      {Object.entries(typeLabels).map(([type, meta]) => {
        const items = byType[type];
        if (!items?.length) return null;
        return (
          <div key={type} style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 9, color: meta.color, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6 }}>{meta.label}</p>
            {items.map(task => (
              <div key={task.task_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid #1a2a3a' }}>
                <span style={{ fontSize: 11, color: '#ccd5e8' }}>{task.clean_title}</span>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {task.high_stakes && <span style={{ fontSize: 9, color: '#c084fc' }}>⚠</span>}
                  {task.skip_count > 0 && <span style={{ fontSize: 9, color: '#f87171' }}>skip:{task.skip_count}</span>}
                  {task.completion_count > 0 && <span style={{ fontSize: 9, color: '#4ade80' }}>done:{task.completion_count}</span>}
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [hydrated, setHydrated] = useState(false);
  const [screen, setScreen] = useState("input");
  const [tasks, setTasks] = useState("");
  const [availableMinutes, setAvailableMinutes] = useState(5);
  const [energy, setEnergy] = useState("medium");
  const [currentAction, setCurrentAction] = useState(null);
  const [candidateSet, setCandidateSet] = useState([]);
  const [adaptedAction, setAdaptedAction] = useState(null);
  const [selectedFeedback, setSelectedFeedback] = useState(null);
  const [result, setResult] = useState(null);
  const [frictionNote, setFrictionNote] = useState("");
  const [history, setHistory] = useState([]);
  const [patterns, setPatterns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [flashScore, setFlashScore] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [context, setContext] = useState("home");
  const [state, setState] = useState("normal");
  const [taskLedger, setTaskLedger] = useState({});
  const [showContext, setShowContext] = useState(false);
  const [error, setError] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const [resetOptions, setResetOptions] = useState({ tasks: false, learning: true });
  const [toast, setToast] = useState(null);
  const [usedModel, setUsedModel] = useState(null);
  const textareaRef = useRef(null);
  const toastTimerRef = useRef(null);
  const submittingFeedbackRef = useRef(false);

  useEffect(() => {
    const saved = loadState();
    if (saved) {
      const loadedHistory = saved.history || [];
      const loadedLedger = saved.taskLedger || {};
      const loadedTasks = saved.tasks || '';
      const synced = syncCompletedNonHabitTasks(loadedTasks, loadedLedger, loadedHistory);

      if (loadedTasks || synced.tasks) setTasks(synced.tasks);
      if (loadedHistory) setHistory(loadedHistory);
      if (saved.patterns) setPatterns(saved.patterns);
      if (saved.availableMinutes) setAvailableMinutes(saved.availableMinutes);
      if (saved.energy) setEnergy(saved.energy);
      if (saved.context) setContext(saved.context);
      if (saved.state) setState(saved.state);
      setTaskLedger(synced.ledger || loadedLedger);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveState({ version: STORAGE_VERSION, tasks, history, patterns, availableMinutes, energy, context, state, taskLedger });
  }, [tasks, history, patterns, availableMinutes, energy, context, state, taskLedger, hydrated]);

  // Rebuild task ledger whenever tasks or context changes
  // Also clear stale currentAction if its parent task no longer exists
  useEffect(() => {
    if (!hydrated) return;
    const synced = syncCompletedNonHabitTasks(tasks, taskLedger, history);
    if (synced.tasks !== tasks) {
      setTasks(synced.tasks);
      setTaskLedger(synced.ledger);
      return;
    }
    const newLedger = buildTaskLedger(tasks, taskLedger);
    setTaskLedger(newLedger);

    // Check if currentAction/adaptedAction parent still exists
    const hasActive = currentAction || adaptedAction;
    if (hasActive) {
      const action = currentAction || adaptedAction;
      const parentId = action?.parent_task_id;
      const parentExists = parentId
        ? newLedger[parentId]?.status === 'available' && isContextSuitable(newLedger[parentId], context)
        : true; // no parent_task_id yet — allow (Pass 4 will enforce)

      if (!parentExists) {
        setCurrentAction(null);
        setAdaptedAction(null);
        setCandidateSet([]);
        setSelectedFeedback(null);
        setResult(null);
        setFrictionNote("");
        setError(null);
        setScreen("input");
        showToast("Task list changed — current action cleared");
      }
    }
  }, [tasks, context, history, hydrated]);

  useEffect(() => {
    if (screen === "input" && textareaRef.current) textareaRef.current.focus();
  }, [screen]);

  const stats = calcStats(history);

  const getAction = useCallback(async ({
    feedbackContext = null,
    historyOverride = history,
    patternsOverride = patterns,
    activeThreadOverride = null,
    taskLedgerOverride = null,
    tasksOverride = null,
  } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const ledgerForRequest = taskLedgerOverride || taskLedger;
      const rawTasksForRequest = typeof tasksOverride === 'string' ? tasksOverride : tasks;
      const availableTasksForRequest = getAvailableTasks(ledgerForRequest, context);

      // App.jsx sends raw context only — server owns behavioral prompting
      const response = await fetch("/api/next-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks: formatTasksForServer(availableTasksForRequest),
          availableTasks: availableTasksForRequest,
          rawTasks: rawTasksForRequest,
          history: historyOverride,
          feedbackContext,
          availableMinutes,
          sessionMode: getSessionMode(availableMinutes),
          energy,
          context,
          state,
          patterns: patternsOverride,
          activeThread: activeThreadOverride,
        }),
      });

      const data = await response.json();

      if (data.error) {
        throw new Error(`API error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      const text = data.text || "";
      if (!text) throw new Error("Empty response from server");
      if (data.usedModel) setUsedModel(data.usedModel);

      const parsed = safeParseCandidates(text);
      if (!parsed) {
        throw new Error(`Parse failed: ${text.slice(0, 120).replace(/\n/g, " ")}`);
      }

      // Filter candidates whose parent task is no longer available, reject prompt/example leakage,
      // and sanitize habit closure wording so recurring habits are never removed.
      const availableCandidates = filterCandidatesByAvailability(parsed.candidates, ledgerForRequest, context);
      const groundedCandidates = filterGroundedCandidates(availableCandidates, ledgerForRequest, rawTasksForRequest);
      const habitSafeCandidates = sanitizeHabitClosureCandidates(groundedCandidates, ledgerForRequest);
      const modeSafeCandidates = filterCandidatesBySessionMode(habitSafeCandidates, availableMinutes);
      const chosen = chooseCandidate(modeSafeCandidates, historyOverride, availableMinutes, energy, ledgerForRequest, state);
      return { chosen, candidates: modeSafeCandidates };
    } catch (e) {
      console.error("getAction error:", e);
      setError(e.message || "Something went wrong");
      return { chosen: null, candidates: [] };
    } finally {
      setLoading(false);
    }
  }, [tasks, history, patterns, availableMinutes, energy, taskLedger, context, state]);

  const handleStart = async () => {
    if (!tasks.trim()) return;
    const { chosen, candidates } = await getAction();
    if (!chosen) return;
    setCurrentAction(chosen);
    setCandidateSet(candidates);
    setScreen("action");
  };


  const isDuplicateLastEntry = (hist, entry) => {
    const last = hist[hist.length - 1];
    if (!last) return false;
    return (
      last.action === entry.action &&
      last.feedback === entry.feedback &&
      last.result === entry.result &&
      (last.parent_task_id || null) === (entry.parent_task_id || null) &&
      Date.now() - (last.ts || 0) < 8000
    );
  };

  const handleFeedbackSubmit = async () => {
    if (submittingFeedbackRef.current) return;
    if (!selectedFeedback || !currentAction) return;
    submittingFeedbackRef.current = true;
    setLoading(true);
    try {
      const finalResult = selectedFeedback === "done" ? (result || "none") : "none";
      const baseScore = getScore(selectedFeedback, finalResult);
      const multiplier = getTaskMultiplier(taskLedger, currentAction?.parent_task_id);
      const weightedScore = applyWeightedScore(baseScore, multiplier);
      const feedbackContext = { feedback: selectedFeedback, result: finalResult, note: frictionNote };
      const ctx = getContext();
      const newEntry = {
        action: currentAction.action,
        why: currentAction.why,
        feedback: selectedFeedback,
        result: finalResult,
        base_score: baseScore,
        weighted_score: weightedScore,
        score: weightedScore,           // kept for backwards compat
        multiplier,
        parent_task_id: currentAction.parent_task_id || null,
        parent_task_title: currentAction.parent_task_title || null,
        task_type: taskLedger[currentAction.parent_task_id]?.task_type || null,
        priority: taskLedger[currentAction.parent_task_id]?.task_type || null,
        tags: currentAction.tags,
        estimated_minutes: currentAction.estimated_minutes,
        reason_chips: currentAction.reason_chips || [],
        predicted_finish_probability: currentAction.predicted_finish_probability ?? 0.5,
        selection_mode: currentAction.selection_mode || "unknown",
        leverage_score: currentAction.leverage_score ?? null,
        leverage_reason: currentAction.leverage_reason || null,
        action_size: currentAction.action_size || inferActionSize(currentAction),
        estimated_difficulty: currentAction.estimated_difficulty || inferDifficulty(currentAction),
        final_selection_score: currentAction.final_selection_score ?? null,
        value_score: currentAction.value_score ?? null,
        probability_score: currentAction.probability_score ?? null,
        active_thread_bonus: currentAction.active_thread_bonus ?? null,
        fatigue_penalty: currentAction.fatigue_penalty ?? null,
        easy_win_penalty: currentAction.easy_win_penalty ?? null,
        low_energy_penalty: currentAction.low_energy_penalty ?? null,
        closure_bonus: currentAction.closure_bonus ?? null,
        time_fit_penalty: currentAction.time_fit_penalty ?? null,
        policy_learning_enabled: ENABLE_POLICY_LEARNING,
        available_minutes: availableMinutes,
        session_mode: getSessionMode(availableMinutes),
        session_mode_label: getSessionModeLabel(availableMinutes),
        energy,
        context,
        state,
        hour: ctx.hour,
        day_of_week: ctx.day_of_week,
        note: frictionNote,
        ts: Date.now(),
      };

      if (isDuplicateLastEntry(history, newEntry)) {
        setError("Duplicate feedback ignored.");
        return;
      }

      const newHistory = [...history, newEntry];
      const newPatterns = PATTERN_MAP[selectedFeedback]
        ? [...new Set([...patterns, PATTERN_MAP[selectedFeedback]])]
        : patterns;

      let nextTaskLedger = taskLedger;
      let nextTasks = tasks;
      let removedTask = null;

      // Update task ledger based on feedback — use parent_task_id first
      if (currentAction) {
        let matchingTask = null;
        // Primary: use parent_task_id (reliable)
        if (currentAction.parent_task_id && taskLedger[currentAction.parent_task_id]) {
          matchingTask = taskLedger[currentAction.parent_task_id];
        } else {
          // Fallback: text match (fragile, removed in Pass 4 when all candidates have parent_task_id)
          matchingTask = Object.values(taskLedger).find(t =>
            currentAction.action.toLowerCase().includes(t.clean_title.toLowerCase()) ||
            t.clean_title.toLowerCase().split(' ').some(word =>
              word.length > 3 && currentAction.action.toLowerCase().includes(word)
            )
          );
        }

        if (matchingTask) {
          const updatedLedger = { ...taskLedger };
          const task = { ...updatedLedger[matchingTask.task_id] };
          task.last_action_at = Date.now();

          if (selectedFeedback === 'skipped') {
            task.skip_count = (task.skip_count || 0) + 1;
            if (task.skip_count >= 2 && task.task_type === 'one_off') {
              task.status = 'suppressed';
            }
          }

          if (selectedFeedback === 'done' && finalResult === 'finished') {
            task.completion_count = (task.completion_count || 0) + 1;
            task.skip_count = 0;

            const shouldRemove = shouldAutoRemoveCompletedTask({
              selectedFeedback,
              finalResult,
              action: currentAction,
              task,
              historyAfter: newHistory,
            });

            if (shouldRemove) {
              task.status = 'completed';
              removedTask = task;
              nextTasks = removeTaskLineFromText(tasks, task);
              nextTaskLedger = buildTaskLedger(nextTasks, { ...updatedLedger, [task.task_id]: task });
              newEntry.parent_task_removed = true;
              newEntry.parent_task_removed_reason = 'completed_non_habit';
            } else {
              if (task.task_type === 'one_off' && isClosureLikeAction(currentAction)) {
                task.status = 'completed';
              }
              updatedLedger[matchingTask.task_id] = task;
              nextTaskLedger = updatedLedger;
            }
          } else {
            updatedLedger[matchingTask.task_id] = task;
            nextTaskLedger = updatedLedger;
          }
        }
      }

      setHistory(newHistory);
      setPatterns(newPatterns);
      setFlashScore(weightedScore);
      setTaskLedger(nextTaskLedger);

      if (removedTask) {
        const previousTasks = tasks;
        const previousLedger = taskLedger;
        setTasks(nextTasks);
        setCurrentAction(null);
        setAdaptedAction(null);
        setCandidateSet([]);
        showToast(`Completed and removed: ${removedTask.clean_title}`, () => {
          setTasks(previousTasks);
          setTaskLedger(previousLedger);
          showToast("Task restored");
        });
      }

      // Build activeThread from newHistory so skip_count is accurate.
      // If the parent task was removed, do not continue the old thread.
      const activeThread = removedTask
        ? null
        : buildActiveThread(feedbackContext, currentAction, newHistory, nextTaskLedger, context);

      const { chosen, candidates } = await getAction({
        feedbackContext,
        historyOverride: newHistory,
        patternsOverride: newPatterns,
        activeThreadOverride: activeThread,
        taskLedgerOverride: nextTaskLedger,
        tasksOverride: nextTasks,
      });
      if (!chosen) return;
      setAdaptedAction(chosen);
      setCandidateSet(candidates);
      setScreen("adapted");
      setSelectedFeedback(null); setResult(null); setFrictionNote("");
    } finally {
      submittingFeedbackRef.current = false;
      setLoading(false);
    }
  };

  const handleNext = () => {
    setCurrentAction(adaptedAction);
    setAdaptedAction(null);
    setScreen("action");
  };

  const buildActiveThread = (feedbackContext, action, hist, ledger = taskLedger, ctx = context) => {
    if (!feedbackContext || !action) return null;

    // Validate parent task still exists and is available
    if (action.parent_task_id) {
      const parentTask = ledger[action.parent_task_id];
      if (!parentTask || parentTask.status !== 'available' || !isContextSuitable(parentTask, ctx)) {
        return null; // parent gone or unsuitable — do not continue thread
      }
    }

    const skipCount = hist.filter(h =>
      h.action === action.action && h.feedback === "skipped"
    ).length;
    const parentProgress = getParentTaskProgress(hist, action.parent_task_id);
    return {
      parent_task_id: action.parent_task_id || null,
      parent_task_title: action.parent_task_title || null,
      parent_task_type: action.parent_task_id ? ledger[action.parent_task_id]?.task_type || null : null,
      parent_task_repeatable: action.parent_task_id ? Boolean(ledger[action.parent_task_id]?.repeatable) : false,
      last_action: action.action,
      last_why: action.why,
      last_tags: action.tags,
      latest_feedback: feedbackContext.feedback,
      latest_result: feedbackContext.result,
      latest_note: feedbackContext.note || "none",
      skip_count: skipCount,
      parent_finished_count: parentProgress.finished,
      parent_partial_count: parentProgress.partial,
      parent_progress_count: parentProgress.progress,
      closure_pressure_due: parentProgress.finished >= 2 && feedbackContext.feedback === 'done' && feedbackContext.result === 'finished',
    };
  };

  const showToast = (msg, undoFn = null) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ msg, undoFn });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 4000);
  };

  // Soft return — preserves active loop
  const handleBackToTasks = () => {
    setScreen("input");
    setSelectedFeedback(null);
    setResult(null);
    setFrictionNote("");
    setError(null);
  };

  // Resume active loop — restore exact screen state
  const handleReturnToCurrentAction = () => {
    if (adaptedAction) setScreen("adapted");
    else if (currentAction) setScreen("action");
  };

  // Intentional replacement — clears loop and calls model directly
  const handleFindNewMove = async () => {
    if (!tasks.trim()) return;
    setCurrentAction(null);
    setAdaptedAction(null);
    setCandidateSet([]);
    const { chosen, candidates } = await getAction();
    if (!chosen) return;
    setCurrentAction(chosen);
    setCandidateSet(candidates);
    setScreen("action");
  };

  const handleClearTasks = () => {
    const prev = tasks;
    const prevLedger = taskLedger;
    setTasks('');
    setTaskLedger({});
    showToast('Task list cleared', () => { setTasks(prev); setTaskLedger(prevLedger); });
  };

  const handleExport = () => {
    const data = {
      version: STORAGE_VERSION,
      exportedAt: new Date().toISOString(),
      history,
      patterns,
      tasks,
      taskLedger,
      availableMinutes,
      sessionMode: getSessionMode(availableMinutes),
      energy,
      context,
      state,
      policy_config: {
        version: 'pass_6a_progress_sensitive',
        enable_policy_learning: ENABLE_POLICY_LEARNING,
        history_windows: POLICY_HISTORY_WINDOWS,
      },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nao-profile-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.history) setHistory(data.history);
        if (data.patterns) setPatterns(data.patterns);
        if (data.tasks) setTasks(data.tasks);
        if (data.taskLedger) setTaskLedger(data.taskLedger);
        if (data.availableMinutes) setAvailableMinutes(data.availableMinutes);
        if (data.energy) setEnergy(data.energy);
        if (data.context) setContext(data.context);
        if (data.state) setState(data.state);
        saveState({
          version: STORAGE_VERSION,
          history: data.history || [],
          patterns: data.patterns || [],
          tasks: data.tasks || '',
          taskLedger: data.taskLedger || {},
          availableMinutes: data.availableMinutes || 5,
          energy: data.energy || 'medium',
          context: data.context || 'home',
          state: data.state || 'normal',
        });
        setError(null);
        showToast(`Imported ${data.history?.length || 0} loops`);
      } catch {
        setError('Import failed — invalid file format.');
      }
    };
    reader.readAsText(file);
  };

  const handleReset = () => {
    const opts = resetOptions;
    if (opts.tasks) setTasks('');
    if (opts.learning) {
      setHistory([]);
      setPatterns([]);
      setFlashScore(null);
    }
    saveState({
      tasks: opts.tasks ? '' : tasks,
      history: opts.learning ? [] : history,
      patterns: opts.learning ? [] : patterns,
      availableMinutes,
      energy,
    });
    setCurrentAction(null); setCandidateSet([]); setAdaptedAction(null);
    setSelectedFeedback(null); setResult(null); setFrictionNote('');
    setLoading(false); setShowStats(false); setError(null);
    setShowConfirmReset(false); setShowMenu(false);
    if (opts.tasks) setTaskLedger({});
    setScreen('input');
    showToast('Learning reset complete');
  };

  const lastEntry = history[history.length - 1];
  const isFirstLoop = history.length === 0;

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {flashScore !== null && <ScoreFlash score={flashScore} onDone={() => setFlashScore(null)} multiplier={lastEntry?.multiplier ?? 1} />}

      <div style={S.topbar}>
        <button style={S.ghostBtn} onClick={() => screen !== "input" && handleBackToTasks()}>
          {screen !== "input" ? "← task list" : <span style={{ color: "#8899bb" }}>NAO</span>}
        </button>
        <div style={S.topCenter}>
          {history.length > 0 && (
            <button style={S.statsPill} onClick={() => setShowStats(v => !v)}>
              <span style={{ color: stats.totalScore >= 0 ? "#4ade80" : "#f87171" }}>{stats.totalScore}</span>
              <span style={S.pillDot} />
              <span>{stats.finishRate}%</span>
              {stats.streak > 1 && <span style={{ color: "#fb923c", marginLeft: 2 }}>{stats.streak}🔥</span>}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          <button style={S.iconBtn} onClick={() => setShowGuide(true)} title="How to use">?</button>
          <button style={S.iconBtn} onClick={() => setShowMenu(true)} title="Options">⋯</button>
        </div>
      </div>

      {error && (
        <div style={S.errorBanner} className="fadein">
          <span style={S.errorText}>⚠ {error}</span>
          <button style={S.errorDismiss} onClick={() => setError(null)}>×</button>
        </div>
      )}

      {/* Bottom Sheets */}
      <GuideSheet show={showGuide} onClose={() => setShowGuide(false)} />
      <MenuSheet
        show={showMenu}
        onClose={() => setShowMenu(false)}
        onExport={handleExport}
        onImport={handleImport}
        onClearTasks={handleClearTasks}
        onResetLearning={() => { setShowMenu(false); setShowConfirmReset(true); }}
      />
      <ConfirmResetSheet
        show={showConfirmReset}
        onClose={() => setShowConfirmReset(false)}
        options={resetOptions}
        setOptions={setResetOptions}
        onConfirm={handleReset}
      />

      {/* Toast */}
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {showStats && history.length > 0 && (
        <div style={S.statsPanel} className="fadein">
          <div style={S.statsGrid}>
            {[
              { val: stats.totalScore, lbl: "score", col: stats.totalScore >= 0 ? "#4ade80" : "#f87171" },
              { val: `${stats.finishRate}%`, lbl: "finish", col: "#e8e8e8" },
              { val: `${stats.frictionRate}%`, lbl: "friction", col: "#f87171" },
              { val: stats.streak, lbl: "streak", col: "#fb923c" },
            ].map(({ val, lbl, col }) => (
              <div key={lbl} style={S.statCell}>
                <span style={{ ...S.statVal, color: col }}>{val}</span>
                <span style={S.statLbl}>{lbl}</span>
              </div>
            ))}
          </div>
          <div style={S.barTrack}>
            <div style={{ ...S.barFill, width: `${stats.finishRate}%` }} />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <Sparkline history={history} />
          </div>
          <button style={S.profileBtn} onClick={() => { setShowStats(false); setScreen("profile"); }}>
            view full profile →
          </button>
        </div>
      )}

      <div style={S.card}>
        {screen === "input" && (
          <div className="fadein">
            <p style={S.eyebrow}>{history.length > 0 ? `welcome back · ${history.length} loops` : "what needs doing?"}</p>
            <textarea
              ref={textareaRef} value={tasks} onChange={e => setTasks(e.target.value)}
              style={S.textarea}
              placeholder={"work on app\nclean kitchen\nreply to Sarah\nstart gym routine"}
              onFocus={e => e.target.style.borderColor = "#2a2a2a"}
              onBlur={e => e.target.style.borderColor = "#141414"}
            />
            <div style={S.contextBox}>
              <div>
                <p style={S.contextLabel}>mode</p>
                <div style={{ ...S.contextOptions, flexWrap: 'wrap' }}>
                  {ACTION_MODE_OPTIONS.map(o => (
                    <button
                      key={o.id}
                      title={o.hint}
                      style={{ ...S.contextBtn, borderColor: availableMinutes === o.minutes ? "#e8e8e8" : "#2a3a5c", color: availableMinutes === o.minutes ? "#e8e8e8" : "#8899bb", fontSize: 9 }}
                      onClick={() => setAvailableMinutes(o.minutes)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p style={S.contextLabel}>energy</p>
                <div style={S.contextOptions}>
                  {ENERGY_OPTIONS.map(o => (
                    <button key={o} style={{ ...S.contextBtn, borderColor: energy === o ? "#e8e8e8" : "#2a3a5c", color: energy === o ? "#e8e8e8" : "#8899bb" }} onClick={() => setEnergy(o)}>{o}</button>
                  ))}
                </div>
              </div>
            </div>

            {/* Collapsible context + state */}
            <button style={S.contextToggle} onClick={() => setShowContext(v => !v)}>
              <span>{showContext ? '▾' : '▸'} context</span>
              {!showContext && (
                <span style={S.contextSummary}>{context} · {state}</span>
              )}
            </button>

            {showContext && (
              <div style={S.contextExpandedBox} className="fadein">
                <div>
                  <p style={S.contextLabel}>context</p>
                  <div style={{ ...S.contextOptions, flexWrap: 'wrap' }}>
                    {CONTEXT_OPTIONS.map(o => (
                      <button key={o.id} style={{ ...S.contextBtn, borderColor: context === o.id ? "#38bdf8" : "#2a3a5c", color: context === o.id ? "#38bdf8" : "#8899bb" }} onClick={() => setContext(o.id)}>{o.label}</button>
                    ))}
                  </div>
                </div>
                <div style={{ marginTop: 10 }}>
                  <p style={S.contextLabel}>state</p>
                  <div style={{ ...S.contextOptions, flexWrap: 'wrap' }}>
                    {STATE_OPTIONS.map(o => (
                      <button key={o.id} style={{ ...S.contextBtn, borderColor: state === o.id ? "#c084fc" : "#2a3a5c", color: state === o.id ? "#c084fc" : "#8899bb" }} onClick={() => setState(o.id)}>{o.label}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {history.length > 0 && (
              <p style={S.returningNote}>system knows you · {stats.finishRate}% finish · {stats.totalScore} pts</p>
            )}
            {currentAction ? (
              <>
                <button style={S.btnPrimary} onClick={handleReturnToCurrentAction}>
                  return to current action →
                </button>
                <button
                  style={{ ...S.btnSecondary, opacity: tasks.trim() && !loading ? 1 : 0.6, marginTop: 8 }}
                  onClick={handleFindNewMove}
                  disabled={!tasks.trim() || loading}
                >
                  {loading ? <span className="pulse">thinking…</span> : "find new move →"}
                </button>
                <p style={{ ...S.returningNote, marginTop: 8, color: "#8899bb55" }}>
                  find new move will replace the current suggestion
                </p>
              </>
            ) : (
              <button style={{ ...S.btnPrimary, opacity: tasks.trim() && !loading ? 1 : 0.25 }} onClick={handleStart} disabled={!tasks.trim() || loading}>
                {loading ? <span className="pulse">thinking…</span> : "find my next move →"}
              </button>
            )}
          </div>
        )}

        {screen === "action" && currentAction && (
          <div className="fadein">
            <div style={S.actionHead}>
              <p style={S.eyebrow}>next action</p>
              <span style={S.confPill}>
                {isFirstLoop ? "first loop" : `${safePct(currentAction.predicted_finish_probability)}% likely`}
              </span>
            </div>
            <ActionCard action={currentAction} isFirstLoop={isFirstLoop} />
            <div style={S.selectionMeta}>
              <span>{isFirstLoop ? "exploring — building your profile" : (currentAction.selection_mode === "exploration" ? "exploring new pattern" : "exploiting what works")}</span>
              <span>·</span>
              <span>{candidateSet.length} candidate{candidateSet.length !== 1 ? "s" : ""}</span>
              {usedModel && <><span>·</span><span style={{ color: "#4ade8040" }}>{usedModel.includes("mini") || usedModel.includes("haiku") ? "fast" : "smart"}</span></>}
            </div>
            <p style={S.hintText}>go do it — then come back</p>
            <button style={S.btnSecondary} onClick={() => setScreen("feedback")}>i'm back →</button>
          </div>
        )}

        {screen === "feedback" && (
          <div className="fadein">
            <p style={S.eyebrow}>what happened?</p>
            <p style={S.prevActionText}>"{currentAction?.action}"</p>
            <div style={S.feedGrid}>
              {FEEDBACK_OPTIONS.map(f => (
                <button key={f.id} style={{
                  ...S.feedBtn,
                  borderColor: selectedFeedback === f.id ? f.accent : "#141414",
                  color: selectedFeedback === f.id ? f.accent : "#3a3a3a",
                  background: selectedFeedback === f.id ? `${f.accent}0f` : "#0a0a0a",
                }} onClick={() => setSelectedFeedback(f.id)}>
                  <span style={{ fontSize: 13 }}>{f.icon}</span>
                  <span>{f.label}</span>
                  <span style={{ marginLeft: "auto", fontSize: 9, opacity: 0.4 }}>{f.id === "done" ? "0~10" : "−1"}</span>
                </button>
              ))}
            </div>
            {selectedFeedback === "done" && (
              <div style={S.resultRow} className="fadein">
                <span style={S.resultLbl}>result?</span>
                {RESULT_OPTIONS.map(o => (
                  <button key={o.id} style={{
                    ...S.resultBtn,
                    borderColor: result === o.id ? "#e8e8e8" : "#141414",
                    color: result === o.id ? "#e8e8e8" : "#3a3a3a",
                  }} onClick={() => setResult(o.id)}>
                    {o.label}<span style={{ color: o.color, marginLeft: 5, fontSize: 9 }}>{o.pts}</span>
                  </button>
                ))}
              </div>
            )}
            <input value={frictionNote} onChange={e => setFrictionNote(e.target.value)}
              placeholder="friction note? (optional)" style={S.textInput}
              onFocus={e => e.target.style.borderColor = "#2a2a2a"}
              onBlur={e => e.target.style.borderColor = "#141414"}
            />
            <button style={{ ...S.btnPrimary, opacity: selectedFeedback && (selectedFeedback !== "done" || result) && !loading ? 1 : 0.25 }}
              onClick={handleFeedbackSubmit}
              disabled={!selectedFeedback || (selectedFeedback === "done" && !result) || loading}>
              {loading ? <span className="pulse">adapting…</span> : "close the loop →"}
            </button>
          </div>
        )}

        {screen === "adapted" && adaptedAction && (
          <div className="fadein">
            <div style={S.actionHead}>
              <p style={S.eyebrow}>{lastEntry?.feedback === "done" ? "next action" : "adapted"}</p>
              <span style={{ ...S.confPill, color: "#4ade80", borderColor: "#152515" }}>{stats.totalScore} pts total</span>
            </div>
            <ActionCard action={adaptedAction} variant="green" />
            {history.length > 0 && (
              <div style={S.trail}>
                {history.slice(-3).reverse().map((item, i) => (
                  <div key={i} style={{ ...S.trailRow, opacity: 1 - i * 0.3 }}>
                    <span style={S.trailAction}>{item.action}</span>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                      <span style={S.trailFeed}>{item.feedback}</span>
                      <span style={{ fontSize: 9, color: item.score > 0 ? "#4ade8060" : item.score < 0 ? "#f8717160" : "#333" }}>
                        {item.score > 0 ? `+${item.score}` : item.score === 0 ? "±0" : item.score}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <button style={S.btnPrimary} onClick={handleNext}>do this now →</button>
          </div>
        )}

        {screen === "profile" && (
          <ProfileScreen history={history} onClose={handleBackToTasks} taskLedger={taskLedger} />
        )}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;1,300&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1a1a2e; }
::placeholder { color: #4a5a7a; }
::selection { background: #4ade8030; }
button { cursor: pointer; font-family: inherit; }
textarea, input { font-family: inherit; }
textarea:focus, input:focus { outline: none; }
.fadein { animation: fi 0.3s ease both; }
@keyframes fi { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
.pulse { animation: pu 1.1s ease infinite; display: inline-block; }
@keyframes pu { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
.slideUp { animation: su 0.3s ease both; }
@keyframes su { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.fadeIn { animation: fi2 0.2s ease both; }
@keyframes fi2 { from { opacity: 0; transform: translateX(-50%) translateY(8px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
@keyframes scoreFloat {
  0% { opacity: 0; transform: translateX(-50%) translateY(0) scale(0.7); }
  15% { opacity: 1; transform: translateX(-50%) translateY(-12px) scale(1.15); }
  75% { opacity: 1; transform: translateX(-50%) translateY(-32px) scale(1); }
  100% { opacity: 0; transform: translateX(-50%) translateY(-52px) scale(0.9); }
}
`;

const S = {
  root: { minHeight: "100vh", background: "#1a1a2e", display: "flex", flexDirection: "column", alignItems: "center", fontFamily: "'JetBrains Mono', monospace", padding: "0 18px 64px", color: "#e8e8e8" },
  scoreFlash: { position: "fixed", top: "38%", left: "50%", transform: "translateX(-50%)", fontSize: 44, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", animation: "scoreFloat 1.2s ease forwards", pointerEvents: "none", zIndex: 999, letterSpacing: "-0.02em" },
  topbar: { width: "100%", maxWidth: 480, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 0 12px" },
  topCenter: { display: "flex", alignItems: "center" },
  ghostBtn: { background: "none", border: "none", color: "#8899bb", fontSize: 11, letterSpacing: "0.12em", minWidth: 52 },
  statsPill: { background: "none", border: "1px solid #2a3a5c", borderRadius: 20, padding: "5px 12px", fontSize: 10, display: "flex", alignItems: "center", gap: 6, color: "#bbc8dd", letterSpacing: "0.04em" },
  pillDot: { width: 3, height: 3, borderRadius: "50%", background: "#2a2a2a" },
  errorBanner: { width: "100%", maxWidth: 480, background: "#2a1a1a", border: "1px solid #5a2a2a", borderRadius: 8, padding: "10px 14px", marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" },
  errorText: { fontSize: 11, color: "#f87171", letterSpacing: "0.02em", flex: 1, overflow: "hidden", textOverflow: "ellipsis" },
  errorDismiss: { background: "none", border: "none", color: "#f87171", fontSize: 18, opacity: 0.6, marginLeft: 10 },
  statsPanel: { width: "100%", maxWidth: 480, background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 10, padding: "18px 20px", marginBottom: 10 },
  statsGrid: { display: "flex", justifyContent: "space-between", marginBottom: 14 },
  statCell: { display: "flex", flexDirection: "column", alignItems: "center", gap: 4 },
  statVal: { fontSize: 20, fontWeight: 500 },
  statLbl: { fontSize: 9, color: "#8899bb", letterSpacing: "0.12em" },
  barTrack: { height: 2, background: "#2a3a5c", borderRadius: 2, overflow: "hidden" },
  barFill: { height: "100%", background: "linear-gradient(90deg, #2a6a2a, #4ade80)", borderRadius: 2, transition: "width 0.7s ease" },
  profileBtn: { marginTop: 14, width: "100%", padding: "10px", background: "#16213e", color: "#bbc8dd", border: "1px solid #2a3a5c", borderRadius: 8, fontSize: 10, letterSpacing: "0.12em" },
  card: { width: "100%", maxWidth: 480, paddingTop: 8 },
  eyebrow: { fontSize: 10, color: "#8899bb", letterSpacing: "0.3em", textTransform: "uppercase", marginBottom: 16 },
  textarea: { width: "100%", minHeight: 164, background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 8, color: "#ccd5e8", fontSize: 16, lineHeight: 2, padding: "16px 18px", resize: "none", transition: "border-color 0.2s", marginBottom: 10 },
  contextBox: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 },
  contextLabel: { fontSize: 9, color: "#8899bb", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 7 },
  contextOptions: { display: "flex", gap: 6 },
  contextBtn: { padding: "7px 9px", background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 6, fontSize: 10 },
  returningNote: { fontSize: 10, color: "#8899bb", marginBottom: 14, letterSpacing: "0.04em" },
  btnPrimary: { width: "100%", padding: "15px", background: "#e8e8e8", color: "#1a1a2e", border: "none", borderRadius: 8, fontSize: 12, letterSpacing: "0.18em", transition: "opacity 0.2s", marginTop: 8 },
  btnSecondary: { width: "100%", padding: "15px", background: "#16213e", color: "#bbc8dd", border: "1px solid #2a3a5c", borderRadius: 8, fontSize: 12, letterSpacing: "0.18em", marginTop: 8 },
  actionHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  actionCard: { background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 10, padding: "28px", marginBottom: 14 },
  actionText: { fontSize: 20, lineHeight: 1.5, color: "#e8e8e8", fontWeight: 400, marginBottom: 18 },
  whyText: { fontSize: 11, color: "#8899bb", lineHeight: 1.65, marginBottom: 16 },
  actionFooter: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  timePill: { display: "inline-block", fontSize: 10, color: "#8899bb", background: "#1e2a45", border: "1px solid #2a3a5c", borderRadius: 20, padding: "4px 10px" },
  confPill: { fontSize: 9, color: "#4ade80", background: "#0f2318", border: "1px solid #1a4a2a", borderRadius: 20, padding: "4px 10px", letterSpacing: "0.08em" },
  potentialPts: { fontSize: 10, color: "#8899bb" },
  tagRow: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 14 },
  tagChip: { fontSize: 9, color: "#aabbcc", background: "#1e2a45", border: "1px solid #2a3a5c", borderRadius: 4, padding: "2px 7px", letterSpacing: "0.05em" },
  selectionReason: { marginTop: 10, fontSize: 10, lineHeight: 1.5 },
  selectionMeta: { display: "flex", gap: 6, fontSize: 10, color: "#8899bb", marginBottom: 8 },
  hintText: { fontSize: 10, color: "#8899bb", textAlign: "center", letterSpacing: "0.1em", margin: "10px 0 4px" },
  prevActionText: { fontSize: 11, color: "#8899bb", marginBottom: 20, lineHeight: 1.55, fontStyle: "italic" },
  feedGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7, marginBottom: 12 },
  feedBtn: { padding: "13px 14px", background: "#1e2a45", border: "1px solid #2a3a5c", borderRadius: 8, fontSize: 11, display: "flex", alignItems: "center", gap: 8, textAlign: "left", transition: "all 0.15s" },
  resultRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" },
  resultLbl: { fontSize: 10, color: "#8899bb", letterSpacing: "0.15em" },
  resultBtn: { padding: "8px 12px", background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 6, fontSize: 11, display: "flex", alignItems: "center", transition: "all 0.15s" },
  textInput: { width: "100%", padding: "13px 16px", background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 8, color: "#bbc8dd", fontSize: 16, marginBottom: 4, transition: "border-color 0.2s" },
  trail: { borderTop: "1px solid #2a3a5c", paddingTop: 12, marginTop: 4, marginBottom: 16 },
  trailRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #2a3a5c" },
  trailAction: { fontSize: 10, color: "#8899bb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "68%" },
  trailFeed: { fontSize: 9, color: "#8899bb", letterSpacing: "0.08em" },
  profileHeader: { marginBottom: 20 },
  profileSubtle: { fontSize: 11, color: "#8899bb", letterSpacing: "0.05em" },
  profileSection: { marginBottom: 24 },
  profileSectionTitle: { fontSize: 9, color: "#aabbcc", letterSpacing: "0.25em", textTransform: "uppercase", marginBottom: 12 },
  insightCard: { background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 8, padding: "14px 16px", marginBottom: 8 },
  insightDim: { fontSize: 9, color: "#8899bb", letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 10 },
  insightRow: { display: "flex", flexDirection: "column", gap: 6 },
  insightWin: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 },
  insightLose: { display: "flex", alignItems: "center", gap: 10, fontSize: 12 },
  insightWinDot: { color: "#4ade80", fontSize: 8 },
  insightLoseDot: { color: "#f87171", fontSize: 8 },
  insightVal: { color: "#d4ddef", flex: 1 },
  insightRate: { color: "#ccd5e8", fontSize: 11, fontWeight: 500 },
  insightCount: { color: "#8899bb", fontSize: 9 },
  energyRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 8 },
  energyLabel: { fontSize: 11, color: "#ccd5e8", width: 100 },
  energyBarTrack: { flex: 1, height: 4, background: "#2a3a5c", borderRadius: 2, overflow: "hidden" },
  energyBarFill: { height: "100%", background: "linear-gradient(90deg, #2a6a2a, #4ade80)", borderRadius: 2 },
  energyRate: { fontSize: 10, color: "#d4ddef", width: 40, textAlign: "right" },
  profileEmpty: { background: "#16213e", border: "1px solid #2a3a5c", borderRadius: 8, padding: "32px 20px", textAlign: "center", marginBottom: 16 },
  profileEmptyText: { fontSize: 12, color: "#bbc8dd", lineHeight: 1.6 },
  chipsRow: { display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 12 },
  contextToggle: { width: "100%", background: "none", border: "1px solid #1e2e4e", borderRadius: 6, padding: "8px 12px", color: "#8899bb", fontSize: 11, textAlign: "left", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, fontFamily: "inherit", letterSpacing: "0.05em" },
  contextSummary: { fontSize: 10, color: "#2a3a5c", letterSpacing: "0.1em" },
  contextExpandedBox: { background: "#0f1929", border: "1px solid #1e2e4e", borderRadius: 8, padding: "12px 14px", marginBottom: 8 },
  iconBtn: { background: "none", border: "1px solid #2a3a5c", borderRadius: 20, color: "#8899bb", fontSize: 13, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontFamily: "inherit" },
};
