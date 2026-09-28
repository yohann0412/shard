import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import type { MachineFacts } from './machine.js';
import { harnessRoot, resultPaths, resultsRoot } from './paths.js';
import { say } from './provenance.js';

/** The parts of experiment-a.json the plot reads. */
interface ExperimentA {
  name: string;
  machine: MachineFacts;
  protocol: { label: string };
  aggregate: { speedups: { byWorkers: { workers: number; testPhase: number | null; oversubscribed: boolean }[] } };
}

/** One line of the plot. */
interface Series {
  label: string;
  points: { workers: number; speedup: number; oversubscribed: boolean }[];
}

/** Categorical slots in fixed order (validated: adjacent CVD ΔE ≥ 9.1, normal-vision ΔE ≥ 19.6 on the light surface). */
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const INK = { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', surface: '#fcfcfb' };
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const WIDTH = 900;
const HEIGHT = 480;
const MARGIN = { top: 72, right: 280, bottom: 56, left: 64 };
const WORKER_TICKS = [1, 2, 4, 8];

/** Escapes text for SVG content and attribute values. */
function xml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** Every data/results/<repo>/experiment-a.json, by repo name. */
function readExperiments(): ExperimentA[] {
  const names = existsSync(resultsRoot) ? readdirSync(resultsRoot).filter((name) => existsSync(resultPaths(name).experimentA)).sort() : [];
  if (names.length === 0) throw new Error(`no ${path.relative(harnessRoot, resultsRoot)}/*/experiment-a.json to plot`);
  return names.map((name) => JSON.parse(readFileSync(resultPaths(name).experimentA, 'utf8')) as ExperimentA);
}

/** One line per repo: the median test-phase speedup at each N that has one. */
function toSeries(experiment: ExperimentA): Series {
  const points = experiment.aggregate.speedups.byWorkers.flatMap((row) => (row.testPhase === null ? [] : [{ workers: row.workers, speedup: row.testPhase, oversubscribed: row.oversubscribed }]));
  return { label: experiment.protocol.label === 'reduced' ? `${experiment.name} (reduced protocol)` : experiment.name, points };
}

/** The machine line of the title (every distinct machine, if repos ran on different ones). */
function machineLine(experiments: ExperimentA[]): string {
  const describe = (machine: MachineFacts) =>
    `${machine.cpuModel}, ${machine.cores} vCPU (${machine.threadsPerCore ?? '?'} thread/core), ${machine.ramGb} GB RAM, ${machine.os}${machine.cloudSandbox ? ', cloud sandbox' : ''}`;
  return [...new Set(experiments.map((experiment) => describe(experiment.machine)))].join(' | ');
}

/**
 * The value at the end of each line, skipping a label that would sit within 14 px of one already placed (converging
 * lines): the legend and each point's tooltip still carry it.
 */
function endLabels(series: Series[], x: (workers: number) => number, y: (speedup: number) => number): string[] {
  const ends = series.flatMap((line) => (line.points.length === 0 ? [] : [line.points.at(-1)!])).sort((a, b) => y(a.speedup) - y(b.speedup));
  const placed: number[] = [];
  return ends.flatMap((end) => {
    const top = y(end.speedup);
    if (placed.some((other) => Math.abs(other - top) < 14)) return [];
    placed.push(top);
    return [`<text x="${x(end.workers) + 9}" y="${top + 4}" font-size="12" fill="${INK.primary}">${end.speedup.toFixed(2)}×</text>`];
  });
}

/** Renders the chart as a standalone SVG document. */
function renderSvg(series: Series[], cores: number, machine: string): string {
  const maxY = Math.max(8, ...series.flatMap((line) => line.points.map((point) => Math.ceil(point.speedup))));
  const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const x = (workers: number) => MARGIN.left + (workers / 8.5) * plotWidth;
  const y = (speedup: number) => MARGIN.top + plotHeight - (speedup / maxY) * plotHeight;
  const yStep = maxY > 10 ? 2 : 1;
  const parts: string[] = [];

  for (let tick = 0; tick <= maxY; tick += yStep) {
    parts.push(`<line x1="${MARGIN.left}" x2="${MARGIN.left + plotWidth}" y1="${y(tick)}" y2="${y(tick)}" stroke="${tick === 0 ? INK.axis : INK.grid}" stroke-width="1"/>`);
    parts.push(`<text x="${MARGIN.left - 8}" y="${y(tick) + 4}" text-anchor="end" font-size="12" fill="${INK.muted}">${tick}×</text>`);
  }
  for (const tick of WORKER_TICKS) {
    parts.push(`<text x="${x(tick)}" y="${MARGIN.top + plotHeight + 18}" text-anchor="middle" font-size="12" fill="${INK.muted}">${tick}</text>`);
  }
  parts.push(`<text x="${MARGIN.left + plotWidth / 2}" y="${HEIGHT - 14}" text-anchor="middle" font-size="13" fill="${INK.secondary}">Playwright workers (N)</text>`);
  parts.push(`<text transform="translate(18 ${MARGIN.top + plotHeight / 2}) rotate(-90)" text-anchor="middle" font-size="13" fill="${INK.secondary}">test-phase speedup vs isolated@1</text>`);

  parts.push(`<line x1="${x(cores)}" x2="${x(cores)}" y1="${MARGIN.top}" y2="${MARGIN.top + plotHeight}" stroke="${INK.secondary}" stroke-width="1"/>`);
  parts.push(`<text x="${x(cores) + 6}" y="${MARGIN.top + 12}" font-size="12" fill="${INK.secondary}">${cores} cores</text>`);
  parts.push(`<line x1="${x(1)}" y1="${y(1)}" x2="${x(8)}" y2="${y(8)}" stroke="${INK.muted}" stroke-width="1.5" stroke-dasharray="6 5"><title>ideal: speedup = N</title></line>`);

  series.forEach((line, index) => {
    const color = SERIES_COLORS[index % SERIES_COLORS.length]!;
    const d = line.points.map((point, i) => `${i === 0 ? 'M' : 'L'}${x(point.workers).toFixed(1)} ${y(point.speedup).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    for (const point of line.points) {
      const fill = point.oversubscribed ? INK.surface : color;
      const note = point.oversubscribed ? ' (oversubscribed)' : '';
      parts.push(`<circle cx="${x(point.workers)}" cy="${y(point.speedup)}" r="5" fill="${fill}" stroke="${point.oversubscribed ? color : INK.surface}" stroke-width="2"><title>${xml(line.label)}: N=${point.workers}${note}, ${point.speedup.toFixed(2)}×</title></circle>`);
    }
  });
  parts.push(...endLabels(series, x, y));

  const legendX = WIDTH - MARGIN.right + 24;
  const legend = [
    ...series.map((line, index) => `<line x1="0" x2="20" y1="0" y2="0" stroke="${SERIES_COLORS[index % SERIES_COLORS.length]}" stroke-width="2"/><circle cx="10" cy="0" r="4" fill="${SERIES_COLORS[index % SERIES_COLORS.length]}"/><text x="28" y="4" font-size="12" fill="${INK.primary}">${xml(line.label)}</text>`),
    `<line x1="0" x2="20" y1="0" y2="0" stroke="${INK.muted}" stroke-width="1.5" stroke-dasharray="6 5"/><text x="28" y="4" font-size="12" fill="${INK.secondary}">ideal (speedup = N)</text>`,
    `<line x1="10" x2="10" y1="-7" y2="7" stroke="${INK.secondary}" stroke-width="1"/><text x="28" y="4" font-size="12" fill="${INK.secondary}">core count</text>`,
    `<circle cx="10" cy="0" r="4" fill="${INK.surface}" stroke="${INK.secondary}" stroke-width="2"/><text x="28" y="4" font-size="12" fill="${INK.secondary}">N &gt; cores (oversubscribed)</text>`,
  ];
  legend.forEach((entry, index) => parts.push(`<g transform="translate(${legendX} ${MARGIN.top + 8 + index * 22})">${entry}</g>`));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" font-family='${FONT}'>
<rect width="${WIDTH}" height="${HEIGHT}" fill="${INK.surface}"/>
<text x="${MARGIN.left - 46}" y="28" font-size="16" font-weight="600" fill="${INK.primary}">Median test-phase speedup vs isolated@1, by worker count</text>
<text x="${MARGIN.left - 46}" y="48" font-size="12" fill="${INK.secondary}">${xml(machine)}</text>
${parts.join('\n')}
</svg>
`;
}

/** Screenshots the SVG with Playwright's Chromium at 2x, so the PNG is exactly the SVG. */
async function renderPng(svg: string, file: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    await page.locator('svg').screenshot({ path: file });
  } finally {
    await browser.close();
  }
}

/** Writes data/results/speedup-vs-workers.svg and .png from every experiment-a.json. */
async function main(): Promise<number> {
  const experiments = readExperiments();
  const svg = renderSvg(experiments.map(toSeries), experiments[0]!.machine.cores, machineLine(experiments));
  const svgFile = path.join(resultsRoot, 'speedup-vs-workers.svg');
  const pngFile = path.join(resultsRoot, 'speedup-vs-workers.png');
  writeFileSync(svgFile, svg);
  await renderPng(svg, pngFile);
  say(`wrote ${path.relative(harnessRoot, svgFile)} and ${path.relative(harnessRoot, pngFile)} (${experiments.length} repo(s))`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    say(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
