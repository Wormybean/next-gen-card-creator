// node:async_hooks for the add-on. The web server serves many visitors at once, each with
// their own key; the add-on has one user and one key, so a plain variable does the job.

export class AsyncLocalStorage<T> {
  private store: T | undefined;

  getStore(): T | undefined {
    return this.store;
  }

  run<R>(store: T, fn: () => R): R {
    this.store = store;
    return fn();
  }
}
