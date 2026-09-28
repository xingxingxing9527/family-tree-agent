export interface WorkspaceExclusiveLease {
  release(): void;
}

type ExclusiveRequest = (lease: WorkspaceExclusiveLease) => void;

export class WorkspaceMutationGate {
  private activeMutations = 0;
  private exclusiveActive = false;
  private readonly exclusiveQueue: ExclusiveRequest[] = [];
  private readonly mutationWaiters: Array<() => void> = [];

  async runMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    await this.enterMutation();
    try {
      return await operation();
    } finally {
      this.activeMutations -= 1;
      this.pump();
    }
  }

  acquireExclusive(): Promise<WorkspaceExclusiveLease> {
    return new Promise((resolve) => {
      this.exclusiveQueue.push(resolve);
      this.pump();
    });
  }

  private async enterMutation(): Promise<void> {
    while (this.exclusiveActive || this.exclusiveQueue.length > 0) {
      await new Promise<void>((resolve) => this.mutationWaiters.push(resolve));
    }
    this.activeMutations += 1;
  }

  private pump(): void {
    if (this.exclusiveActive) return;
    if (this.exclusiveQueue.length > 0) {
      if (this.activeMutations !== 0) return;
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
