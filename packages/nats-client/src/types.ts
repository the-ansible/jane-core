import type { NatsConnection, JetStreamClient, JsMsg } from 'nats';

/** Identity of the service using this NATS client — baked into every publishEvent() call */
export interface SenderIdentity {
  id: string;
  displayName?: string;
  type: 'person' | 'system' | 'agent' | 'channel' | 'group';
}

export interface NatsClientOptions {
  /** NATS server URL. Default: nats://life-system-nats:4222 */
  url?: string;
  /** Service name — used for logging and reconnect identification */
  name: string;
  /** Mandatory sender identity — auto-injected into every publishEvent() call */
  sender: SenderIdentity;
  /** Enable JetStream. Default: true */
  useJetStream?: boolean;
}

/** The public interface of the shared NATS client */
export interface NatsClient {
  /** Underlying NATS connection */
  nc: NatsConnection;
  /** JetStream client (null if useJetStream was false) */
  js: JetStreamClient | null;
  /** The sender identity configured for this client */
  sender: SenderIdentity;
  /** Check if the connection is alive */
  isConnected(): boolean;
  /** Publish a CommunicationEvent — validates against schema, auto-injects sender */
  publishEvent(subject: string, event: Record<string, unknown>): Promise<void>;
  /** Publish raw data to any NATS subject (heartbeats, job results, etc.) — no schema validation */
  publish(subject: string, data: unknown): Promise<void>;
  /** Drain and close the connection */
  close(): Promise<void>;
}
