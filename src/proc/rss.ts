import { execa } from 'execa';

/** Tracks the peak resident memory of named process trees. */
export interface RssSampler {
  /** Adds a tree: the process `rootPid` and all its descendants, reported under `name`. */
  track(name: string, rootPid: number): void;
  /** Takes a last sample, stops sampling and returns the peak RSS of each tree in MB. */
  stop(): Promise<Record<string, number>>;
}

/** One `ps` snapshot: RSS in kB per PID, and the children of each PID. */
interface ProcessTable {
  rssKb: Map<number, number>;
  children: Map<number, number[]>;
}

async function readProcessTable(): Promise<ProcessTable> {
  const { stdout } = await execa('ps', ['-A', '-o', 'pid=,ppid=,rss='], { reject: false });
  const table: ProcessTable = { rssKb: new Map(), children: new Map() };
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length !== 3 || fields.some(Number.isNaN)) continue;
    const [pid, ppid, kb] = fields as [number, number, number];
    table.rssKb.set(pid, kb);
    const siblings = table.children.get(ppid) ?? [];
    siblings.push(pid);
    table.children.set(ppid, siblings);
  }
  return table;
}

function treeKb(root: number, table: ProcessTable): number {
  let total = table.rssKb.get(root) ?? 0;
  for (const child of table.children.get(root) ?? []) total += treeKb(child, table);
  return total;
}

/** Samples `ps -A -o pid=,ppid=,rss=` (works on Linux and macOS) every `intervalMs` and keeps the peak per tracked tree. */
export function startRssSampler(intervalMs = 1_000): RssSampler {
  const roots = new Map<string, number>();
  const peaks: Record<string, number> = {};
  let inFlight: Promise<void> | undefined;

  const takeSample = async () => {
    const table = await readProcessTable();
    for (const [name, root] of roots) {
      const mb = Math.round(treeKb(root, table) / 102.4) / 10;
      peaks[name] = Math.max(peaks[name] ?? 0, mb);
    }
  };
  const sample = () => {
    inFlight ??= takeSample().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const timer = setInterval(() => void sample(), intervalMs);
  timer.unref();
  return {
    track(name, rootPid) {
      roots.set(name, rootPid);
      peaks[name] ??= 0;
      void sample();
    },
    async stop() {
      clearInterval(timer);
      await inFlight;
      await sample();
      return peaks;
    },
  };
}
