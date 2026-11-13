// Entry point: load and validate config, build the server, listen, and shut down
// cleanly. A bad config stops the process before it ever opens a port.
import { loadConfig } from './config.js'
import { buildServer } from './server.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const app = await buildServer({ config })

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info(`${signal} received, shutting down`)
      app.close().then(
        () => process.exit(0),
        () => process.exit(1)
      )
    })
  }

  await app.listen({ host: config.host, port: config.port })
}

main().catch((err) => {
  console.error('failed to start door-api:', err instanceof Error ? err.message : err)
  process.exit(1)
})
