/** Bounded raw transport input. Signature verification receives these exact bytes. */
export async function readRequestBytes(
  request: Request,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (signal.aborted) {
    void request.body?.cancel().catch(() => {});
    throw new Error("interrupted");
  }
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    void request.body?.cancel().catch(() => {});
    throw new Error("body_too_large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let rejectAbort: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = () => {
    rejectAbort(new Error("interrupted"));
    void reader.cancel().catch(() => {});
  };
  const chunks: Uint8Array[] = [];
  let size = 0,
    finished = false;
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) abort();
    for (;;) {
      const result = await Promise.race([reader.read(), interrupted]);
      if (signal.aborted) throw new Error("interrupted");
      if (result.done) {
        finished = true;
        break;
      }
      if (!(result.value instanceof Uint8Array))
        throw new Error("invalid_body");
      size += result.value.byteLength;
      if (size > maximum) throw new Error("body_too_large");
      if (result.value.byteLength > 0)
        chunks.push(Uint8Array.from(result.value));
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } catch (error) {
    if (
      error instanceof Error &&
      ["interrupted", "body_too_large", "invalid_body"].includes(error.message)
    )
      throw error;
    throw new Error("invalid_body");
  } finally {
    signal.removeEventListener("abort", abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
