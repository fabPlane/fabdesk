/** Installation-authenticated usage archive upload. R2 credentials stay on the API. */
import { createHash } from "node:crypto";
import type { ArchiveWriter } from "./usage-archive";

type Installation = { installationId: string; token: string };
export type InstallationStore = {
  readRaw(key: string): unknown;
  writeRaw(key: string, value: unknown): void;
};

const INSTALLATION_KEY = "usage_archive_installation";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validInstallation(value: unknown): value is Installation {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record["installationId"] === "string" && UUID.test(record["installationId"])
    && typeof record["token"] === "string"
    && new RegExp(`^${record["installationId"]}\\.[a-f0-9]{64}$`).test(record["token"]);
}

export class UsageApiArchiveWriter implements ArchiveWriter {
  private installationTask: Promise<Installation> | null = null;
  get id(): string {
    return `api:${this.apiOrigin.replace(/\/+$/, "")}`;
  }
  constructor(
    private readonly apiOrigin: string,
    private readonly token: () => string | null,
    private readonly installationStore: InstallationStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private installation(): Promise<Installation> {
    const stored = this.installationStore.readRaw(INSTALLATION_KEY);
    if (validInstallation(stored)) return Promise.resolve(stored);
    if (this.installationTask) return this.installationTask;
    this.installationTask = (async () => {
      const response = await this.fetchImpl(`${this.apiOrigin.replace(/\/+$/, "")}/v1/usage-archive/installation`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`usage archive registration failed (${response.status})`);
      const installation: unknown = await response.json();
      if (!validInstallation(installation)) throw new Error("usage archive registration returned invalid credentials");
      this.installationStore.writeRaw(INSTALLATION_KEY, installation);
      return installation;
    })().finally(() => { this.installationTask = null; });
    return this.installationTask;
  }

  async write(key: string, content: string): Promise<void> {
    const installation = await this.installation();
    const bearer = this.token();
    const body = Buffer.from(content, "utf8");
    const response = await this.fetchImpl(`${this.apiOrigin.replace(/\/+$/, "")}/v1/usage-archive`, {
      method: "PUT",
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        "content-type": "application/json",
        "x-fabdesk-installation-token": installation.token,
        "x-fabdesk-archive-key": key,
        "x-fabdesk-content-sha256": createHash("sha256").update(body).digest("hex"),
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`usage archive upload failed (${response.status})`);
  }
}
