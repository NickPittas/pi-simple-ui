import type {
  SessionRecoveryDiagnostic,
  SessionsHistoryResponse,
  SessionsListResponse,
} from '../../shared/sessions.ts'
import {
  SessionStore,
  type SessionStartupRecovery,
  type SessionStoreContext,
} from './session-store.ts'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

/** Volatile metadata projection over Pi's authoritative native session files. */
export class SessionIndex {
  private diagnostics: readonly SessionRecoveryDiagnostic[] = []

  constructor(private readonly store: SessionStore = new SessionStore()) {}

  async list(context: SessionStoreContext): Promise<SessionsListResponse> {
    const report = await this.store.recover(context)
    this.diagnostics = report.diagnostics
    return report
  }

  async recoverStartup(context: SessionStoreContext): Promise<SessionStartupRecovery> {
    const recovery = await this.store.recoverStartup(context)
    this.diagnostics = recovery.diagnostics
    return recovery
  }

  async history(
    context: SessionStoreContext,
    sessionId: string,
    offset?: number,
    limit?: number,
  ): Promise<SessionsHistoryResponse> {
    return this.store.history(context, sessionId, offset, limit)
  }

  async open(context: SessionStoreContext, sessionId: string): Promise<SessionManager> {
    return this.store.open(sessionId, context)
  }

  getRecoveryDiagnostics(): readonly SessionRecoveryDiagnostic[] {
    return this.diagnostics
  }
}
