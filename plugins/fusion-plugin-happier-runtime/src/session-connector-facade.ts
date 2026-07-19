/**
 * FNXC:HappierMcp 2026-07-19-19:52:
 * Preserve the root-package connector constructor without eagerly loading the
 * MCP implementation. No child process is opened until a connector operation runs.
 */

import type { SessionConnectorV1 } from "@fusion/core";
import {
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";
import type { HappierSessionConnectorOptions } from "./session-connector.js";

export class HappierSessionConnector implements SessionConnectorV1 {
  readonly contractVersion = 1;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private implementationPromise: Promise<SessionConnectorV1> | null = null;

  constructor(private readonly options: HappierSessionConnectorOptions = {}) {
    this.version = options.version?.trim() || HAPPIER_SESSION_CONNECTOR_VERSION;
  }

  getCapabilities(...args: Parameters<SessionConnectorV1["getCapabilities"]>): ReturnType<SessionConnectorV1["getCapabilities"]> {
    return this.implementation().then((connector) => connector.getCapabilities(...args));
  }

  ensureExisting(...args: Parameters<SessionConnectorV1["ensureExisting"]>): ReturnType<SessionConnectorV1["ensureExisting"]> {
    return this.implementation().then((connector) => connector.ensureExisting(...args));
  }

  create(...args: Parameters<SessionConnectorV1["create"]>): ReturnType<SessionConnectorV1["create"]> {
    return this.implementation().then((connector) => connector.create(...args));
  }

  getStatus(...args: Parameters<SessionConnectorV1["getStatus"]>): ReturnType<SessionConnectorV1["getStatus"]> {
    return this.implementation().then((connector) => connector.getStatus(...args));
  }

  readHistory(...args: Parameters<SessionConnectorV1["readHistory"]>): ReturnType<SessionConnectorV1["readHistory"]> {
    return this.implementation().then((connector) => connector.readHistory(...args));
  }

  subscribeEvents(...args: Parameters<SessionConnectorV1["subscribeEvents"]>): ReturnType<SessionConnectorV1["subscribeEvents"]> {
    return this.implementation().then((connector) => connector.subscribeEvents(...args));
  }

  send(...args: Parameters<SessionConnectorV1["send"]>): ReturnType<SessionConnectorV1["send"]> {
    return this.implementation().then((connector) => connector.send(...args));
  }

  interrupt(...args: Parameters<SessionConnectorV1["interrupt"]>): ReturnType<SessionConnectorV1["interrupt"]> {
    return this.implementation().then((connector) => connector.interrupt(...args));
  }

  resume(...args: Parameters<SessionConnectorV1["resume"]>): ReturnType<SessionConnectorV1["resume"]> {
    return this.implementation().then((connector) => connector.resume(...args));
  }

  takeover(...args: Parameters<SessionConnectorV1["takeover"]>): ReturnType<SessionConnectorV1["takeover"]> {
    return this.implementation().then((connector) => connector.takeover(...args));
  }

  getHealth(...args: Parameters<SessionConnectorV1["getHealth"]>): ReturnType<SessionConnectorV1["getHealth"]> {
    return this.implementation().then((connector) => connector.getHealth(...args));
  }

  getDeepLinks(...args: Parameters<SessionConnectorV1["getDeepLinks"]>): ReturnType<SessionConnectorV1["getDeepLinks"]> {
    return this.implementation().then((connector) => connector.getDeepLinks(...args));
  }

  private implementation(): Promise<SessionConnectorV1> {
    this.implementationPromise ??= import("./session-connector.js")
      .then(({ HappierSessionConnector: OfficialMcpConnector }) => new OfficialMcpConnector(this.options));
    return this.implementationPromise;
  }
}
