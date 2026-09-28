/** Explicitly enabled private Cloudflare R2 destination for the training archive. */
import { createHash } from "node:crypto";
import { PutObjectCommand, S3Client, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import type { ArchiveWriter } from "./training-archive";

export type R2ArchiveConfig = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
};

/** No R2 access occurs unless the operator sets the explicit enable flag. */
export function r2ArchiveConfig(env: NodeJS.ProcessEnv = process.env): R2ArchiveConfig | null {
  if (env["FABDESK_TRAINING_R2_ENABLED"] !== "1") return null;
  const accountId = env["FABDESK_TRAINING_R2_ACCOUNT_ID"]?.trim();
  const bucket = env["FABDESK_TRAINING_R2_BUCKET"]?.trim();
  const accessKeyId = env["FABDESK_TRAINING_R2_ACCESS_KEY_ID"]?.trim();
  const secretAccessKey = env["FABDESK_TRAINING_R2_SECRET_ACCESS_KEY"]?.trim();
  const prefix = (env["FABDESK_TRAINING_R2_PREFIX"]?.trim() || "fabdesk-training/v1").replace(
    /\/+$/,
    "",
  );
  if (
    !accountId ||
    !/^[a-fA-F0-9]{32}$/.test(accountId) ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !prefix ||
    !/^[a-zA-Z0-9/_-]+$/.test(prefix) ||
    prefix.split("/").some((segment) => !segment)
  ) {
    throw new Error(
      "FABDESK_TRAINING_R2_ENABLED=1 requires a valid account ID, bucket, access key ID, secret access key, and key prefix",
    );
  }
  return { accountId, bucket, accessKeyId, secretAccessKey, prefix };
}

export class R2ArchiveWriter implements ArchiveWriter {
  private readonly client: S3Client | null;
  constructor(
    private readonly config: R2ArchiveConfig,
    private readonly sendPut?: (input: PutObjectCommandInput) => Promise<void>,
  ) {
    this.client = sendPut
      ? null
      : new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      requestChecksumCalculation: "WHEN_REQUIRED",
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        });
  }

  async write(key: string, content: string): Promise<void> {
    const body = Buffer.from(content, "utf8");
    const input: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: `${this.config.prefix}/${key}`,
      Body: body,
      ContentType: "application/json",
      ContentMD5: createHash("md5").update(body).digest("base64"),
    };
    if (this.sendPut) await this.sendPut(input);
    else await this.client!.send(new PutObjectCommand(input));
  }

  close(): void {
    this.client?.destroy();
  }
}
