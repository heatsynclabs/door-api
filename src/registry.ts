// Builds the controller adapters from config and wraps each in (1) a per-controller
// queue and (2) a circuit breaker. The queue matters because the legacy Arduino
// answers one request at a time and keeps a single login state: overlapping
// requests interleave or log each other out, so all calls to one controller are
// serialized. Routes go through `controller.run()`.
import type { Config, ControllerConfig, DoorAction } from './config.js'
import type { ControllerAdapter } from './domain.js'
import { type Guard, makeGuard } from './circuit.js'
import { Busy } from './errors.js'
import { MemoryAdapter } from './adapters/memory.js'
import { OpenAccessAdapter } from './adapters/openaccess.js'
import { UhppoteAdapter } from './adapters/uhppote.js'

// A FIFO queue. With a deadline, a call that has not started by then is dropped
// (Busy) and never runs: a door must not open late, after the person who asked
// has given up and walked away. Calls without a deadline (locks, card writes)
// always wait their turn.
export class Queue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(thunk: () => Promise<T>, deadlineMs?: number): Promise<T> {
    const prev = this.tail
    let release!: () => void
    this.tail = new Promise<void>((r) => (release = r))
    return new Promise<T>((resolve, reject) => {
      let expired = false
      const timer =
        deadlineMs == null
          ? undefined
          : setTimeout(() => {
              expired = true
              reject(new Busy())
            }, deadlineMs)
      void prev.then(async () => {
        if (timer) clearTimeout(timer)
        if (expired) return release()
        try {
          resolve(await thunk())
        } catch (err) {
          reject(err)
        } finally {
          release()
        }
      })
    })
  }
}

export class Controller {
  private readonly queue = new Queue()

  constructor(
    readonly adapter: ControllerAdapter,
    private readonly guard: Guard,
    // A simulator or bench board rather than a real door.
    readonly sandbox = false,
    private readonly policy: Partial<Record<string, DoorAction[]>> = {}
  ) {}

  get id(): string {
    return this.adapter.id
  }

  // Serialize per controller, then run through the circuit breaker.
  run<T>(thunk: () => Promise<T>, opts: { deadlineMs?: number } = {}): Promise<T> {
    return this.queue.run(() => this.guard.run(thunk), opts.deadlineMs)
  }

  // Whether this door takes this action (config "actions"; unlisted doors take all).
  allows(door: number, action: DoorAction): boolean {
    const allowed = this.policy[String(door)]
    return allowed == null || allowed.includes(action)
  }

  circuitState(): string {
    return this.guard.state().state
  }
}

export class Registry {
  private readonly controllers = new Map<string, Controller>()

  constructor(config: Config, adapters?: ControllerAdapter[], warn: Warn = () => undefined) {
    const built = adapters ?? buildAdapters(config, warn)
    const byId = new Map<string, ControllerConfig>(config.controllers.map((c) => [c.id, c]))
    for (const adapter of built) {
      const cfg = byId.get(adapter.id)
      const sandbox = adapter.driver === 'memory' || cfg?.sandbox === true
      this.controllers.set(
        adapter.id,
        new Controller(adapter, makeGuard(adapter.id, config.circuit), sandbox, cfg?.actions ?? {})
      )
    }
  }

  get(id: string): Controller | undefined {
    return this.controllers.get(id)
  }

  all(): Controller[] {
    return [...this.controllers.values()]
  }

  ids(): string[] {
    return [...this.controllers.keys()]
  }
}

type Warn = (message: string, detail: Record<string, unknown>) => void

function buildAdapters(config: Config, warn: Warn): ControllerAdapter[] {
  return config.controllers.map((cfg) => {
    switch (cfg.driver) {
      case 'uhppote':
        return new UhppoteAdapter(cfg, config.uhppote, config.timeouts.hardware)
      case 'openaccess':
        return new OpenAccessAdapter(cfg, { timeoutMs: config.timeouts.hardware, authPauseMs: config.authPauseMs, onWarn: warn })
      case 'memory':
        return new MemoryAdapter(cfg)
      default:
        throw new Error(`unknown driver for controller "${cfg.id}"`)
    }
  })
}
