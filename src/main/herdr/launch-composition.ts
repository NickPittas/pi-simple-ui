import { createHash } from 'node:crypto'
import type { LaunchChannel, IssuedLaunchToken } from '../security/launch-channel.ts'
import { createLaunchChannel } from '../security/launch-channel.ts'
import type { RuntimeLaunchPolicy } from '../security/launch-policy.ts'
import type { RuntimeScope } from '../../shared/ipc-contracts.ts'
import type { WorkerRegistry } from '../workers/worker-registry.ts'
import { HerdrChildLaunchService } from './child-launch.ts'
import { HerdrChildSessionObserver } from '../workers/child-session-observer.ts'

export interface HerdrLaunchRuntimeOptions {
  readonly channel?: LaunchChannel
  readonly registry: WorkerRegistry
  readonly scope: RuntimeScope
  readonly getLaunchPolicy: (scope: RuntimeScope) => RuntimeLaunchPolicy | undefined
}

export interface HerdrLaunchRuntime {
  readonly service?: HerdrChildLaunchService
  readonly observer: HerdrChildSessionObserver
  dispose(): void
}

/** Runtime facade revokes every token issued during its generation without closing the app channel. */
class RuntimeLaunchChannel implements LaunchChannel {
  readonly endpoint: string
  private readonly parent: LaunchChannel
  private readonly issued = new Set<IssuedLaunchToken>()
  private closed = false

  constructor(parent: LaunchChannel) {
    this.parent = parent
    this.endpoint = parent.endpoint
  }

  issue(descriptor: Parameters<LaunchChannel['issue']>[0], isRevoked?: () => boolean): IssuedLaunchToken {
    if (this.closed) throw new Error('The workspace launch channel is closed.')
    const token = this.parent.issue(descriptor, () => this.closed || isRevoked?.() === true)
    this.issued.add(token)
    let revoked = false
    return {
      token: token.token,
      endpoint: token.endpoint,
      revoke: () => {
        if (revoked) return
        revoked = true
        this.issued.delete(token)
        token.revoke()
      },
    }
  }

  async close(): Promise<void> {
    this.revokeAll()
  }

  revokeAll(): void {
    if (this.closed) return
    this.closed = true
    for (const token of this.issued) token.revoke()
    this.issued.clear()
  }
}

/** Launch-channel key/socket are app-owned; observers and issued capabilities are runtime-owned. */
export class HerdrLaunchChannelOwner {
  private readonly channelReady: Promise<LaunchChannel | undefined>
  private disposed = false

  constructor() {
    this.channelReady = createLaunchChannel().catch(() => undefined)
  }

  async createRuntime(options: Omit<HerdrLaunchRuntimeOptions, 'channel'>): Promise<HerdrLaunchRuntime> {
    if (this.disposed) throw new Error('The Herdr launch channel owner is disposed.')
    const channel = await this.channelReady
    if (this.disposed) throw new Error('The Herdr launch channel owner is disposed.')
    return createHerdrLaunchRuntime({ ...options, ...(channel ? { channel } : {}) })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const channel = await this.channelReady
    await channel?.close()
  }
}

export function createHerdrLaunchRuntime(options: HerdrLaunchRuntimeOptions): HerdrLaunchRuntime {
  const observer = new HerdrChildSessionObserver({ registry: options.registry, scope: options.scope })
  const launchObserver = {
    registerLaunch: (input: Parameters<HerdrChildSessionObserver['registerLaunch']>[0]) => observer.registerLaunch({
      ...input,
      // ChildLaunch derives this value from the bearer token; keep only an opaque lookup key in worker IDs.
      tokenId: createHash('sha256').update(input.tokenId).digest('hex').slice(0, 40),
    }),
    workerIdForPane: (paneId: string) => observer.workerIdForPane(paneId),
    receiveReport: (request: Parameters<HerdrChildSessionObserver['receiveReport']>[0]) => observer.receiveReport(request),
  } as unknown as HerdrChildSessionObserver
  const scopedChannel = options.channel ? new RuntimeLaunchChannel(options.channel) : undefined
  const service = scopedChannel
    ? new HerdrChildLaunchService({
        channel: scopedChannel,
        getLaunchPolicy: options.getLaunchPolicy,
        getWorkerRegistry: () => options.registry,
        childSessionObserver: launchObserver,
      })
    : undefined
  let disposed = false

  return {
    ...(service ? { service } : {}),
    observer,
    dispose(): void {
      if (disposed) return
      disposed = true
      scopedChannel?.revokeAll()
      // The observer marks native children detached and never stops or closes them.
      observer.dispose()
    },
  }
}
