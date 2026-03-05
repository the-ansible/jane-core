/**
 * Classification quality metrics.
 * Tracks agreement rates, escalation rates, latency, and distribution
 * to measure local model reliability over time.
 */

import type { Tier, Urgency, Category, Routing, Confidence } from './types.js';

export interface ClassifierMetrics {
  /** Total messages classified */
  totalClassified: number;

  /** Breakdown by tier that handled it */
  byTier: Record<Tier, number>;

  /** Hit rates as percentages */
  rates: {
    rulesHitRate: number;      // % handled by rules alone
    consensusHitRate: number;   // % handled by local consensus
    escalationRate: number;     // % that needed Claude
    fallbackRate: number;       // % that fell to default
  };

  /** Consensus agreement stats (only for tier=local_consensus) */
  consensus: {
    totalVotes: number;        // total Ollama calls made
    avgAgreement: number;      // average agreeing/votes ratio
    perfectAgreement: number;  // count where 3/3 agreed
    majorityAgreement: number; // count where 2/3 agreed
  };

  /** Average latency per tier (ms) */
  latency: Record<Tier, number>;

  /** Distribution of classification results */
  distribution: {
    urgency: Record<Urgency, number>;
    category: Record<Category, number>;
    routing: Record<Routing, number>;
    confidence: Record<Confidence, number>;
  };
}

interface MetricsState {
  total: number;
  tierCounts: Record<Tier, number>;
  tierLatencySums: Record<Tier, number>;
  consensusVotes: number;
  consensusAgreeingSum: number;
  perfectAgreements: number;
  majorityAgreements: number;
  urgencyCounts: Record<Urgency, number>;
  categoryCounts: Record<Category, number>;
  routingCounts: Record<Routing, number>;
  confidenceCounts: Record<Confidence, number>;
}

function createEmptyState(): MetricsState {
  return {
    total: 0,
    tierCounts: { rules: 0, local_consensus: 0, mercury: 0, claude_escalation: 0, fallback: 0 },
    tierLatencySums: { rules: 0, local_consensus: 0, mercury: 0, claude_escalation: 0, fallback: 0 },
    consensusVotes: 0,
    consensusAgreeingSum: 0,
    perfectAgreements: 0,
    majorityAgreements: 0,
    urgencyCounts: { immediate: 0, normal: 0, low: 0, ignore: 0 },
    categoryCounts: { question: 0, task_request: 0, social: 0, alert: 0, informational: 0 },
    routingCounts: { reflexive_reply: 0, deliberate_thought: 0, log_only: 0, escalate: 0 },
    confidenceCounts: { high: 0, medium: 0, low: 0 },
  };
}

let state: MetricsState = createEmptyState();

export function recordClassification(
  tier: Tier,
  urgency: Urgency,
  category: Category,
  routing: Routing,
  confidence: Confidence,
  latencyMs: number,
  agreement?: { votes: number; agreeing: number }
): void {
  state.total++;
  state.tierCounts[tier]++;
  state.tierLatencySums[tier] += latencyMs;
  state.urgencyCounts[urgency]++;
  state.categoryCounts[category]++;
  state.routingCounts[routing]++;
  state.confidenceCounts[confidence]++;

  if (agreement) {
    state.consensusVotes += agreement.votes;
    state.consensusAgreeingSum += agreement.agreeing;
    if (agreement.votes === agreement.agreeing) {
      state.perfectAgreements++;
    } else if (agreement.agreeing > agreement.votes / 2) {
      state.majorityAgreements++;
    }
  }
}

export function getClassifierMetrics(): ClassifierMetrics {
  const total = state.total || 1; // avoid division by zero

  const avgLatency = (tier: Tier) => {
    const count = state.tierCounts[tier];
    return count > 0 ? Math.round(state.tierLatencySums[tier] / count) : 0;
  };

  const consensusTotal = state.tierCounts.local_consensus || 1;

  return {
    totalClassified: state.total,
    byTier: { ...state.tierCounts },
    rates: {
      rulesHitRate: Math.round((state.tierCounts.rules / total) * 10000) / 100,
      consensusHitRate: Math.round((state.tierCounts.local_consensus / total) * 10000) / 100,
      escalationRate: Math.round((state.tierCounts.claude_escalation / total) * 10000) / 100,
      fallbackRate: Math.round((state.tierCounts.fallback / total) * 10000) / 100,
    },
    consensus: {
      totalVotes: state.consensusVotes,
      avgAgreement: state.consensusVotes > 0
        ? Math.round((state.consensusAgreeingSum / state.consensusVotes) * 100) / 100
        : 0,
      perfectAgreement: state.perfectAgreements,
      majorityAgreement: state.majorityAgreements,
    },
    latency: {
      rules: avgLatency('rules'),
      local_consensus: avgLatency('local_consensus'),
      mercury: avgLatency('mercury'),
      claude_escalation: avgLatency('claude_escalation'),
      fallback: avgLatency('fallback'),
    },
    distribution: {
      urgency: { ...state.urgencyCounts },
      category: { ...state.categoryCounts },
      routing: { ...state.routingCounts },
      confidence: { ...state.confidenceCounts },
    },
  };
}

export function resetClassifierMetrics(): void {
  state = createEmptyState();
}
