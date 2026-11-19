// Typed errors adapters throw and the route/error layer maps to HTTP codes.
// Messages never include a controller URL: a board URL can carry its password.
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

// The controller did not answer (network, timeout). The only error the circuit
// breaker counts.
export class Unreachable extends DoorApiError {
  constructor(message = 'controller is not answering') {
    super(503, message, 'controller_unreachable')
  }
}

// The controller answered, but not with what the command should produce.
export class BadReply extends DoorApiError {
  constructor(message = 'controller gave an unexpected reply') {
    super(502, message, 'controller_bad_reply')
  }
}

// The board refused the password. Privileged calls to that board are stopped
// for a while (see OpenAccessAdapter), so one wrong password costs the board one
// failed login, never the five that lock it.
export class BoardAuthFailed extends DoorApiError {
  constructor(message = 'the board refused the password; privileged commands are paused') {
    super(503, message, 'board_auth_failed')
  }
}

export class CircuitOpen extends DoorApiError {
  constructor(message = 'controller temporarily unavailable (circuit open to protect it)') {
    super(503, message, 'circuit_open')
  }
}

// A door action that could not start promptly. It was never sent, so the door
// will not move late when nobody is there.
export class Busy extends DoorApiError {
  constructor(message = 'the controller is busy; the door action was not sent, try again') {
    super(503, message, 'busy')
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

export class NotSupported extends DoorApiError {
  constructor(message = 'this controller does not support that operation') {
    super(400, message, 'not_supported')
  }
}

export class ActionNotAllowed extends DoorApiError {
  constructor(message = 'that action is not allowed on this door') {
    super(403, message, 'action_not_allowed')
  }
}

export class CapacityFull extends DoorApiError {
  constructor(message = 'the controller has no free slot for another card') {
    super(409, message, 'capacity_full')
  }
}

export class DoorJobsOff extends DoorApiError {
  constructor(message = 'door jobs are off on this server (DOOR_JOBS=off): a real board only takes status, open, unlock and lock here') {
    super(409, message, 'door_jobs_off')
  }
}
