// API-key authentication with two tiers: `readonly` (status, cards, events) and
// `full` (everything, including opening doors and writing cards). Keys come from
// the API_KEYS env var as `key:permission` pairs.
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Permission } from './config.js'

const RANK: Record<Permission, number> = { readonly: 1, full: 2 }

export function makeRequire(apiKeys: Map<string, Permission>) {
  return function requirePermission(required: Permission): preHandlerHookHandler {
    return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
      const header = request.headers.authorization ?? ''
      const match = /^Bearer\s+(.+)$/i.exec(header)
      const key = match?.[1]?.trim()
      const perm = key ? apiKeys.get(key) : undefined

      if (!perm) {
        request.log.warn({ event: 'auth_failed', ip: request.ip, path: request.url })
        return reply.code(401).send({ error: 'unauthorized', message: 'missing or invalid API key' })
      }
      if (RANK[perm] < RANK[required]) {
        request.log.warn({ event: 'auth_forbidden', ip: request.ip, path: request.url, permission: perm })
        return reply.code(403).send({ error: 'forbidden', message: `this operation requires "${required}" permission` })
      }
      return undefined
    }
  }
}

export type RequireFn = ReturnType<typeof makeRequire>
