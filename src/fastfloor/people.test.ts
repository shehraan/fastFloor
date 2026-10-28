import { llm } from '@livekit/agents';
import { expect, it } from 'vitest';
import { createAgent } from '../agent.ts';
import { findPeople, profiles } from './people.ts';

it('adds only the read-only tool in opt-in workload mode and preserves the baseline prompt', () => {
  class NoNetworkLLM extends llm.LLM {
    override label() {
      return 'no-network';
    }
    override chat(): llm.LLMStream {
      throw new Error('No remote calls in factory test');
    }
  }
  const model = new NoNetworkLLM();
  const baseline = createAgent(undefined, { model });
  const boardy = createAgent(undefined, { boardy: true, model });
  expect(baseline.toolCtx.flatten()).toHaveLength(0);
  expect(boardy.toolCtx.flatten().map((tool) => tool.id)).toEqual(['find_people']);
  expect(String(boardy.instructions)).toContain(String(baseline.instructions));
  expect(String(boardy.instructions)).toContain('fictional directory');
});

it('contains eighteen unique fictional profiles and intersects structured filters', () => {
  expect(profiles).toHaveLength(18);
  expect(new Set(profiles.map((profile) => profile.id)).size).toBe(18);
  const result = findPeople({ city: ' bOsToN ', role: 'founder', topic: 'robotics', limit: 3 });
  expect(result.fictional).toBe(true);
  expect(result.people.map((person) => person.name)).toEqual(['Maya Chen']);
});

it('returns explicit no matches and caps results without mutating the catalog', () => {
  const snapshot = JSON.stringify(profiles);
  expect(findPeople({ city: 'Atlantis', role: null, topic: null, limit: 3 })).toMatchObject({
    status: 'no_matches',
    people: [],
  });
  expect(findPeople({ city: null, role: null, topic: null, limit: 2 }).people).toHaveLength(2);
  const result = findPeople({ city: null, role: null, topic: null, limit: 1 });
  result.people[0]!.name = 'changed output';
  expect(JSON.stringify(profiles)).toBe(snapshot);
});

it.each([0, 6, -1, 1.5])('rejects invalid limit %s at the execution boundary', (limit) => {
  expect(() => findPeople({ city: null, role: null, topic: null, limit })).toThrow();
});
