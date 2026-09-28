/** Authenticated usage-archive upload through fabplane.com. R2 credentials stay on the API. */
import { createHash } from "node:crypto";
import type { ArchiveWriter } from "./usage-archive";

export class UsageApiArchiveWriter implements ArchiveWriter {
  constructor(
    private readonly apiOrigin: string,
    private readonly token: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async write(key: string, content: string): Promise<void> {
    const bearer = this.token();
    if (!bearer) throw new Error("usage archive requires a fabplane sign-in");
    const body = Buffer.from(content, "utf8");
    const response = await this.fetchImpl(`${this.apiOrigin.replace(/\/+$/, "")}/v1/private/usage-archive`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "x-fabdesk-archive-key": key,
        "x-fabdesk-content-sha256": createHash("sha256").update(body).digest("hex"),
      },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`usage archive upload failed (${response.status})`);
  }
}
