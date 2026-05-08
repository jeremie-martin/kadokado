import type { CandidateScoreBreakdown, PlannerPolicy } from './interwheel-planner';

export type InspectionCandidate = {
  edgeId: number;
  parentEdgeId: number;
  childNodeId: number;
  depth: number;
  isLeaf: boolean;
  isStable: boolean;
  isDead: boolean;

  pathHeight: number;
  pathWallTicks: number;
  pathWallLandings: number;
  pathOffAxis: number;
  totalTicks: number;
  collectedKeys: string[];

  score: CandidateScoreBreakdown;

  actionChain: boolean[];

  endStateBlobX: number;
  endStateBlobY: number;
  endStateBlobState: number;
};

export type InspectionRecord = {
  tick: number;
  seed: number | null;
  policy: PlannerPolicy;
  searchLimits: { maxStableDepth: number; maxEdgeRollouts: number; budgetMs: number };

  rootStateBlobX: number;
  rootStateBlobY: number;
  rootStateBlobState: number;
  perceivedWheels: number;
  perceivedPastilles: number;

  candidates: InspectionCandidate[];

  chosenEdgeId: number;
  chosenLeafNodeId: number;

  edgesEvaluated: number;
  stableNodesExpanded: number;
  planMs: number;
};

const BLOB_STATE_NAME: Record<number, string> = {
  0: 'IDLE',
  1: 'GRAB',
  2: 'WALL',
  3: 'FLY',
  4: 'DEAD',
};

