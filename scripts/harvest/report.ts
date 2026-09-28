import type { Harvest } from './schema.js';

const TOP_BLOCKERS = 15;

/** Occurrences of each key, most frequent first. */
export function tally(keys: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function table(header: [string, string], rows: Array<[string, string | number]>): string {
  const lines = [`| ${header[0]} | ${header[1]} |`, '|---|---:|', ...rows.map(([key, value]) => `| ${key} | ${value} |`)];
  return lines.join('\n');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** The human summary: sources, counts, class and exclusion distributions, top blockers and every class-A candidate. */
export function summaryMarkdown(harvest: Harvest): string {
  const { sources, criteria, counts, candidates } = harvest;
  const awesome = sources.awesomeSelfhostedData;
  const poolSize = sources.seedList.length + awesome.pool;
  const filters = Object.entries(awesome.poolFilteredOut).map(([reason, n]) => `${reason}: ${n}`).join(', ');
  let outcome = `Fewer than the target of ${criteria.target} qualified: the whole pool of ${poolSize} repos was scanned and only ${counts.qualified} met the criteria.`;
  if (counts.qualified >= criteria.target) {
    outcome = `Target reached. Scans already in flight when it was reached were kept; ${counts.notScanned} pool repos were not scanned.`;
  } else if (counts.notScanned > 0) {
    outcome = `Fewer than the target of ${criteria.target} qualified, and ${counts.notScanned} of ${poolSize} pool repos were not scanned (--limit).`;
  }
  const blockers = Object.entries(tally(candidates.flatMap((c) => c.blockers))).slice(0, TOP_BLOCKERS);
  const classA = candidates.filter((c) => c.class === 'A');
  const classARows = classA.map((c) => {
    const script = c.e2eScript ? `\`${escapeCell(c.e2eScript.name)}\` in ${c.e2eScript.file}: \`${escapeCell(c.e2eScript.command)}\`` : 'none (documented in docs)';
    return `| ${c.name} | ${c.stars ?? 'unknown'} | ${script} | ${c.playwrightConfigPath} |`;
  });

  return [
    '# Harvest summary',
    '',
    `- Harvested: ${harvest.harvestedAt}`,
    `- Seed list: ${sources.seedList.length} repos.`,
    `- awesome-selfhosted-data @ ${awesome.commit.slice(0, 7)} (snapshot ${awesome.commitDate}, the date of every star count): ${awesome.entries} entries, ${awesome.pool} in the pool after filters (${filters}).`,
    `- Criteria: ${criteria.playwrightConfig}; >= ${criteria.minStars} stars (unknown allowed for seed-list repos); HEAD commit after ${criteria.lastPushAfter}; database evidence: ${criteria.databaseEvidence.join(', ')}.`,
    `- Order: ${criteria.order}.`,
    '',
    `Scanned ${counts.scanned} repos; **${counts.qualified} qualified** (target ${criteria.target}). ${outcome}`,
    '',
    '## Classes of qualified candidates',
    '',
    table(['Class', 'Candidates'], Object.entries(counts.byClass)),
    '',
    '## Why scanned repos did not qualify',
    '',
    table(['Reason', 'Repos'], Object.entries(counts.byExclusionReason)),
    '',
    `## Top ${TOP_BLOCKERS} blockers among qualified candidates`,
    '',
    'A candidate can have several blockers; C-level ones are backend, database and e2e credentials.',
    '',
    table(['Blocker', 'Candidates'], blockers),
    '',
    '## Class A candidates',
    '',
    classA.length === 0 ? 'None.' : ['| Repository | Stars | e2e script | Playwright config |', '|---|---:|---|---|', ...classARows].join('\n'),
    '',
  ].join('\n');
}
