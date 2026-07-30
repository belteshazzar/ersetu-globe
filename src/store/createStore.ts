/**
 * Minimal external store, ~40 lines, zero dependencies.
 * Backed by React's useSyncExternalStore, so it is concurrent-safe.
 */

export type Listener = () => void

export type Store<S> = {
  getState: () => S
  setState: (patch: Partial<S> | ((prev: S) => Partial<S>)) => void
  subscribe: (listener: Listener) => () => void
}

export function createStore<S extends object>(initialState: S): Store<S> {
  let state = initialState
  const listeners = new Set<Listener>()

  const getState = () => state

  const setState: Store<S>['setState'] = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    let changed = false
    for (const key of Object.keys(next) as (keyof S)[]) {
      if (!Object.is(state[key], next[key])) {
        changed = true
        break
      }
    }
    if (!changed) return
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  const subscribe = (listener: Listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return { getState, setState, subscribe }
}
