#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function parseArgs(argv) {
  const args = {
    seed: 42,
    maxHeightMeters: 4_000,
    bandMeters: 250,
    launchSamples: 144,
    allowedDropMeters: 80,
    maxWallDriftTicks: 34,
    maxTargetDeltaY: 760,
    json: false,
    outDir: null,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--json') args.json = true;
    else if (raw === '--full-height') args.maxHeightMeters = null;
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--max-height=')) args.maxHeightMeters = Number(raw.slice('--max-height='.length));
    else if (raw.startsWith('--band=')) args.bandMeters = Number(raw.slice('--band='.length));
    else if (raw.startsWith('--launch-samples=')) args.launchSamples = Number(raw.slice('--launch-samples='.length));
    else if (raw.startsWith('--allowed-drop=')) args.allowedDropMeters = Number(raw.slice('--allowed-drop='.length));
    else if (raw.startsWith('--max-wall-drift=')) args.maxWallDriftTicks = Number(raw.slice('--max-wall-drift='.length));
    else if (raw.startsWith('--max-target-dy=')) args.maxTargetDeltaY = Number(raw.slice('--max-target-dy='.length));
    else if (raw.startsWith('--out=')) args.outDir = raw.slice('--out='.length);
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (['json', 'outDir', 'help', 'maxHeightMeters'].includes(name)) continue;
    if (!Number.isFinite(value) || value < 1) {
      console.error(`--${name} must be a positive number`);
      args.help = true;
    }
  }
  if (args.maxHeightMeters !== null && (!Number.isFinite(args.maxHeightMeters) || args.maxHeightMeters < 1)) {
    console.error('--max-height must be a positive number');
    args.help = true;
  }
  return args;
}

function help() {
  console.log(`Interwheel analytical edge validator

USAGE:
  npm run analyze:interwheel:edges
  npm run analyze:interwheel:edges -- --seed=42 --max-height=4000
  npm run analyze:interwheel:edges -- --seed=42 --allowed-drop=120
  npm run analyze:interwheel:edges -- --seed=42 --max-wall-drift=80
  npm run analyze:interwheel:edges -- --seed=42 --full-height --json

This is offline experimental tooling. It builds a local reachability graph from
generated wheels using analytical jump trajectories, mine forbidden landing
arcs, and wall-assisted routes. It does not affect live generation.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }

  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing Vite server address');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${address.port}/analyze-interwheel.html`);
    const report = await page.evaluate(async ({ seed, config }) => {
      const mod = await import('/src/playground/interwheel-edge-validator.ts');
      return mod.validateInterwheelAnalyticalEdges(seed, config);
    }, {
      seed: args.seed,
      config: {
        maxHeightMeters: args.maxHeightMeters,
        bandMeters: args.bandMeters,
        launchSamples: args.launchSamples,
        allowedDropMeters: args.allowedDropMeters,
        maxWallDriftTicks: args.maxWallDriftTicks,
        maxTargetDeltaY: args.maxTargetDeltaY,
      },
    });
    if (args.outDir) {
      await mkdir(args.outDir, { recursive: true });
      await writeFile(join(args.outDir, `edges-seed-${args.seed}.json`), JSON.stringify(report, null, 2));
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
    process.exitCode = report.reachable ? 0 : 1;
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}

function printReport(report) {
  console.log('Interwheel analytical edge validation');
  console.log(`seed:       ${report.seed}`);
  console.log(`target:     ${report.targetMeters}m`);
  console.log(`generated:  ${report.generated.wheels} wheels top=${report.generated.topMeters}m mined=${report.generated.minedWheels}`);
  console.log(`result:     ${report.reachable ? 'PASS' : 'FAIL'}`);
  console.log(`reachable:  ${report.reachableWheels} wheels, max=${report.maxReachableMeters}m, edges=${report.edges.length}`);
  if (report.firstFailedBand) {
    console.log(`failed:     ${report.firstFailedBand.fromMeters}-${report.firstFailedBand.toMeters}m`);
  }
  const direct = report.edges.filter((edge) => edge.kind === 'direct').length;
  const wall = report.edges.filter((edge) => edge.kind === 'wall').length;
  console.log(`edge kinds: direct=${direct} wall=${wall}`);
  if (report.farthestRoute.length > 0) {
    console.log('farthest route tail:');
    for (const edge of report.farthestRoute.slice(-8)) {
      const wallPart = edge.wall ? ` via wall ${edge.wall.side < 0 ? 'L' : 'R'} drift=${edge.wall.driftTicks}t` : '';
      console.log(`  ${edge.from} -> ${edge.to} ${edge.kind}${wallPart} height=${edge.heightMeters}m flight=${edge.flightTicks}t`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
