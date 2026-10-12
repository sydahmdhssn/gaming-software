// Minimal EventEmitter for the in-browser demo build.
export class EventEmitter {
  #handlers = new Map();
  on(name, fn) {
    if (!this.#handlers.has(name)) this.#handlers.set(name, new Set());
    this.#handlers.get(name).add(fn);
    return this;
  }
  off(name, fn) {
    this.#handlers.get(name)?.delete(fn);
    return this;
  }
  emit(name, ...args) {
    for (const fn of this.#handlers.get(name) ?? []) fn(...args);
    return true;
  }
}
