//! The WebSocket connection to the session: MessagePack frames in and out,
//! with reconnection while the server is reachable.

import { decode, encode } from "@msgpack/msgpack";
import type { ClientMessage, ServerMessage, Snapshot, Welcome } from "./protocol";

export type Status = "connecting" | "connected" | "reconnecting" | "failed";

const PROTOCOL_VERSION = 1;

export class Net {
  private socket?: WebSocket;
  private closed = false;
  private retry = 0;
  private timer?: number;

  constructor(
    private readonly onWelcome: (welcome: Welcome) => void,
    private readonly onSnapshot: (snapshot: Snapshot) => void,
    private readonly onStatus: (status: Status, detail: string) => void,
    private readonly onPong?: (t: number) => void,
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    this.onStatus(this.retry === 0 ? "connecting" : "reconnecting", "connecting to the session");
    const socket = new WebSocket(`${scheme}//${location.host}/ws`);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.retry = 0;
      this.send({
        kind: "resize",
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.closed) return;
      this.socket = undefined;
      this.retry++;
      const detail = `the session closed the connection (retry ${this.retry})`;
      this.onStatus("reconnecting", detail);
      this.timer = window.setTimeout(() => this.open(), Math.min(1000 * this.retry, 5000));
    };
  }

  private receive(data: unknown): void {
    if (data instanceof Blob) {
      void data.arrayBuffer().then((buffer) => this.receive(buffer));
      return;
    }
    if (!(data instanceof ArrayBuffer)) return;
    let message: ServerMessage;
    try {
      message = decode(new Uint8Array(data)) as ServerMessage;
    } catch (error) {
      console.warn("couldn't decode a server frame", error);
      return;
    }
    switch (message.kind) {
      case "welcome":
        this.onWelcome(message.welcome);
        this.onStatus("connected", `connected to ${message.welcome.place}`);
        break;
      case "snapshot":
        this.onSnapshot(message.snapshot);
        break;
      case "pong":
        this.onPong?.(message.t);
        break;
      case "error":
        console.error("session error:", message.message);
        this.onStatus("failed", message.message);
        break;
    }
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encode(message));
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.socket?.close();
  }
}

/** Version marker so a stale cached client can say so instead of failing
 * mysteriously against a newer server. */
export const CLIENT_VERSION = PROTOCOL_VERSION;
