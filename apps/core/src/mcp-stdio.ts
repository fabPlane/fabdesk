/**
 * `fabdesk-core mcp`: stdio MCP server. Proxies to a live daemon (from daemon.json) so the GUI sees
 * the activity; otherwise `--standalone` runs the registry in-process.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import { DaemonHandshake } from "@fabdesk/protocol";
import {
  attachToRegistry,
  clientSupportsApps,
  createRegistry,
  FABDESK_SERVER_ICONS,
  MCP_CLIENT_META,
  type McpClientHint,
  type ProjectHandle,
} from "@fabdesk/tools";
import { locateAppBridgeFile } from "./app-bridge";
import { TokenSet } from "./auth";
import { createAuth } from "./auth-facade";
import { createCloudService, storedCredentialToken } from "./cloud";
import { EventBus } from "./bus";
import { resolveConfig } from "./config";
import { createContextFactory } from "./context";
import { Store } from "./db";
import { logger, errMsg } from "./log";
