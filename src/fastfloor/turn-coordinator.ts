type TurnState = 'LISTENING' | 'SPECULATING' | 'COMMITTED';

export class TurnCoordinator {
  private readonly publish: (text: string) => void;

  constructor(publish: (text: string) => void = (text) => console.log('Agent:', text)) {
    this.publish = publish;
  }

  private state: TurnState = 'LISTENING';

  // Holds a prepared answer until we're allowed to publish it.
  private prepared: string | null = null;

  private generation = 0; // id for llm when it started
  private controller: AbortController | null = null; // store controller for aborting
  // needed since onEager starts rq but onResume needs to cancel after. so they need access to same objcet since diff methods

  private hasPublished = false; // store publish state

  onEager(): number {
    this.controller?.abort(); // Cancel any previous work. Only call this if controller is defined

    this.controller = new AbortController();

    this.prepared = null;
    this.hasPublished = false;

    this.state = 'SPECULATING';

    // Increment this.generation.
    this.generation++;

    return this.generation;
  }

  async prepare(
    generation: number,
    generate: (signal: AbortSignal) => Promise<string>,
  ): Promise<void> {
    if (generation !== this.generation || !this.controller) {
      return;
    }

    const controller = this.controller;

    try {
      const result = await generate(controller.signal);
      this.onPrepared(result, generation);
    } catch (error) {
      if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') {
        return; // Expected cancellation
      }

      throw error; // Unexpected failure
    }
  }

  onResumed() {
    // Increment generation to invalidate old work.
    // Clear the prepared response.
    // Change the state back to LISTENING.
    this.generation++; // Invalidate old results
    this.controller?.abort(); // Cancel old work.  Only call this if controller is defined
    this.controller = null;
    this.prepared = null;
    this.state = 'LISTENING';
    this.hasPublished = false;
  }

  onPrepared(result: string, generation: number) {
    // If generation is not the current generation,
    // return immediately.
    if (
      generation !== this.generation || // check if passed generation (from answer) is outdated
      this.state === 'LISTENING' ||
      this.hasPublished
    ) {
      return;
    }

    this.prepared = result;
    this.tryPublish();
  }

  onCommitted(generation: number) {
    if (generation !== this.generation) {
      return;
    }
    this.state = 'COMMITTED';
    this.tryPublish();
  }

  private tryPublish() {
    // Check that state is COMMITTED
    // AND prepared is not null.
    if (this.state !== 'COMMITTED' || this.prepared === null || this.hasPublished) {
      // if conds not met
      return;
    }

    // If both conditions pass:
    // Print "Agent:" followed by the prepared response.
    this.publish(this.prepared);

    // Set prepared to null after publishing.
    // This prevents the same answer being published twice.
    this.prepared = null;
    this.hasPublished = true;
  }
}
