import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnCoordinator } from './turn-coordinator.ts';

afterEach(() => vi.restoreAllMocks());

describe('TurnCoordinator', () => {
  function setup() {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const coordinator = new TurnCoordinator();
    return { coordinator, log };
  }

  it('never publishes before commitment', () => {
    const { coordinator, log } = setup();
    const gen = coordinator.onEager();

    coordinator.onPrepared('Early answer', gen);
    expect(log).not.toHaveBeenCalled();

    coordinator.onCommitted(gen);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Agent:', 'Early answer');
  });

  it('works when commitment happens before preparation', () => {
    const { coordinator, log } = setup();
    const gen = coordinator.onEager();

    coordinator.onCommitted(gen);
    expect(log).not.toHaveBeenCalled();

    coordinator.onPrepared('Late answer', gen);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('discards old results after resumed speech', () => {
    const { coordinator, log } = setup();

    const oldGen = coordinator.onEager();
    coordinator.onResumed();
    const newGen = coordinator.onEager();

    coordinator.onPrepared('Old answer', oldGen);
    coordinator.onPrepared('New answer', newGen);
    coordinator.onCommitted(newGen);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Agent:', 'New answer');
  });

  it('publishes at most once per turn', () => {
    const { coordinator, log } = setup();
    const gen = coordinator.onEager();

    coordinator.onCommitted(gen);
    coordinator.onPrepared('First answer', gen);
    coordinator.onPrepared('Duplicate answer', gen);
    coordinator.onCommitted(gen);

    expect(log).toHaveBeenCalledTimes(1);
  });

  it('requests cancellation when the user resumes', async () => {
    const { coordinator, log } = setup();
    const gen = coordinator.onEager();

    let receivedSignal: AbortSignal | undefined;

    const task = coordinator.prepare(gen, async (signal) => {
      receivedSignal = signal;

      return new Promise<string>((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Cancelled', 'AbortError'));
          },
          { once: true },
        );
      });
    });

    coordinator.onResumed();

    expect(receivedSignal?.aborted).toBe(true);

    await task;
    expect(log).not.toHaveBeenCalled();
  });

  it('rejects a result even when cancellation is ignored', async () => {
    const { coordinator, log } = setup();

    let finishOld!: (value: string) => void;

    const oldGen = coordinator.onEager();

    const oldTask = coordinator.prepare(oldGen, async () => {
      return new Promise<string>((resolve) => {
        finishOld = resolve;
      });
    });

    coordinator.onResumed();
    const newGen = coordinator.onEager();
    coordinator.onCommitted(newGen);

    // The old provider ignores abort and still returns.
    finishOld('Stale response');
    await oldTask;

    expect(log).not.toHaveBeenCalled();

    coordinator.onPrepared('Correct response', newGen);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Agent:', 'Correct response');
  });

  it('rejects a late commitment from an invalidated turn', () => {
    const { coordinator, log } = setup();

    const oldGen = coordinator.onEager();
    coordinator.onResumed();
    const newGen = coordinator.onEager();

    coordinator.onPrepared('New answer', newGen);
    coordinator.onCommitted(oldGen);

    expect(log).not.toHaveBeenCalled();

    coordinator.onCommitted(newGen);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
