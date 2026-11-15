/**
 * Runs each profile's lifecycle operations one at a time, in call order.
 * Different profiles never wait on each other. A failed operation does not
 * stop the ones queued behind it.
 */
export class ProfileQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.#tails.get(profileId) ?? Promise.resolve()).then(
      operation,
    );
    const tail = result.then(
      () => {},
      () => {},
    );
    this.#tails.set(profileId, tail);
    void tail.then(() => {
      if (this.#tails.get(profileId) === tail) this.#tails.delete(profileId);
    });
    return result;
  }

  /** Profiles with an operation queued or running. */
  busy(): string[] {
    return [...this.#tails.keys()];
  }
}
