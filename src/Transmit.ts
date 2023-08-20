import { v5 as randomUUID } from 'uuid'
import Emittery from 'emittery'
import { HttpContextContract } from '@ioc:Adonis/Core/HttpContext'
import { Stream } from './Stream'
import { StorageBag } from './storage_bag'
import { SecureChannelStore } from './secure_channel_store'
import { TransmitConfig, TransmitContract, Transport } from '@ioc:Adonis/Addons/Transmit'

interface TransmitHooks {
  connect: { uid: string }
  disconnect: { uid: string }
  broadcast: { channel: string; payload: Record<string, unknown> }
  subscribe: { uid: string; channel: string }
  unsubscribe: { uid: string; channel: string }
}

export default class Transmit extends Emittery<TransmitHooks> implements TransmitContract {
  /**
   * The unique id for the transmit instance.
   */
  #id: string

  /**
   * The storage bag instance to store all the streams.
   */
  #storage: StorageBag

  /**
   * The secure channel store instance to store all the secure channel definitions.
   */
  #secureChannelStore: SecureChannelStore

  /**
   * The secure channel store instance to store all the secure channel callbacks.
   */
  #secureChannelCallbacks: Map<
    string,
    (ctx: HttpContextContract, params?: any) => Promise<boolean>
  > = new Map()

  #transport: Transport | null

  #config: TransmitConfig

  constructor(config: TransmitConfig, transport: Transport | null) {
    super()

    this.#id = randomUUID()
    this.#config = config
    this.#storage = new StorageBag()
    this.#secureChannelStore = new SecureChannelStore()
    this.#transport = transport

    // @ts-ignore
    void this.#transport?.subscribe(this.#config.transport.channel, (message) => {
      const { channel, payload, from } = JSON.parse(message)

      void this.broadcast(channel, payload, true, from)
    })
  }

  /**
   * Creates and register a new stream for the given request and pipes it to the response.
   */
  public createStream(ctx: HttpContextContract): void {
    const stream = new Stream(ctx.request.input('uid'), ctx.request.request)
    stream.pipe(ctx.response.response)
    void this.emit('connect', { uid: stream.getUid() })
    this.#storage.push(stream)

    ctx.response.response.on('close', () => {
      void this.emit('disconnect', { uid: stream.getUid() })
      this.#storage.remove(stream)
    })

    ctx.response.stream(stream)
  }

  /**
   * Store the authorization callback for the given channel.
   */
  public authorizeChannel<T = undefined>(
    channel: string,
    callback: (ctx: HttpContextContract, params: T) => Promise<boolean>
  ) {
    this.#secureChannelStore.add(channel)
    this.#secureChannelCallbacks.set(channel, callback)
  }

  public async subscribeToChannel(
    uid: string,
    channel: string,
    ctx: HttpContextContract
  ): Promise<boolean> {
    const definitions = this.#secureChannelStore.match(channel)

    if (definitions) {
      const callback = this.#secureChannelCallbacks.get(definitions.url)

      if (!callback) {
        return false
      }

      const result = await callback(ctx, definitions.params)

      if (!result) {
        return false
      }
    }

    void this.emit('subscribe', { uid, channel })
    return this.#storage.addChannelToStream(uid, channel)
  }

  public unsubscribeFromChannel(uid: string, channel: string): boolean {
    void this.emit('unsubscribe', { uid, channel })
    return this.#storage.removeChannelFromStream(uid, channel)
  }

  public async broadcast(
    channel: string,
    payload: Record<string, unknown>,
    internal = false,
    from?: string
  ) {
    if (from === this.#id) {
      return
    }
    const subscribers = this.#storage.findByChannel(channel)

    for (const subscriber of subscribers) {
      subscriber.writeMessage({ data: { channel, payload } })
    }

    if (!internal) {
      // @ts-ignore
      void this.#transport?.send(this.#config.transport.channel, {
        channel,
        payload,
        from: this.#id,
      })
    }

    void this.emit('broadcast', { channel, payload })
  }
}
