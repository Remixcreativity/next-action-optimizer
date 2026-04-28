import { useState, useRef, useEffect, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const STORAGE_KEY = "nao_v13";
const EXPLORE_RATE = 0.15;
const MIN_ATTEMPTS_FOR_TRUST = 5;
const MIN_ATTEMPTS_FOR_DISPLAY = 3;

const SCORE_MAP = {
  done_finished: 10, done_partial: 5, done_none: 0, skipped: 0,
  too_big: -1, too_vague: -1, no_time: -1, no_motivation: -1,
};

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
  { id: "none", label: "Nothing", pts: "+0", color: "#bbc8dd" },
  { id: "partial", label: "Partial", pts: "+5", color: "#fb923c" },
  { id: "finished", label: "Finished", pts: "+10", color: "#4ade80" },
];

const ENERGY_OPTIONS = ["low", "medium", "high"];
const TIME_OPTIONS = [2, 5, 10];

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
  const totalScore = history.reduce((s, h) => s + (h.score ?? 0), 0);
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
      stats[tagKey].totalScore += entry.score ?? 0;
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

const chooseCandidate = (candidates, history) => {
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
    };
  });

  const shouldExplore = Math.random() < EXPLORE_RATE && scored.length > 1;
  if (shouldExplore) {
    const idx = Math.floor(Math.random() * scored.length);
    return { ...scored[idx], selection_mode: "exploration" };
  }
  return {
    ...scored.sort((a, b) => b.predicted_finish_probability - a.predicted_finish_probability || b.evidence_score - a.evidence_score)[0],
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
const ScoreFlash = ({ score, onDone }) => {
  useEffect(() => { const t = setTimeout(onDone, 1200); return () => clearTimeout(t); }, [onDone]);
  const color = score > 0 ? "#4ade80" : score < 0 ? "#f87171" : "#555";
  return <div style={{ ...S.scoreFlash, color }}>{score > 0 ? `+${score}` : score === 0 ? "±0" : score}</div>;
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

const ProfileScreen = ({ history, onClose }) => {
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

    <p style={GS.section}>What is this?</p>
    <p style={GS.body}>One next action. The system learns what makes you finish.</p>

    <p style={GS.section}>How to use</p>
    <div style={GS.body}>
      <p>1. Dump your tasks</p>
      <p>2. Set time + energy honestly</p>
      <p>3. Do the action — exactly as suggested</p>
      <p>4. Give honest feedback</p>
    </div>

    <p style={GS.section}>Prefixes <span style={{ color: '#8899bb', fontSize: 9, letterSpacing: '0.1em' }}>(coming soon)</span></p>
    <div style={GS.codeBlock}>
      <p style={GS.code}><span style={GS.prefix}>#</span> fitness &nbsp;&nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ ongoing area</span></p>
      <p style={GS.code}><span style={GS.prefix}>-</span> call dentist &nbsp;<span style={GS.dim}>→ one-off task</span></p>
      <p style={GS.code}><span style={GS.prefix}>!</span> pay invoice &nbsp;&nbsp;<span style={GS.dim}>→ urgent</span></p>
      <p style={GS.code}><span style={GS.prefix}>*</span> build app &nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ important</span></p>
    </div>

    <p style={GS.section}>Feedback signals</p>
    <div style={GS.codeBlock}>
      <p style={GS.code}><span style={{ color: '#4ade80' }}>✓</span> Done + Finished &nbsp;&nbsp;<span style={GS.dim}>→ result achieved</span></p>
      <p style={GS.code}><span style={{ color: '#4ade80' }}>✓</span> Done + Partial &nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ some progress</span></p>
      <p style={GS.code}><span style={{ color: '#fb923c' }}>▣</span> Too big &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ shrink it</span></p>
      <p style={GS.code}><span style={{ color: '#c084fc' }}>◌</span> Too vague &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ add specifics</span></p>
      <p style={GS.code}><span style={{ color: '#38bdf8' }}>◷</span> No time &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ compress to 2m</span></p>
      <p style={GS.code}><span style={{ color: '#f472b6' }}>◉</span> No motivation &nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ visible result</span></p>
      <p style={GS.code}><span style={{ color: '#f87171' }}>✕</span> Skipped &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<span style={GS.dim}>→ switch task</span></p>
    </div>

    <p style={GS.section}>One rule</p>
    <p style={GS.body}>Do exactly what's suggested first. More is always optional.</p>
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
  const [error, setError] = useState(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showConfirmReset, setShowConfirmReset] = useState(false);
  const [resetOptions, setResetOptions] = useState({ tasks: false, learning: true });
  const [toast, setToast] = useState(null);
  const [usedModel, setUsedModel] = useState(null);
  const textareaRef = useRef(null);
  const toastTimerRef = useRef(null);

  useEffect(() => {
    const saved = loadState();
    if (saved) {
      if (saved.tasks) setTasks(saved.tasks);
      if (saved.history) setHistory(saved.history);
      if (saved.patterns) setPatterns(saved.patterns);
      if (saved.availableMinutes) setAvailableMinutes(saved.availableMinutes);
      if (saved.energy) setEnergy(saved.energy);
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveState({ tasks, history, patterns, availableMinutes, energy });
  }, [tasks, history, patterns, availableMinutes, energy, hydrated]);

  useEffect(() => {
    if (screen === "input" && textareaRef.current) textareaRef.current.focus();
  }, [screen]);

  const stats = calcStats(history);

  const getAction = useCallback(async ({
    feedbackContext = null,
    historyOverride = history,
    patternsOverride = patterns,
    activeThreadOverride = null,
  } = {}) => {
    setLoading(true);
    setError(null);
    try {
      // App.jsx sends raw context only — server owns behavioral prompting
      const response = await fetch("/api/next-action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tasks,
          history: historyOverride,
          feedbackContext,
          availableMinutes,
          energy,
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

      const chosen = chooseCandidate(parsed.candidates, historyOverride);
      return { chosen, candidates: parsed.candidates };
    } catch (e) {
      console.error("getAction error:", e);
      setError(e.message || "Something went wrong");
      return { chosen: null, candidates: [] };
    } finally {
      setLoading(false);
    }
  }, [tasks, history, patterns, availableMinutes, energy]);

  const handleStart = async () => {
    if (!tasks.trim()) return;
    const { chosen, candidates } = await getAction();
    if (!chosen) return;
    setCurrentAction(chosen);
    setCandidateSet(candidates);
    setScreen("action");
  };

  const handleFeedbackSubmit = async () => {
    if (!selectedFeedback || !currentAction) return;
    const finalResult = selectedFeedback === "done" ? (result || "none") : "none";
    const score = getScore(selectedFeedback, finalResult);
    const feedbackContext = { feedback: selectedFeedback, result: finalResult, note: frictionNote };
    const ctx = getContext();
    const newEntry = {
      action: currentAction.action, why: currentAction.why,
      feedback: selectedFeedback, result: finalResult, score,
      tags: currentAction.tags, estimated_minutes: currentAction.estimated_minutes,
      predicted_finish_probability: currentAction.predicted_finish_probability ?? 0.5,
      selection_mode: currentAction.selection_mode || "unknown",
      available_minutes: availableMinutes, energy,
      hour: ctx.hour, day_of_week: ctx.day_of_week,
      note: frictionNote, ts: Date.now(),
    };
    const newHistory = [...history, newEntry];
    const newPatterns = PATTERN_MAP[selectedFeedback]
      ? [...new Set([...patterns, PATTERN_MAP[selectedFeedback]])]
      : patterns;
    setHistory(newHistory);
    setPatterns(newPatterns);
    setFlashScore(score);
    // Build activeThread from newHistory so skip_count is accurate
    const activeThread = buildActiveThread(feedbackContext, currentAction, newHistory);
    const { chosen, candidates } = await getAction({
      feedbackContext,
      historyOverride: newHistory,
      patternsOverride: newPatterns,
      activeThreadOverride: activeThread,
    });
    if (!chosen) return;
    setAdaptedAction(chosen);
    setCandidateSet(candidates);
    setScreen("adapted");
    setSelectedFeedback(null); setResult(null); setFrictionNote("");
  };

  const handleNext = () => {
    setCurrentAction(adaptedAction);
    setAdaptedAction(null);
    setScreen("action");
  };

  const buildActiveThread = (feedbackContext, action, hist) => {
    if (!feedbackContext || !action) return null;
    const skipCount = hist.filter(h =>
      h.action === action.action && h.feedback === "skipped"
    ).length;
    return {
      last_action: action.action,
      last_why: action.why,
      last_tags: action.tags,
      latest_feedback: feedbackContext.feedback,
      latest_result: feedbackContext.result,
      latest_note: feedbackContext.note || "none",
      skip_count: skipCount,
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
    setTasks('');
    showToast('Task list cleared', () => setTasks(prev));
  };

  const handleExport = () => {
    const data = {
      version: 1,
      exportedAt: new Date().toISOString(),
      history,
      patterns,
      tasks,
      availableMinutes,
      energy,
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
        if (data.availableMinutes) setAvailableMinutes(data.availableMinutes);
        if (data.energy) setEnergy(data.energy);
        saveState({
          history: data.history || [],
          patterns: data.patterns || [],
          tasks: data.tasks || '',
          availableMinutes: data.availableMinutes || 5,
          energy: data.energy || 'medium',
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
    setScreen('input');
    showToast('Learning reset complete');
  };

  const lastEntry = history[history.length - 1];
  const isFirstLoop = history.length === 0;

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {flashScore !== null && <ScoreFlash score={flashScore} onDone={() => setFlashScore(null)} />}

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
                <p style={S.contextLabel}>time</p>
                <div style={S.contextOptions}>
                  {TIME_OPTIONS.map(t => (
                    <button key={t} style={{ ...S.contextBtn, borderColor: availableMinutes === t ? "#e8e8e8" : "#141414", color: availableMinutes === t ? "#e8e8e8" : "#333" }} onClick={() => setAvailableMinutes(t)}>{t}m</button>
                  ))}
                </div>
              </div>
              <div>
                <p style={S.contextLabel}>energy</p>
                <div style={S.contextOptions}>
                  {ENERGY_OPTIONS.map(o => (
                    <button key={o} style={{ ...S.contextBtn, borderColor: energy === o ? "#e8e8e8" : "#141414", color: energy === o ? "#e8e8e8" : "#333" }} onClick={() => setEnergy(o)}>{o}</button>
                  ))}
                </div>
              </div>
            </div>
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
          <ProfileScreen history={history} onClose={handleBackToTasks} />
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
  iconBtn: { background: "none", border: "1px solid #2a3a5c", borderRadius: 20, color: "#8899bb", fontSize: 13, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontFamily: "inherit" },
};
