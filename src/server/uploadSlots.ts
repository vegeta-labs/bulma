// How many uploads or downloads may be in flight, counted before a file is held in memory, so slow or unfinished ones cannot fill it.
export class UploadSlots {
  private readonly perUser: number
  private readonly overall: number
  private readonly held = new Map<string, number>()
  private total = 0
  constructor(perUser = 2, overall = 8) {
    this.perUser = perUser
    this.overall = overall
  }
  take(user: string): boolean {
    const mine = this.held.get(user) ?? 0
    if (mine >= this.perUser || this.total >= this.overall) return false
    this.held.set(user, mine + 1)
    this.total++
    return true
  }
  give(user: string): void {
    const mine = this.held.get(user) ?? 0
    if (mine === 0) return
    if (mine === 1) this.held.delete(user)
    else this.held.set(user, mine - 1)
    this.total--
  }
}

interface HoldRequest {
  raw: { destroy(): void }
}
interface HoldReply {
  raw: { once(event: 'close', fn: () => void): unknown }
  code(n: number): { send(body: unknown): unknown }
}

/** A slot held from before the body is read until the work on it ends, however the request goes. */
export class UploadHolds {
  private readonly slots: UploadSlots
  private readonly deadlineMs: number
  private readonly held = new WeakMap<object, { who: string; bytes: number; timer: NodeJS.Timeout; working: boolean; gone: boolean }>()
  private readonly budget: number
  private inFlight = 0
  constructor(deadlineMs = 120_000, perUser = 2, overall = 8, budgetBytes = Number.POSITIVE_INFINITY) {
    this.deadlineMs = deadlineMs
    this.budget = budgetBytes
    this.slots = new UploadSlots(perUser, overall)
  }
  private free(req: object) {
    const h = this.held.get(req)
    if (!h) return
    this.held.delete(req)
    clearTimeout(h.timer)
    this.inFlight -= h.bytes
    this.slots.give(h.who)
  }
  /** False when none is free. A body that never finishes loses its connection at the deadline, and the slot comes back. */
  hold(req: HoldRequest, reply: HoldReply, who: string, bytes = 0): boolean {
    if (this.inFlight + bytes > this.budget || !this.slots.take(who)) return false
    this.inFlight += bytes
    const timer = setTimeout(() => req.raw.destroy(), this.deadlineMs)
    timer.unref()
    const slot = { who, bytes, timer, working: false, gone: false }
    this.held.set(req, slot)
    reply.raw.once('close', () => {
      slot.gone = true
      if (!slot.working) this.free(req)
    })
    return true
  }
  /** Runs the work under the slot. With `who`, takes one first, for a route that had no earlier hook to hold it in. */
  async work<T>(req: HoldRequest, reply: HoldReply, fn: () => Promise<T>, who?: string, bytes = 0): Promise<T | unknown> {
    if (who !== undefined && !this.hold(req, reply, who, bytes)) return reply.code(429).send({ error: 'too many at once, try again in a moment' })
    const slot = this.held.get(req)
    if (!slot) return reply.code(400).send({ error: 'the connection went before this was read' })
    slot.working = true
    try {
      return await fn()
    } finally {
      slot.working = false
      if (slot.gone) this.free(req)
    }
  }
}
