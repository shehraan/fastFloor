import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { summarize } from '../src/fastfloor/evaluation.ts';
import type { TraceEvent } from '../src/fastfloor/evaluation.ts';

const paths = process.argv.slice(2);
if (!paths.length)
  throw new Error('Usage: pnpm eval:report <trace.jsonl or SDK-results.json> [...]');
const eventSchema = z.object({
  runId: z.string().min(1),
  arm: z.enum(['baseline', 'fastfloor']),
  timestamp: z.string(),
  elapsedMs: z.number().finite().nonnegative(),
  event: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
});
const groups = new Map<string, TraceEvent[]>();
for (const path of paths) {
  const source = readFileSync(path, 'utf8').trim();
  if (!source) throw new Error(`Empty trace: ${path}`);
  let values: unknown[];
  try {
    const document: unknown = JSON.parse(source);
    const report = z
      .object({ runs: z.array(z.object({ events: z.array(eventSchema) })) })
      .safeParse(document);
    values = report.success ? report.data.runs.flatMap((run) => run.events) : [document];
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    values = source
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  for (const value of values) {
    const event = eventSchema.parse(value);
    const group = groups.get(event.runId) ?? [];
    if (group.length && group[0]!.arm !== event.arm) throw new Error('A run cannot change arms');
    group.push(event);
    groups.set(event.runId, group);
  }
}
const configs = [...groups.values()].map(
  (events) => events.find((event) => event.event === 'RUN_CONFIG')?.details,
);
const configurationKeys = configs.map(
  (config) =>
    config &&
    JSON.stringify(
      Object.fromEntries(
        Object.entries(config).filter(([key]) => key !== 'arm' && key !== 'speculationEnabled'),
      ),
    ),
);
console.log(
  JSON.stringify(
    {
      audibleOnsetMeasured: false,
      metric: 'commitment to SDK output playback event; not client acoustic onset',
      matchingConfigurations: configs.every(Boolean) ? new Set(configurationKeys).size === 1 : null,
      // Never pool clocks across sessions. Individual turn samples remain available.
      runs: [...groups.values()].map((events) => ({
        ...summarize(events),
        configuration: events.find((event) => event.event === 'RUN_CONFIG')?.details ?? null,
      })),
    },
    null,
    2,
  ),
);
