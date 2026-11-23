/** Minimal VS Code event primitives for the Unify shim. */

export class Disposable {
  private disposed = false;
  private readonly callback: () => void;

  public constructor(callback: () => void) {
    this.callback = callback;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.callback();
  }

  public static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => {
      for (const item of items) item.dispose();
    });
  }
}

export interface Event<T> {
  (listener: (value: T) => void, thisArgs?: unknown, disposables?: Disposable[]): Disposable;
}

export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();
  public readonly event: Event<T> = (listener, _thisArgs, disposables) => {
    this.listeners.add(listener);
    const subscription = new Disposable(() => this.listeners.delete(listener));
    if (disposables) disposables.push(subscription);
    return subscription;
  };

  public fire(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch (error) {
        console.error('[unify] event listener failed', error);
      }
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

export type Thenable<T> = PromiseLike<T>;
