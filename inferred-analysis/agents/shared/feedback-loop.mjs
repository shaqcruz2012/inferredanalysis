/**
 * Feedback Loop — Learns from past experiment results to guide mutation selection.
 *
 * Reads results.tsv, analyzes which mutation types and parameter ranges produced
 * the best outcomes, and provides weighted recommendations for future experiments.
 *
 * As more experiments accumulate, the mutation selection becomes increasingly
 * biased toward strategies and parameter ranges that have historically improved
 * Sharpe/Sortino ratios.
 *
 * Exports:
 *   - loadFeedback(resultsPath)          — parse results.tsv into structured history
 *   - getRecommendedMutation(strategyName, mutations, feedback)
 *   - getParameterHints(strategyName, mutationName, feedback)
 *   - recordLineage(parentExperiment, childMutation, feedback)
 */

import { readFileSync, existsSync } from "fs";

// ─── TSV Parsing ──────────────────────────────────────────

/**
 * The agent-runner writes rows with this layout:
 *   timestamp  agent  experiment  sharpe  sortino  calmar  total_return  max_drawdown  win_rate  trades  status
 *
 * The loop.js header uses a different schema. We detect by inspecting the first
 * field of each data row — if it looks like an ISO timestamp, it's the agent-runner
 * format. Otherwise fall back to loop.js format.
 */

const AGENT_RUNNER_FIELDS = [
  "timestamp", "agent", "experiment", "sharpe", "sortino",
  "calmar", "total_return", "max_drawdown", "win_rate", "trades", "status",
];

function parseRow(fields) {
  // Agent-runner format: first field is an ISO timestamp
  if (fields.length >= 11 && /^\d{4}-\d{2}-\d{2}T/.test(fields[0])) {
    const obj = {};
    AGENT_RUNNER_FIELDS.forEach((key, i) => {
      obj[key] = fields[i] ?? "";
    });
    // Coerce numerics
    for (const k of ["sharpe", "sortino", "calmar", "total_return", "max_drawdown", "win_rate"]) {
      obj[k] = parseFloat(obj[k]);
      if (isNaN(obj[k])) obj[k] = null;
    }
    obj.trades = parseInt(obj.trades) || 0;
    return obj;
  }
  return null; // unrecognised row
}

// ─── Core Data Loading ──────────────────────────────────────

/**
 * Load and parse results.tsv into a structured feedback object.
 *
 * @param {string} resultsPath - absolute path to results.tsv
 * @returns {FeedbackData}
 */
export function loadFeedback(resultsPath) {
  const feedback = {
    experiments: [],           // all parsed rows
    byAgent: {},               // agent -> [rows]
    byMutation: {},            // mutation_name -> [rows]
    byAgentMutation: {},       // "agent::mutation" -> [rows]
    mutationStats: {},         // mutation_name -> { keeps, discards, crashes, avgSharpe, bestSharpe, ... }
    agentMutationStats: {},    // "agent::mutation" -> stats
    parameterHistory: {},      // mutation_name -> [{ sharpe, config_proxy }]  (config approximated from trades/metrics)
    totalExperiments: 0,
  };

  if (!existsSync(resultsPath)) return feedback;

  const raw = readFileSync(resultsPath, "utf-8").trim();
  if (!raw) return feedback;

  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split("\t");
    const row = parseRow(fields);
    if (!row) continue; // skip header or unrecognised rows
    if (row.status === "baseline") continue; // baselines aren't mutations

    feedback.experiments.push(row);

    // Index by agent
    const agent = row.agent;
    if (!feedback.byAgent[agent]) feedback.byAgent[agent] = [];
    feedback.byAgent[agent].push(row);

    // Index by mutation name
    const mut = row.experiment;
    if (!feedback.byMutation[mut]) feedback.byMutation[mut] = [];
    feedback.byMutation[mut].push(row);

    // Index by agent+mutation
    const key = `${agent}::${mut}`;
    if (!feedback.byAgentMutation[key]) feedback.byAgentMutation[key] = [];
    feedback.byAgentMutation[key].push(row);
  }

  feedback.totalExperiments = feedback.experiments.length;

  // Compute aggregate statistics
  computeMutationStats(feedback);

  return feedback;
}

