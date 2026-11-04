/**
 * Finds the Docker daemon and the image sandbox/Dockerfile builds, for the tests that run the real container. Returns
 * why they must skip when no daemon answers on its unix socket or the image was not built:
 * docker build -t aliquot-sandbox sandbox.
 */

import { execFileSync } from "node:child_process";
import { request } from "node:http";

const IMAGE_TAG = "aliquot-sandbox";

export function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ socketPath, path, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

function candidateSockets(): string[] {
  const out: string[] = [];
  if (process.env.DOCKER_HOST?.startsWith("unix://")) out.push(process.env.DOCKER_HOST.slice(7));
  try {
    const host = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (host.startsWith("unix://")) out.push(host.slice(7));
  } catch {}
  out.push("/var/run/docker.sock");
  return out;
}

export async function findDocker(): Promise<{ socket: string; image: string } | string> {
  for (const socket of candidateSockets()) {
    if ((await get(socket, "/_ping")).status !== 200) continue;
    const image = await get(socket, `/images/${IMAGE_TAG}/json`);
    if (image.status !== 200) return `the ${IMAGE_TAG} image is not built (docker build -t ${IMAGE_TAG} sandbox)`;
    return { socket, image: (JSON.parse(image.body) as { Id: string }).Id };
  }
  return "no Docker daemon answered on its unix socket";
}