export function formatInspectionMarkdown(
  record: InspectionRecord,
  options: { topN?: number } = {},
): string {
  const topN = options.topN ?? 8;
  const lines: string[] = [];

  lines.push(`# Plan inspection — tick ${record.tick}, seed ${record.seed ?? '(none)'}`);
  lines.push('');
  lines.push('## Setup');
  lines.push('');
  lines.push(`- policy: \`${formatPolicy(record.policy)}\``);
  lines.push(
    `- search: maxStableDepth=${record.searchLimits.maxStableDepth}, ` +
      `maxEdgeRollouts=${record.searchLimits.maxEdgeRollouts}, ` +
      `budgetMs=${record.searchLimits.budgetMs}`,
  );
  lines.push(
    `- root blob: state=${stateName(record.rootStateBlobState)} ` +
      `at (${Math.round(record.rootStateBlobX)}, ${Math.round(record.rootStateBlobY)})`,
  );
  lines.push(
    `- perceived: ${record.perceivedWheels} wheels, ${record.perceivedPastilles} pastilles`,
  );
  lines.push(
    `- planner: ${record.edgesEvaluated} edges evaluated, ` +
      `${record.stableNodesExpanded} stable nodes expanded, ${record.planMs.toFixed(2)}ms`,
  );
  lines.push('');

  const leaves = record.candidates.filter((c) => c.isLeaf);
  const sortedLeaves = [...leaves].sort((a, b) => b.score.total - a.score.total);
  const topLeaves = sortedLeaves.slice(0, topN);

  const maxPastLeaf = leaves.reduce<InspectionCandidate | null>((acc, c) => {
    if (!acc || c.collectedKeys.length > acc.collectedKeys.length) return c;
    return acc;
  }, null);

  const chosenLeaf = leaves.find((c) => c.childNodeId === record.chosenLeafNodeId) ?? null;

  const includedIds = new Set<number>();
  const featured: Array<{ candidate: InspectionCandidate; tag: string }> = [];
  for (const cand of topLeaves) {
    if (includedIds.has(cand.edgeId)) continue;
    const tag = chosenLeaf && cand.edgeId === chosenLeaf.edgeId ? 'CHOSEN' : '';
    featured.push({ candidate: cand, tag });
    includedIds.add(cand.edgeId);
  }
  if (chosenLeaf && !includedIds.has(chosenLeaf.edgeId)) {
    featured.push({ candidate: chosenLeaf, tag: 'CHOSEN' });
    includedIds.add(chosenLeaf.edgeId);
  }
  if (
    maxPastLeaf &&
    maxPastLeaf.collectedKeys.length > 0 &&
    !includedIds.has(maxPastLeaf.edgeId)
  ) {
    featured.push({ candidate: maxPastLeaf, tag: 'MAX-PAST' });
    includedIds.add(maxPastLeaf.edgeId);
  }

  lines.push(`## Leaf candidates (${leaves.length} total, top ${featured.length} shown)`);
  lines.push('');
  lines.push(
    '| # | tag | total | climb | thor | wall | pace | detour | stab | safety | depth | wallL | wallT | offAx | tick | grabs | end |',
  );
  lines.push(
    '|---|-----|-------|-------|------|------|------|--------|------|--------|-------|-------|-------|-------|------|-------|-----|',
  );
  let row = 1;
  for (const { candidate, tag } of featured) {
    lines.push(
      `| ${row} | ${tag || ''} | ` +
        `${fmtNum(candidate.score.total)} | ` +
        `${fmtNum(candidate.score.climb)} | ` +
        `${fmtNum(candidate.score.thoroughness)} | ` +
        `${fmtNum(candidate.score.wall)} | ` +
        `${fmtNum(-candidate.score.pace)} | ` +
        `${fmtNum(-candidate.score.detour)} | ` +
        `${fmtNum(candidate.score.stability)} | ` +
        `${fmtNum(-candidate.score.safety)} | ` +
        `${candidate.depth} | ` +
        `${candidate.pathWallLandings} | ` +
        `${candidate.pathWallTicks} | ` +
        `${Math.round(candidate.pathOffAxis)} | ` +
        `${candidate.totalTicks} | ` +
        `${candidate.collectedKeys.length} | ` +
        `${stateName(candidate.endStateBlobState)} ` +
        `(${Math.round(candidate.endStateBlobX)}, ${Math.round(candidate.endStateBlobY)}) |`,
    );
    row += 1;
  }
  lines.push('');

  lines.push('## Plan steering note');
  lines.push('');
  if (chosenLeaf) {
    lines.push(
      `Chosen leaf node #${chosenLeaf.childNodeId} (edge ${chosenLeaf.edgeId}): ` +
        `total=${fmtNum(chosenLeaf.score.total)}, ` +
        `${chosenLeaf.collectedKeys.length} grabs, depth=${chosenLeaf.depth}, ` +
        `pathHeight=${Math.round(chosenLeaf.pathHeight)}px, ` +
        `pathWallTicks=${chosenLeaf.pathWallTicks}.`,
    );
    if (
      maxPastLeaf &&
      maxPastLeaf.edgeId !== chosenLeaf.edgeId &&
      maxPastLeaf.collectedKeys.length > chosenLeaf.collectedKeys.length
    ) {
      const delta = chosenLeaf.score.total - maxPastLeaf.score.total;
      lines.push('');
      lines.push(
        `Pastille-richer alternative: leaf #${maxPastLeaf.childNodeId} would have ` +
          `grabbed ${maxPastLeaf.collectedKeys.length} (vs chosen ${chosenLeaf.collectedKeys.length}) ` +
          `but lost on score by ${fmtNum(delta)}: ` +
          `Δclimb=${fmtNum(chosenLeaf.score.climb - maxPastLeaf.score.climb)}, ` +
          `Δthor=${fmtNum(chosenLeaf.score.thoroughness - maxPastLeaf.score.thoroughness)}, ` +
          `Δwall=${fmtNum(chosenLeaf.score.wall - maxPastLeaf.score.wall)}, ` +
          `Δpace=${fmtNum(maxPastLeaf.score.pace - chosenLeaf.score.pace)}, ` +
          `Δdetour=${fmtNum(maxPastLeaf.score.detour - chosenLeaf.score.detour)}.`,
      );
    }
  } else {
    lines.push('No chosen leaf available (planner returned a non-stable plan).');
  }
  lines.push('');

  lines.push('## Action chain (chosen)');
  lines.push('');
  if (chosenLeaf) {
    const actions = chosenLeaf.actionChain;
    const compact = compactActionChain(actions);
    lines.push('```');
    lines.push(compact);
    lines.push('```');
    lines.push('');
    lines.push(`Total ticks: ${actions.length}, presses: ${actions.filter((p) => p).length}.`);
  } else {
    lines.push('(none)');
  }

  return lines.join('\n');
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return 'n/a';
  if (Math.abs(v) >= 10000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function stateName(state: number): string {
  return BLOB_STATE_NAME[state] ?? `?${state}`;
}

function formatPolicy(p: PlannerPolicy): string {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? v : String(v)}`)
    .join(', ');
}

function compactActionChain(actions: boolean[]): string {
  const out: string[] = [];
  for (const a of actions) out.push(a ? 'J' : '_');
  return out.join('');
}