// ─── Statistics Computation ─────────────────────────────────

function computeStatsForGroup(rows) {
  const keeps = rows.filter(r => r.status === "keep");
  const discards = rows.filter(r => r.status === "discard");
  const crashes = rows.filter(r => r.status === "crash");
  const total = rows.length;

  const validSharpes = rows
    .filter(r => r.sharpe !== null && isFinite(r.sharpe) && r.status !== "crash")
    .map(r => r.sharpe);

  const validSortinos = rows
    .filter(r => r.sortino !== null && isFinite(r.sortino) && r.status !== "crash")
    .map(r => r.sortino);

  const avgSharpe = validSharpes.length > 0
    ? validSharpes.reduce((a, b) => a + b, 0) / validSharpes.length
    : -Infinity;

  const bestSharpe = validSharpes.length > 0
    ? Math.max(...validSharpes)
    : -Infinity;

  const avgSortino = validSortinos.length > 0
    ? validSortinos.reduce((a, b) => a + b, 0) / validSortinos.length
    : -Infinity;

  const bestSortino = validSortinos.length > 0
    ? Math.max(...validSortinos)
    : -Infinity;

  const keepRate = total > 0 ? keeps.length / total : 0;

  // Improvement score: combines keep rate with quality of kept results
  // Higher is better. This is the primary signal for mutation selection.
  const keptSharpes = keeps
    .filter(r => r.sharpe !== null && isFinite(r.sharpe))
    .map(r => r.sharpe);

  const avgKeptSharpe = keptSharpes.length > 0
    ? keptSharpes.reduce((a, b) => a + b, 0) / keptSharpes.length
    : -Infinity;

  return {
    total,
    keeps: keeps.length,
    discards: discards.length,
    crashes: crashes.length,
    keepRate,
    avgSharpe,
    bestSharpe,
    avgSortino,
    bestSortino,
    avgKeptSharpe,
    // Parameter proxies from the kept experiments
    keptTradesRange: keeps.length > 0
      ? [Math.min(...keeps.map(r => r.trades)), Math.max(...keeps.map(r => r.trades))]
      : null,
    keptWinRates: keeps.length > 0
      ? keeps.filter(r => r.win_rate !== null).map(r => r.win_rate)
      : [],
  };
}

function computeMutationStats(feedback) {
  // Global mutation stats
  for (const [mutName, rows] of Object.entries(feedback.byMutation)) {
    feedback.mutationStats[mutName] = computeStatsForGroup(rows);
  }

  // Per-agent mutation stats
  for (const [key, rows] of Object.entries(feedback.byAgentMutation)) {
    feedback.agentMutationStats[key] = computeStatsForGroup(rows);
  }
}

// ─── Mutation Recommendation ────────────────────────────────

/**
 * Select a mutation using weighted random sampling biased by historical performance.
 *
 * Scoring for each mutation:
 *   score = (keepRate * 0.4) + (normalizedAvgKeptSharpe * 0.4) + (explorationBonus * 0.2)
 *
 * Exploration bonus ensures under-tested mutations still get sampled.
 * With zero history, falls back to uniform random.
 *
 * @param {string} agentName - the agent role (e.g. "alpha_researcher")
 * @param {Array} mutations - the MUTATIONS array from agent-runner
 * @param {FeedbackData} feedback - output of loadFeedback()
 * @returns {{ mutation: object, score: number, reason: string }}
 */
