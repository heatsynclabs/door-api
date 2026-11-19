// A thin wrapper over opossum: one breaker per controller. Its job is to stop
// hammering a controller that is already failing (fast-fail with CircuitOpen once
// too many calls fail), and to report state for status. Per-call timeouts live in
// the adapters, so opossum's own timeout is disabled here. Only Unreachable (no
// answer) counts as a failure: a refused password, a bad request or a policy
// refusal says nothing about whether the board is up.
import CircuitBreaker from 'opossum'
import { CircuitOpen, Unreachable } from './errors.js'

export interface GuardConfig {
  enabled: boolean
  errorThresholdPercentage: number
  resetTimeout: number
  volumeThreshold: number
}

export interface Guard {
  run<T>(thunk: () => Promise<T>): Promise<T>
  state(): { state: 'closed' | 'open' | 'half-open' | 'disabled'; enabled: boolean }
}

export function makeGuard(name: string, cfg: GuardConfig): Guard {
  if (!cfg.enabled) {
    return {
      run: (thunk) => thunk(),
      state: () => ({ state: 'disabled', enabled: false })
    }
  }

  const breaker = new CircuitBreaker((thunk: () => Promise<unknown>) => thunk(), {
    name,
    timeout: false, // adapters own their timeouts
    errorThresholdPercentage: cfg.errorThresholdPercentage,
    resetTimeout: cfg.resetTimeout,
    volumeThreshold: cfg.volumeThreshold,
    // true = do not count this error as a failure
    errorFilter: (err: unknown) => !(err instanceof Unreachable)
  })

  return {
    async run<T>(thunk: () => Promise<T>): Promise<T> {
      if (breaker.opened) throw new CircuitOpen()
      try {
        return (await breaker.fire(thunk)) as T
      } catch (err) {
        if (breaker.opened && err instanceof Unreachable) throw new CircuitOpen()
        throw err
      }
    },
    state: () => ({
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      enabled: true
    })
  }
}
