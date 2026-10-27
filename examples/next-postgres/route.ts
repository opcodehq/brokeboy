import { toHandler } from "../../src/server.js";
import { billing } from "./billing.js";

// Replace this callback with verification by your existing auth provider.
// Returning null keeps the example secure until authentication is wired.
const handler = toHandler({ billing, resolveCustomer: async () => null });
export const GET = handler;
export const POST = handler;
