// Typed errors adapters throw and the route/error layer maps to HTTP codes.
export class DoorApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class Unreachable extends DoorApiError {
  constructor(message = 'controller is not answering') {
    super(503, message, 'controller_unreachable')
  }
}

export class CircuitOpen extends DoorApiError {
  constructor(message = 'controller temporarily unavailable (circuit open to protect it)') {
    super(503, message, 'circuit_open')
  }
}

export class NotFound extends DoorApiError {
  constructor(message = 'not found') {
    super(404, message, 'not_found')
  }
}

export class BadRequest extends DoorApiError {
  constructor(message = 'bad request') {
    super(400, message, 'bad_request')
  }
}

export class CapacityFull extends DoorApiError {
  constructor(message = 'the controller has no free slot for another card') {
    super(409, message, 'capacity_full')
  }
}
