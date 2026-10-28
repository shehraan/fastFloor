import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { EvaluationTrace, summarize } from './evaluation.ts';

it('correlates overlapping generations by message id and never labels SDK playback audible', () => {
  let time = 0;
  const trace = new EvaluationTrace({ arm: 'fastfloor', clock: () => time });
  const mark = (at: number, event: string, details: Record<string, unknown>) => {
    time = at;
    trace.log(event, details);
  };
  mark(0, 'PREPARATION_STARTED', { generation: 1, phase: 'preflight' });
  mark(5, 'LLM_STARTED', { generation: 1 });
  mark(15, 'LLM_FIRST_TEXT_DELTA', { generation: 1 });
  mark(20, 'USER_TURN_COMMITTED', { messageId: 'a', transcript: 'first' });
  mark(20, 'COORDINATOR_COMMITTED', { messageId: 'a', generation: 1, reused: true });
  mark(21, 'USER_TURN_COMMITTED', { messageId: 'b', transcript: 'second' });
  mark(22, 'SDK_PLAYBACK_STARTED', { messageId: 'a' });
  mark(22, 'TRANSPORT_CLAIMED', { messageId: 'a', reused: true });
  mark(23, 'PREPARATION_INVALIDATED', { generation: 2, phase: 'preflight' });
  mark(24, 'TTS_FIRST_FRAME', { messageId: 'b' });
  mark(25, 'SDK_PLAYBACK_STARTED', { messageId: 'b' });
  mark(26, 'SDK_PLAYBACK_STARTED', {});
  const report = summarize(trace.events);
  expect(report.turns).toEqual([
    expect.objectContaining({ messageId: 'a', commitToSdkPlaybackMs: 2, audibleOnsetMs: null }),
    expect.objectContaining({ messageId: 'b', commitToSdkPlaybackMs: 4, audibleOnsetMs: null }),
  ]);
  expect(report.speculativeReuses).toBe(1);
  expect(report.rollbacks).toBe(1);
  expect(report.unattributedPlaybackEvents).toBe(1);
  expect(report.prematureSdkPlayback).toBe(0);
  expect(report.prematureAudibleResponses).toBeNull();
});

it('counts precommit SDK playback as premature but does not treat TTS as playback', () => {
  let time = 0;
  const trace = new EvaluationTrace({ arm: 'baseline', clock: () => time });
  trace.log('TTS_FIRST_FRAME', { messageId: 'x' });
  trace.log('SDK_PLAYBACK_STARTED', { messageId: 'x' });
  time = 10;
  trace.log('USER_TURN_COMMITTED', { messageId: 'x' });
  const report = summarize(trace.events);
  expect(report.prematureSdkPlayback).toBe(1);
  expect(report.turns[0]!.commitToSdkPlaybackMs).toBe(-10);
  expect(report.turns[0]!.audibleOnsetMs).toBeNull();
});

it('keeps incomplete turns in denominators and does not invent latency samples', () => {
  const trace = new EvaluationTrace({ arm: 'baseline' });
  trace.log('USER_TURN_COMMITTED', { messageId: 'silent' });
  expect(summarize(trace.events)).toMatchObject({
    committedTurns: 1,
    playbackSamples: 0,
    commitToSdkPlaybackMs: { p50: null, p95: null },
  });
});

it('does not count a selected speculative candidate as reused if it is cancelled before output', () => {
  const trace = new EvaluationTrace({ arm: 'fastfloor' });
  trace.log('USER_TURN_COMMITTED', { messageId: 'a' });
  trace.log('COORDINATOR_COMMITTED', { messageId: 'a', generation: 1, reused: true });
  trace.log('PREPARATION_INVALIDATED', { generation: 1, phase: 'preflight' });
  expect(summarize(trace.events).speculativeReuses).toBe(0);
});

it('uses the first commitment timestamp when duplicate callbacks are rejected', () => {
  let time = 0;
  const trace = new EvaluationTrace({ arm: 'fastfloor', clock: () => time });
  trace.log('USER_TURN_COMMITTED', { messageId: 'a' });
  time = 10;
  trace.log('SDK_PLAYBACK_STARTED', { messageId: 'a' });
  time = 20;
  trace.log('USER_TURN_COMMITTED', { messageId: 'a' });
  expect(summarize(trace.events).turns[0]!.commitToSdkPlaybackMs).toBe(10);
});

it('exports appended JSONL sessions independently through the report CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastfloor-report-'));
  try {
    const first = new EvaluationTrace({ arm: 'baseline' });
    const second = new EvaluationTrace({ arm: 'fastfloor' });
    first.log('USER_TURN_COMMITTED', { messageId: 'same-message-id' });
    second.log('USER_TURN_COMMITTED', { messageId: 'same-message-id' });
    const path = join(dir, 'trace.jsonl');
    writeFileSync(
      path,
      [...first.events, ...second.events].map((event) => JSON.stringify(event)).join('\n'),
    );
    const report = JSON.parse(
      execFileSync(process.execPath, ['scripts/summarize-traces.ts', path], { encoding: 'utf8' }),
    );
    expect(report.runs).toHaveLength(2);
    expect(report.runs.map((run: { committedTurns: number }) => run.committedTurns)).toEqual([
      1, 1,
    ]);
    expect(report.audibleOnsetMeasured).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
