import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Run from the project root with node --env-file=.env.local. Never print credentials.
// This is real provider audio over the CLI console transport, NOT room/WebRTC
// playback or a physical speaker measurement. Caller speech is generated afresh.
const directory = process.argv[2];
if (!directory)
  throw new Error(
    'Usage: node --env-file=.env.local <this-file> <output-directory> <session 1..4>',
  );
const output = resolve(directory);
mkdirSync(output, { recursive: true });
const port = '8787';
const utterances = [
  'I want to travel to New York on Monday. Please remember that destination and day.',
  'Actually, change the destination to Boston instead. Keep the same day.',
  'What destination did I mention originally, before I changed it, and what is my current destination?',
  'For a separate fictional trip, I am traveling with my sister, we prefer a quiet hotel near the station, we need two rooms, and we will arrive on Monday, actually Tuesday, in Lisbon. Please repeat the city, corrected day, number of rooms, and hotel preference without making any booking.',
  'What were the corrected day and city for the separate trip, and what was the original destination for my first trip?',
];
const arms = ['baseline', 'fastfloor', 'fastfloor', 'baseline'] as const;
// One session per invocation keeps captures durable across sandbox resets.
const selectedSession = Number(process.argv[3]);
if (!Number.isInteger(selectedSession) || selectedSession < 1 || selectedSession > arms.length)
  throw new Error('Pass session number 1..4 after the output directory (ABBA order)');
let failed = false;
function command(args: string[], env: NodeJS.ProcessEnv, file: string) {
  const result = spawnSync('lk', args, { env, encoding: 'utf8', timeout: 100_000 });
  const text = result.stdout ?? '';
  writeFileSync(resolve(output, file), text || JSON.stringify({ error: result.error?.message }), {
    mode: 0o600,
  });
  // CLI diagnostics are saved, not treated as measurements.
  if (result.stderr)
    writeFileSync(resolve(output, `${file}.stderr`), result.stderr, { mode: 0o600 });
  return { result, document: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
for (const [index, arm] of arms.entries()) {
  if (index + 1 !== selectedSession) continue;
  const label = `${index + 1}-${arm}`;
  if (existsSync(resolve(output, `${label}.jsonl`)))
    throw new Error(`Refusing to append to an existing capture: ${label}; use a fresh directory`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FASTFLOOR_EVAL_ARM: arm,
    FASTFLOOR_TRACE_PATH: resolve(output, `${label}.jsonl`),
  };
  delete env.FASTFLOOR_BOARDY;
  delete env.FASTFLOOR_REAL_LLM;
  delete env.FASTFLOOR_FLUX_SPIKE;
  const prior = command(
    ['agent', 'debugger', 'status', '--port', port, '--json'],
    env,
    `${label}-prior-status.json`,
  );
  if (prior.document.running !== false)
    throw new Error(
      `Port ${port} is occupied or could not be checked; refusing to stop another session`,
    );
  try {
    const started = command(
      ['agent', 'debugger', 'start', 'src/main.ts', '--audio', '--port', port, '--json'],
      env,
      `${label}-start.json`,
    );
    if (started.result.status !== 0)
      throw new Error(`Start failed for ${label}; inspect saved diagnostics`);
    for (const [turn, text] of utterances.entries()) {
      const capture = command(
        [
          'agent',
          'debugger',
          'say',
          text,
          '--port',
          port,
          '--logs',
          '--metrics',
          '--json',
          '--timeout',
          '75s',
        ],
        env,
        `${label}-turn${turn + 1}.json`,
      );
      console.log(
        JSON.stringify({
          session: label,
          turn: turn + 1,
          status: capture.result.status,
          heard: capture.document.heard,
          reply: capture.document.reply,
        }),
      );
      if (capture.result.status !== 0) failed = true;
    }
    command(
      ['agent', 'debugger', 'chat-history', '--port', port, '--json'],
      env,
      `${label}-history.json`,
    );
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    command(['agent', 'debugger', 'stop', '--port', port, '--json'], env, `${label}-stop.json`);
    const status = command(
      ['agent', 'debugger', 'status', '--port', port, '--json'],
      env,
      `${label}-stopped-status.json`,
    );
    if (status.document.running !== false) {
      failed = true;
      console.error('Debugger shutdown was not verified');
    }
  }
}
writeFileSync(
  resolve(output, `protocol-${selectedSession}.json`),
  JSON.stringify(
    {
      transport: 'LiveKit CLI console audio; no room or acoustic measurement',
      order: arms,
      selectedSession,
      utterances,
      callerAudio: 'fresh CLI-generated speech per turn; not identical waveforms',
      endpointingChanges: false,
      failed,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
process.exitCode = failed ? 1 : 0;
