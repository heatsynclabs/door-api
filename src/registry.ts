// Builds the controller adapters from config and wraps each in (1) a per-controller
// mutex and (2) a circuit breaker. The mutex matters because the legacy Arduino is
// a single-client HTTP server: two overlapping requests interleave or fail, so all
// calls to one controller are serialized. Routes go through `controller.run()`.
import type { Config } from './config.js'
import type { ControllerAdapter } from './domain.js'
import { type Guard, makeGuard } from './circuit.js'
import { MemoryAdapter } from './adapters/memory.js'
import { OpenAccessAdapter } from './adapters/openaccess.js'
import { UhppoteAdapter } from './adapters/uhppote.js'

// Minimal async mutex: chains thunks so only one runs at a time, errors isolated.
class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(thunk: () => Promise<T>): Promise<T> {
    const result = this.tail.then(thunk, thunk)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

export class Controller {
  private readonly mutex = new Mutex()

  constructor(
    readonly adapter: ControllerAdapter,
    private readonly guard: Guard
  ) {}

  get id(): string {
    return this.adapter.id
  }

  // Serialize per controller, then run through the circuit breaker.
  run<T>(thunk: () => Promise<T>): Promise<T> {
    return this.mutex.run(() => this.guard.run(thunk))
  }

  circuitState(): string {
    return this.guard.state().state
  }
}

export class Registry {
  private readonly controllers = new Map<string, Controller>()

  constructor(config: Config, adapters?: ControllerAdapter[]) {
    const built = adapters ?? buildAdapters(config)
    for (const adapter of built) {
      this.controllers.set(adapter.id, new Controller(adapter, makeGuard(adapter.id, config.circuit)))
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

function buildAdapters(config: Config): ControllerAdapter[] {
  return config.controllers.map((cfg) => {
    switch (cfg.driver) {
      case 'uhppote':
        return new UhppoteAdapter(cfg, config.uhppote, config.timeouts.hardware)
      case 'openaccess':
        return new OpenAccessAdapter(cfg, config.timeouts.hardware)
      case 'memory':
        return new MemoryAdapter(cfg)
      default:
        throw new Error(`unknown driver for controller "${cfg.id}"`)
    }
  })
}
