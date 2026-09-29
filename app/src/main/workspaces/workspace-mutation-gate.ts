export interface WorkspaceExclusiveLease {
  release(): void;
}

type ExclusiveRequest = (lease: WorkspaceExclusiveLease) => void;

export class WorkspaceMutationGate {
  private activeOperations = 0;
  private exclusiveActive = false;
  private readonly exclusiveQueue: ExclusiveRequest[] = [];
  private readonly mutationWaiters: Array<() => void> = [];

  async runOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.enterOperation();
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      this.pump();
    }
  }

  runMutation<T>(operation: () => T | Promise<T>): Promise<T> { return this.runOperation(operation); }

  acquireExclusive(): Promise<WorkspaceExclusiveLease> {
    return new Promise((resolve) => {
      this.exclusiveQueue.push(resolve);
      this.pump();
    });
  }

  private async enterOperation(): Promise<void> {
    while (this.exclusiveActive || this.exclusiveQueue.length > 0) {
      await new Promise<void>((resolve) => this.mutationWaiters.push(resolve));
    }
    this.activeOperations += 1;
  }

  private pump(): void {
    if (this.exclusiveActive) return;
    if (this.exclusiveQueue.length > 0) {
      if (this.activeOperations !== 0) return;
      this.exclusiveActive = true;
      const grant = this.exclusiveQueue.shift()!;
      let released = false;
      grant({
        release: () => {
          if (released) return;
          released = true;
          this.exclusiveActive = false;
          this.pump();
        }
      });
      return;
    }
    const waiters = this.mutationWaiters.splice(0);
    for (const wake of waiters) wake();
  }
}