export function getRecommendedMutation(agentName, mutations, feedback) {
  if (!feedback || feedback.totalExperiments === 0) {
    const idx = Math.floor(Math.random() * mutations.length);
    return {
      mutation: mutations[idx],
      score: 0,
      reason: "no_history",
      weights: null,
    };
  }

  const scores = mutations.map(m => {
    const mutName = m.name;

    // Prefer agent-specific stats, fall back to global
    const agentKey = `${agentName}::${mutName}`;
    const agentStats = feedback.agentMutationStats[agentKey];
    const globalStats = feedback.mutationStats[mutName];

    // Blend agent-specific and global stats (agent-specific weighted more heavily)
    const stats = blendStats(agentStats, globalStats);

    if (!stats) {
      // Never tried this mutation for this agent — high exploration bonus
      return { mutation: m, score: 0.8, reason: "untested_mutation" };
    }

    // Keep rate component [0, 1]
    const keepRateScore = stats.keepRate;

    // Sharpe quality component — normalize avgKeptSharpe to [0, 1]
    // Most sharpes in the data are negative, so we shift the range.
    // Map [-5, 1] -> [0, 1] with clamping
    const sharpeClamped = Math.max(-5, Math.min(1, stats.avgKeptSharpe));
    const sharpeNorm = (sharpeClamped + 5) / 6;

    // Exploration bonus: inversely proportional to number of trials
    // Decays as 1 / sqrt(n+1) so under-tested mutations get explored
    const explorationBonus = 1 / Math.sqrt(stats.total + 1);

    // Recency bonus: if the most recent trial was a keep, slight boost
    const recencyBonus = getRecencyBonus(agentName, mutName, feedback);

    const score =
      keepRateScore * 0.30 +
      sharpeNorm * 0.35 +
      explorationBonus * 0.20 +
      recencyBonus * 0.15;

    const reason = `keepRate=${keepRateScore.toFixed(2)}, sharpeNorm=${sharpeNorm.toFixed(2)}, ` +
      `exploration=${explorationBonus.toFixed(2)}, recency=${recencyBonus.toFixed(2)}, ` +
      `trials=${stats.total}`;

    return { mutation: m, score, reason };
  });

  // Weighted random selection using softmax-like transformation
  // Temperature controls exploration vs exploitation
  const temperature = computeTemperature(feedback.totalExperiments);
  const selected = weightedRandomSelect(scores, temperature);

  return {
    mutation: selected.mutation,
    score: selected.score,
    reason: selected.reason,
    weights: scores.map(s => ({
      name: s.mutation.name,
      score: parseFloat(s.score.toFixed(4)),
      reason: s.reason,
    })),
    temperature,
  };
}

function blendStats(agentStats, globalStats) {
  if (!agentStats && !globalStats) return null;
  if (!agentStats) return globalStats;
  if (!globalStats) return agentStats;

  // Weighted blend: 70% agent-specific, 30% global
  const aW = 0.7;
  const gW = 0.3;

  return {
    total: agentStats.total + globalStats.total,
    keeps: agentStats.keeps + globalStats.keeps,
    discards: agentStats.discards + globalStats.discards,
    crashes: agentStats.crashes + globalStats.crashes,
    keepRate: agentStats.keepRate * aW + globalStats.keepRate * gW,
    avgSharpe: safeMix(agentStats.avgSharpe, globalStats.avgSharpe, aW, gW),
    bestSharpe: Math.max(agentStats.bestSharpe, globalStats.bestSharpe),
    avgSortino: safeMix(agentStats.avgSortino, globalStats.avgSortino, aW, gW),
    bestSortino: Math.max(agentStats.bestSortino, globalStats.bestSortino),
    avgKeptSharpe: safeMix(agentStats.avgKeptSharpe, globalStats.avgKeptSharpe, aW, gW),
    keptTradesRange: mergeRanges(agentStats.keptTradesRange, globalStats.keptTradesRange),
    keptWinRates: [...agentStats.keptWinRates, ...globalStats.keptWinRates],
  };
}

function safeMix(a, b, wA, wB) {
  const aValid = a !== null && a !== undefined && isFinite(a);
  const bValid = b !== null && b !== undefined && isFinite(b);
  if (aValid && bValid) return a * wA + b * wB;
  if (aValid) return a;
  if (bValid) return b;
  return -Infinity;
}

function mergeRanges(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1])];
}

function getRecencyBonus(agentName, mutName, feedback) {
  const key = `${agentName}::${mutName}`;
  const rows = feedback.byAgentMutation[key];
  if (!rows || rows.length === 0) return 0.5; // neutral for untested

  // Look at the last 3 trials
  const recent = rows.slice(-3);
  const recentKeeps = recent.filter(r => r.status === "keep").length;
  return recentKeeps / recent.length;
}

