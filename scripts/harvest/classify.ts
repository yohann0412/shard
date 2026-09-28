import type { Candidate } from './schema.js';

type Classified = Pick<Candidate, 'class' | 'classReasons' | 'blockers'>;
type Facts = Pick<Candidate, 'backendLanguage' | 'database' | 'unmanagedServices' | 'documentedE2E'>;

function first(evidence: string[]): string {
  return evidence[0] ?? 'no evidence';
}

/**
 * Static A/B/C class. C: backend not (confirmed) Node, database not Postgres, or the e2e setup fails without a
 * third-party credential. B: extra services, other third-party secrets, or no documented e2e setup. A: none of these.
 */
export function classify(facts: Facts): Classified {
  const hard: Array<[string, string]> = [];
  const soft: Array<[string, string]> = [];
  const { backendLanguage, database, unmanagedServices, documentedE2E } = facts;

  if (backendLanguage.kind !== 'node') {
    hard.push([`backend: ${backendLanguage.kind}`, `backend is ${backendLanguage.kind} (${first(backendLanguage.evidence)})`]);
  }
  if (database.kind !== 'postgres') {
    hard.push([`database: ${database.kind}`, `database is ${database.kind} (${first(database.evidence)})`]);
  }
  for (const service of unmanagedServices) {
    if (service.kind === 'third-party' && service.requiredByE2E) {
      hard.push([`e2e credentials: ${service.name}`, `e2e setup requires ${service.name} credentials (${first(service.evidence)})`]);
    } else if (service.kind === 'third-party') {
      soft.push([`third-party: ${service.name}`, `${service.name} secrets, plausibly fakeable (${first(service.evidence)})`]);
    } else {
      soft.push([`service: ${service.name}`, `needs ${service.name} (${first(service.evidence)})`]);
    }
  }
  if (!documentedE2E.value) soft.push(['no documented e2e', 'no e2e script and no e2e instructions in README/CONTRIBUTING']);

  const blockers = [...hard, ...soft].map(([blocker]) => blocker);
  if (hard.length > 0) return { class: 'C', classReasons: [...hard, ...soft].map(([, reason]) => reason), blockers };
  if (soft.length > 0) return { class: 'B', classReasons: soft.map(([, reason]) => reason), blockers };
  return {
    class: 'A',
    classReasons: [
      `node backend (${first(backendLanguage.evidence)})`,
      `postgres (${first(database.evidence)})`,
      `documented e2e (${first(documentedE2E.evidence)})`,
      'no unmanaged services or third-party secrets detected',
    ],
    blockers,
  };
}
