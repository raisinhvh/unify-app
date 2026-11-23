/**
 * Concurrency queue for delegate tasks. The limit is read from the agents.maxParallel feature for
 * every new task, so raising or lowering it in Settings applies to the next task immediately.
 */
export class DelegateTaskQueue {
    private active = 0;
    private readonly waiting: (() => void)[] = [];

    public constructor(private readonly limit: () => number) {}

    /** Runs the task once a slot is free, in the order tasks were queued. */
    public async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    /** Tasks that are waiting for a slot, for status text. */
    public get queued(): number {
        return this.waiting.length;
    }

    private acquire(): Promise<void> {
        if (this.active < this.currentLimit()) {
            this.active += 1;
            return Promise.resolve();
        }
        return new Promise(resolve => {
            this.waiting.push(() => {
                this.active += 1;
                resolve();
            });
        });
    }

    private release(): void {
        this.active = Math.max(0, this.active - 1);
        // A raised limit can free several slots at once, so start every task that now fits.
        while (this.active < this.currentLimit()) {
            const next = this.waiting.shift();
            if (!next) break;
            next();
        }
    }

    private currentLimit(): number {
        const value = Math.floor(this.limit());
        return Number.isFinite(value) && value > 0 ? value : 1;
    }
}