/**
 * Adaptive temperature: starts high (explore), decreases as data accumulates.
 * At 0 experiments: T=2.0 (nearly uniform)
 * At 50 experiments: T=1.0 (moderate bias)
 * At 200+ experiments: T=0.5 (strong bias toward winners)
 */
function computeTemperature(totalExperiments) {
  return Math.max(0.5, 2.0 - totalExperiments * 0.01);
}

function weightedRandomSelect(scored, temperature) {
  // Softmax with temperature
  const maxScore = Math.max(...scored.map(s => s.score));
  const exps = scored.map(s => Math.exp((s.score - maxScore) / temperature));
  const sumExp = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map(e => e / sumExp);

  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < probs.length; i++) {
    cumulative += probs[i];
    if (r <= cumulative) return scored[i];
  }
  return scored[scored.length - 1];
}

// ─── Parameter Hints ────────────────────────────────────────

/**
 * Suggest parameter ranges based on what worked in prior kept experiments.
 *
 * For each mutation type we track proxy signals:
 *   - trades count (proxy for lookback period — fewer trades = longer lookback)
 *   - win_rate (proxy for threshold calibration)
 *   - max_drawdown (proxy for risk parameters)
 *
 * Returns suggested adjustments the caller can apply when generating params.
 *
 * @param {string} agentName
 * @param {string} mutationName
 * @param {FeedbackData} feedback
 * @returns {ParameterHints}
 */
export function getParameterHints(agentName, mutationName, feedback) {
  const hints = {
    hasData: false,
    suggestedLookbackBias: 0,     // [-1, 1]: negative = shorter, positive = longer
    suggestedThresholdBias: 0,    // [-1, 1]: negative = tighter, positive = wider
    tradesRange: null,            // [min, max] of kept experiments
    winRateTarget: null,          // average win rate of kept experiments
    confidence: 0,                // [0, 1] how much data backs these hints
  };

  if (!feedback || feedback.totalExperiments === 0) return hints;

  // Gather kept experiments for this mutation
  const agentKey = `${agentName}::${mutationName}`;
  const agentRows = (feedback.byAgentMutation[agentKey] || []).filter(r => r.status === "keep");
  const globalRows = (feedback.byMutation[mutationName] || []).filter(r => r.status === "keep");

  // Combine with agent-specific priority
  const keptRows = agentRows.length >= 2 ? agentRows : [...agentRows, ...globalRows];

  if (keptRows.length === 0) return hints;

  hints.hasData = true;
  hints.confidence = Math.min(1, keptRows.length / 10); // saturates at 10 kept experiments

  // Trades as lookback proxy
  const trades = keptRows.map(r => r.trades).filter(t => t > 0);
  if (trades.length > 0) {
    const avgTrades = trades.reduce((a, b) => a + b, 0) / trades.length;
    hints.tradesRange = [Math.min(...trades), Math.max(...trades)];

    // Compare with all experiments (not just kept) for this mutation
    const allRows = feedback.byMutation[mutationName] || [];
    const allTrades = allRows.map(r => r.trades).filter(t => t > 0);
    const globalAvgTrades = allTrades.length > 0
      ? allTrades.reduce((a, b) => a + b, 0) / allTrades.length
      : avgTrades;

    // If kept experiments have fewer trades than average, bias toward longer lookback
    if (globalAvgTrades > 0) {
      hints.suggestedLookbackBias = Math.max(-1, Math.min(1,
        (globalAvgTrades - avgTrades) / globalAvgTrades
      ));
    }
  }

  // Win rate target
  const winRates = keptRows.map(r => r.win_rate).filter(w => w !== null && isFinite(w));
  if (winRates.length > 0) {
    hints.winRateTarget = winRates.reduce((a, b) => a + b, 0) / winRates.length;
  }

  // Threshold bias from max_drawdown patterns
  const drawdowns = keptRows
    .map(r => r.max_drawdown)
    .filter(d => d !== null && isFinite(d));

  if (drawdowns.length > 0) {
    const avgDrawdown = drawdowns.reduce((a, b) => a + b, 0) / drawdowns.length;
    // Lower drawdown in kept experiments -> bias toward tighter thresholds
    hints.suggestedThresholdBias = Math.max(-1, Math.min(1, avgDrawdown));
  }

  return hints;
}

