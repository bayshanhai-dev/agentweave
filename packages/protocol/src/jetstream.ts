import { AckPolicy, connect, RetentionPolicy, StorageType, type Consumer, type JetStreamClient, type JetStreamManager, type JsMsg, nanos, StringCodec } from "nats";

export const streamName = "AGENTWEAVE_EVENTS";
export const subjects = {
  events: "aw.workstream.*.events",
  inbox: "aw.agent.*.inbox",
  commands: "aw.workstream.*.commands",
  deadLetters: "aw.dead-letter.*",
} as const;

export type JetStreamEnvelope = { id: string; type: string; workstreamId: string; occurredAt: string; payload: unknown; correlationId?: string; causationId?: string };
export type JetStreamConfig = { url: string; stream?: string; durableName?: string };

export class JetStreamEventBus {
  private connection?: Awaited<ReturnType<typeof connect>>;
  private manager?: JetStreamManager;
  private client?: JetStreamClient;
  private readonly codec = StringCodec();
  private readonly stream: string;
  constructor(private readonly config: JetStreamConfig) { this.stream = config.stream ?? streamName; }

  async connect(): Promise<void> {
    this.connection = await connect({ servers: this.config.url });
    this.manager = await this.connection.jetstreamManager();
    this.client = this.connection.jetstream();
    try {
      const info = await this.manager.streams.info(this.stream);
      const configuredSubjects = new Set(info.config.subjects ?? []);
      const requiredSubjects = Object.values(subjects);
      if (requiredSubjects.some((subject) => !configuredSubjects.has(subject))) {
        await this.manager.streams.update(this.stream, { ...info.config, subjects: [...new Set([...configuredSubjects, ...requiredSubjects])] });
      }
    } catch { await this.manager.streams.add({ name: this.stream, subjects: Object.values(subjects), storage: StorageType.File, retention: RetentionPolicy.Limits }); }
  }

  async publish(subject: string, envelope: JetStreamEnvelope): Promise<void> {
    if (!this.client) throw new Error("JetStreamEventBus is not connected");
    await this.client.publish(subject, this.codec.encode(JSON.stringify(envelope)), { msgID: envelope.id });
  }

  async consumer(filterSubject: string, handler: (message: JsMsg) => Promise<"ack" | "retry" | "dead-letter">): Promise<Consumer> {
    if (!this.manager || !this.client) throw new Error("JetStreamEventBus is not connected");
    const durable = this.config.durableName ?? `worker-${filterSubject.replaceAll(".", "-").replaceAll("*", "all")}-v2`;
    const desired = { durable_name: durable, filter_subject: filterSubject, ack_policy: AckPolicy.Explicit, ack_wait: nanos(30_000), max_deliver: 5 } as const;
    try { await this.manager.consumers.info(this.stream, durable); await this.manager.consumers.update(this.stream, durable, desired); }
    catch { await this.manager.consumers.add(this.stream, desired); }
    const consumer = await this.client.consumers.get(this.stream, durable);
    const subscription = await consumer.consume();
    void (async () => { for await (const message of subscription) { const outcome = await handler(message); if (outcome === "ack") message.ack(); else if (outcome === "retry") message.nak(); else { await this.publish(subjects.deadLetters.replace("*", this.stream), { id: message.info.streamSequence.toString(), type: "dead-letter", workstreamId: "unknown", occurredAt: new Date().toISOString(), payload: this.codec.decode(message.data) }); message.term(); } } })();
    return consumer;
  }

  decode(message: JsMsg): JetStreamEnvelope { return JSON.parse(this.codec.decode(message.data)) as JetStreamEnvelope; }
  async close(): Promise<void> { await this.connection?.drain(); }
}
