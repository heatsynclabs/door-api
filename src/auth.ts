// API-key authentication with three scopes: `readonly` (status and reads),
// `door` (also door actions and the alarm) and `full` (also cards and the event
// log). Keys come from API_KEYS (see parseApiKeys in config.ts). The key's name
// is kept on the request for the audit trail.
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { ApiKey, Scope } from './config.js'

const RANK: Record<Scope, number> = { readonly: 1, door: 2, full: 3 }

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKey
  }
}

export function makeRequire(apiKeys: Map<string, ApiKey>) {
  return function requireScope(required: Scope): preHandlerHookHandler {
    return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers.authorization ?? ''
      const match = /^Bearer\s+(.+)$/i.exec(header)
      const key = match?.[1]?.trim()
      const found = key ? apiKeys.get(key) : undefined

      if (!found) {
        request.log.warn({ event: 'auth_failed', ip: request.ip, path: request.routeOptions.url })
        return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid API key' })
      }
      request.apiKey = found
      // An unknown scope ranks 0: refused, never allowed by accident.
      if ((RANK[found.scope] ?? 0) < RANK[required]) {
        request.log.warn({ event: 'auth_forbidden', ip: request.ip, path: request.routeOptions.url, key: found.name })
        return reply.code(403).send({ error: 'forbidden', message: `this operation requires the "${required}" scope` })
      }
      return undefined
    }
  }
}

export type RequireFn = ReturnType<typeof makeRequire>
