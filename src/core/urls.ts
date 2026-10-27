import { assert, BillingError } from "./errors.js";
export function returnUrl(value: unknown): string {
  assert(typeof value === "string", "invalid_url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BillingError("invalid_url");
  }
  assert(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)),
    "invalid_url",
  );
  return url.toString();
}
