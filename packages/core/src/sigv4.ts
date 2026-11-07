/**
 * AWS Signature Version 4, for Bedrock. Pure: no network, no clock, no env. gateway.ts reads the keys and the time and
 * sends the request. Written from docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html and checked
 * against AWS's published test vectors (test/sigv4.test.ts), so no AWS SDK is needed.
 */

import { createHash, createHmac } from "node:crypto";

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials (STS, an instance role); sent as x-amz-security-token and signed. */
  readonly sessionToken?: string;
}

export interface SignInput {
  readonly method: string;
  readonly url: URL;
  /** Headers the request will carry. Every one is signed, with host and x-amz-date added. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

/** RFC 3986: everything but unreserved characters is percent-encoded, which encodeURIComponent leaves undone for !'()*. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** 20150830T123600Z */
export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/**
 * The headers to send: the input's, plus x-amz-date, x-amz-security-token when there is a session token, and
 * authorization. Host is signed but not returned, because fetch sets it from the URL.
 */
export function signV4(input: SignInput): Record<string, string> {
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...input.headers, "x-amz-date": date };
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;
  const signed: Record<string, string> = { host: input.url.host };
  for (const [k, v] of Object.entries(headers)) signed[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(signed).sort();
  // Every service but S3 encodes the path twice: once in the URL, once here, segment by segment.
  const path = input.url.pathname.split("/").map(encode).join("/") || "/";
  const query = [...input.url.searchParams]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonical = [input.method.toUpperCase(), path, query, names.map((n) => `${n}:${signed[n]}\n`).join(""), names.join(";"), sha256(input.body)].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, day), input.region), input.service), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}
