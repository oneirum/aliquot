/**
 * The web door's only reach to the lab's sign-on provider: its discovery document and keys (GET) and its token
 * endpoint (POST), over https, or http to a loopback host so a test can stand in for the provider. It sends the
 * provider nothing but the sign-on exchange, and nothing here decides who a member is: signon.ts does.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** A provider's answer that is too big, too slow, or not JSON is a failed sign-in, never a hung door. */
const MAX_REPLY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10_000;

export class SignOnWireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignOnWireError";
  }
}

/** https, or http to a loopback host only, so a code or token never crosses a network in clear. */
export function checkProviderUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new SignOnWireError(`the sign-on provider must be https (or http on loopback for a test), not ${url.href}`);
  return url;
}

export interface ProviderReply {
  readonly status: number;
  readonly json: unknown;
}

/** How signon.ts reaches the provider. Tests pass their own. */
export interface ProviderWire {
  getJson(url: string): Promise<ProviderReply>;
  /** application/x-www-form-urlencoded, with HTTP Basic client authentication when basic is given. */
  postForm(url: string, form: Readonly<Record<string, string>>, basic: { readonly user: string; readonly password: string } | null): Promise<ProviderReply>;
}

function call(raw: string, method: "GET" | "POST", headers: Record<string, string | number>, body: Buffer | null): Promise<ProviderReply> {
  const url = checkProviderUrl(raw);
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method, headers: { accept: "application/json", ...headers }, timeout: TIMEOUT_MS }, (res) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > MAX_REPLY_BYTES) req.destroy(new SignOnWireError(`${url.origin}${url.pathname} answered more than ${MAX_REPLY_BYTES} bytes`));
        else chunks.push(c);
      });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch {
          reject(new SignOnWireError(`${url.origin}${url.pathname} answered ${res.statusCode} with a body that is not JSON`));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new SignOnWireError(`${url.origin}${url.pathname} did not answer within ${TIMEOUT_MS / 1000} s`)));
    req.on("error", (err) => reject(err instanceof SignOnWireError ? err : new SignOnWireError(`${url.origin}${url.pathname}: ${err.message}`)));
    req.end(body ?? undefined);
  });
}

export const providerWire: ProviderWire = {
  getJson: (url) => call(url, "GET", {}, null),
  postForm(url, form, basic) {
    const body = Buffer.from(new URLSearchParams(form).toString());
    // RFC 6749 2.3.1: the client id and secret are form-encoded before they are joined for Basic.
    const auth: Record<string, string> = basic ? { authorization: `Basic ${Buffer.from(`${encodeURIComponent(basic.user)}:${encodeURIComponent(basic.password)}`).toString("base64")}` } : {};
    return call(url, "POST", { "content-type": "application/x-www-form-urlencoded", "content-length": body.length, ...auth }, body);
  },
};
