#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { summarizeSweep } from './policy-sweep-utils.mjs';

function parseArgs(argv) {
  const args = { input: null, out: null, help: false };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (!args.input) args.input = raw;
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  if (!args.input) args.help = true;
  return args;
}

function help() {
  console.log(`Interwheel policy sweep summarizer

USAGE:
  npm run analyze:interwheel:policies:summary -- .tmp/interwheel-policy-sweeps/<run>/raw.json
  npm run analyze:interwheel:policies:summary -- .tmp/interwheel-policy-sweeps/<run>/raw.json --out=.tmp/interwheel-policy-sweeps/<run>/summary.json
`);
}

function reportMarkdown(report) {
  const lines = [
    '# Interwheel Policy Sweep Summary',
    '',
    `- baseline: ${report.baseline ?? 'none'}`,
    '',
    '## Slopes',
    '',
    '```json',
    JSON.stringify(report.slopes, null, 2),
    '```',
    '',
    '## Sweep Tables',
    '',
  ];
  for (const [group, rows] of Object.entries(report.sweepTables)) {
    lines.push(`### ${group}`, '');
    lines.push('| condition | height | height Δ% | bonus/min | bonus Δ% | wallJ/min | wallJ Δ% |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of rows) {
      lines.push(
        `| ${row.name} | ${row.height} | ${row.heightDeltaPct} | ${row.bonusScorePerMin} | ${row.bonusScorePerMinDeltaPct} | ${row.wallJumpsPerMin} | ${row.wallJumpsPerMinDeltaPct} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(args.input ? 0 : 1);
  }
  const raw = JSON.parse(await readFile(args.input, 'utf8'));
  const summary = summarizeSweep(raw);
  const out = args.out ?? join(dirname(args.input), 'summary.json');
  await writeFile(out, JSON.stringify(summary, null, 2));
  await writeFile(join(dirname(out), 'report.md'), reportMarkdown(summary));
  console.log(JSON.stringify({ input: args.input, out }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