// ─── Lineage Tracking ───────────────────────────────────────

/**
 * Build a lineage record connecting a child experiment to its parent.
 *
 * @param {string} agentName
 * @param {string} parentMutation - the mutation that was "current best" before this experiment
 * @param {string} childMutation - the new mutation being tried
 * @param {number} parentSharpe - Sharpe of the parent/baseline
 * @param {object} recommendationInfo - the output from getRecommendedMutation
 * @returns {LineageRecord}
 */
export function buildLineageRecord(agentName, parentMutation, childMutation, parentSharpe, recommendationInfo) {
  return {
    agent: agentName,
    parent: parentMutation,
    child: childMutation,
    parentSharpe: parentSharpe,
    selectedScore: recommendationInfo?.score ?? null,
    reason: recommendationInfo?.reason ?? "unknown",
    temperature: recommendationInfo?.temperature ?? null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Format lineage info for logging.
 */
export function formatLineageLog(lineage) {
  const parts = [
    `  Lineage: ${lineage.parent || "baseline"} -> ${lineage.child}`,
    `  Parent Sharpe: ${lineage.parentSharpe?.toFixed(4) ?? "N/A"}`,
    `  Selection score: ${lineage.selectedScore?.toFixed(4) ?? "N/A"}`,
    `  Reason: ${lineage.reason}`,
    `  Temperature: ${lineage.temperature?.toFixed(3) ?? "N/A"}`,
  ];
  return parts.join("\n");
}

// ─── Parameter Adjustment Helpers ───────────────────────────

/**
 * Apply parameter hints to bias random parameter generation.
 *
 * Given a base range [min, max] and a bias in [-1, 1], shift the midpoint
 * of the random sampling window. A bias of 0 means no change. Positive bias
 * shifts toward higher values, negative toward lower.
 *
 * @param {number} min - original minimum
 * @param {number} max - original maximum
 * @param {number} bias - [-1, 1] direction to shift
 * @param {number} confidence - [0, 1] how strongly to apply the bias
 * @returns {number} biased random value in [min, max]
 */
export function biasedRandom(min, max, bias, confidence) {
  const range = max - min;
  const mid = (min + max) / 2;

  // Shift midpoint by bias * confidence * half-range
  const shift = bias * confidence * (range / 2) * 0.5; // 0.5 dampening to avoid extremes
  const newMid = Math.max(min, Math.min(max, mid + shift));

  // Generate random with gaussian-like distribution around newMid
  // Using Irwin-Hall approximation (sum of 3 uniforms)
  const u = (Math.random() + Math.random() + Math.random()) / 3;
  const value = newMid + (u - 0.5) * range;

  return Math.max(min, Math.min(max, value));
}

/**
 * Convenience: biased integer in [min, max].
 */
export function biasedRandomInt(min, max, bias, confidence) {
  return Math.floor(biasedRandom(min, max + 1, bias, confidence));
}

// ─── Summary for Logging ────────────────────────────────────

/**
 * Produce a human-readable summary of feedback state for console output.
 */
export function formatFeedbackSummary(feedback) {
  if (!feedback || feedback.totalExperiments === 0) {
    return "  Feedback: No prior experiment data. Using uniform random selection.";
  }

  const lines = [
    `  Feedback: ${feedback.totalExperiments} prior experiments analyzed.`,
  ];

  const mutNames = Object.keys(feedback.mutationStats).sort();
  for (const name of mutNames) {
    const s = feedback.mutationStats[name];
    const sharpeStr = isFinite(s.avgKeptSharpe) ? s.avgKeptSharpe.toFixed(4) : "N/A";
    lines.push(
      `    ${name.padEnd(22)} keeps=${s.keeps}/${s.total} (${(s.keepRate * 100).toFixed(0)}%) avgKeptSharpe=${sharpeStr}`
    );
  }

  return lines.join("\n");
}
