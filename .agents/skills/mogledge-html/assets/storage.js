(function (scope) {
  "use strict";
  const DEFAULT_DOCUMENT_BYTES = 5 * 1024 * 1024;
  const encoder = new TextEncoder();

  class StorageError extends Error {
    constructor(code, message = code) {
      super(message);
      this.name = "StorageError";
      this.code = code;
    }
  }

  function create({ appId, schemaVersion }) {
    if (typeof appId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(appId))
      throw new StorageError("invalid_key");
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
      throw new StorageError("invalid_schema");
    // A present canonical descriptor is authoritative, including unavailable or
    // unsupported descriptors. Legacy Native descriptors never enable fallback.
    const canonicalNative = "__MOGLEDGE_STORAGE_V1__" in scope;
    const native = canonicalNative || "__MY_KNOWLEDGE_STORAGE_V1__" in scope;
    const descriptor = canonicalNative
      ? scope.__MOGLEDGE_STORAGE_V1__
      : scope.__MY_KNOWLEDGE_STORAGE_V1__;
    const jobs = [];
    let running = false;
    let lastFailure = null;
    let browserRevision = 0;

    function maximumDocumentBytes() {
      if (!native || descriptor?.maximumDocumentBytes === undefined) return DEFAULT_DOCUMENT_BYTES;
      const bytes = descriptor.maximumDocumentBytes;
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new StorageError("storage_unavailable");
      // This is a finite allocation/transport ceiling, not the configured quota.
      // The Native transaction checks the current limits for every commit, so
      // changing settings needs no reload, extra request, or cached client quota.
      return bytes;
    }

    function errorFrom(error) {
      if (error instanceof StorageError) return error;
      return new StorageError(
        error?.name === "QuotaExceededError" ? "quota_exceeded" : "storage_unavailable",
        error?.message || "Storage unavailable",
      );
    }

    function browserKey() {
      const documentUrl = new URL(scope.location.href);
      documentUrl.hash = "";
      documentUrl.search = "";
      return "mogledge:v1:" + encodeURIComponent(documentUrl.href) + ":" + appId;
    }

    async function transport(op, value) {
      if (native) {
        if (descriptor?.version !== 1 || !descriptor.available || !descriptor.endpoint)
          throw new StorageError("storage_unavailable");
        const response = await scope.fetch(descriptor.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "omit",
          cache: "no-store",
          body: JSON.stringify({
            version: 1,
            op,
            key: appId,
            ...(op === "write" ? { value } : {}),
          }),
        });
        let result;
        try {
          result = await response.json();
        } catch {
          throw new StorageError("invalid_response");
        }
        if (!result || typeof result !== "object") throw new StorageError("invalid_response");
        if (!response.ok)
          throw new StorageError(
            typeof result.error === "string" ? result.error : "storage_unavailable",
          );
        if (
          result.version !== 1 ||
          !Number.isSafeInteger(result.revision) ||
          result.revision < 0 ||
          !("value" in result)
        )
          throw new StorageError("invalid_response");
        return result;
      }
      // Access itself can throw for file URLs, disabled storage, or an opaque origin.
      const storage = scope.localStorage;
      const key = browserKey();
      if (op === "read") {
        const stored = storage.getItem(key);
        if (stored === null) return { value: null, revision: browserRevision };
        let result;
        try {
          result = JSON.parse(stored);
        } catch {
          throw new StorageError("invalid_response");
        }
        if (
          !result ||
          result.version !== 1 ||
          !Number.isSafeInteger(result.revision) ||
          result.revision < 0 ||
          !("value" in result)
        )
          throw new StorageError("invalid_response");
        browserRevision = result.revision;
        return result;
      }
      const revision = browserRevision + 1;
      if (op === "delete") storage.removeItem(key);
      else storage.setItem(key, JSON.stringify({ version: 1, value, revision }));
      browserRevision = revision;
      return { value: op === "delete" ? null : value, revision };
    }

    async function drain() {
      if (running) return;
      running = true;
      while (jobs.length) {
        const job = jobs.shift();
        try {
          let result;
          if (job.op === "error") throw job.value;
          if (job.op === "flush") {
            if (lastFailure) throw lastFailure;
          } else {
            result = await transport(job.op, job.value);
            if (job.op === "read" && result.value !== null) {
              if (!result.value || result.value.schemaVersion !== schemaVersion)
                throw new StorageError("schema_mismatch");
              if (!("data" in result.value)) throw new StorageError("invalid_response");
            }
            if (job.op !== "read") lastFailure = null;
          }
          for (const waiter of job.waiters)
            waiter.resolve(job.op === "read" ? (result.value?.data ?? null) : result?.revision);
        } catch (error) {
          const failure = errorFrom(error);
          lastFailure = failure;
          for (const waiter of job.waiters) waiter.reject(failure);
        }
      }
      running = false;
    }

    function enqueue(op, value) {
      return new Promise((resolve, reject) => {
        const previous = jobs[jobs.length - 1];
        // Only not-yet-started consecutive writes coalesce; reads/deletes/flush are barriers.
        if (op === "write" && previous?.op === "write") {
          previous.value = value;
          previous.waiters.push({ resolve, reject });
        } else jobs.push({ op, value, waiters: [{ resolve, reject }] });
        queueMicrotask(drain);
      });
    }

    return Object.freeze({
      read: () => enqueue("read"),
      write(data) {
        try {
          const encoded = JSON.stringify({ schemaVersion, data });
          if (data === undefined || encoded === undefined) throw new StorageError("invalid_value");
          // The persisted map also includes {"appId":...}. Other appIds in
          // the same physical document are accounted for by the Native server.
          if (encoder.encode(encoded).byteLength + appId.length + 5 > maximumDocumentBytes())
            throw new StorageError("quota_exceeded");
          // Snapshot before queuing so later caller mutations cannot change a pending save.
          const snapshot = JSON.parse(encoded);
          if (!("data" in snapshot)) throw new StorageError("invalid_value");
          return enqueue("write", snapshot);
        } catch (error) {
          return enqueue(
            "error",
            error instanceof StorageError ? error : new StorageError("invalid_value"),
          );
        }
      },
      remove: () => enqueue("delete"),
      flush: () => enqueue("flush"),
    });
  }

  Object.defineProperty(scope, "MogledgeStorage", {
    value: Object.freeze({ create, StorageError }),
    configurable: false,
    writable: false,
  });
  // Existing inline apps keep their API without reading any legacy browser key.
  Object.defineProperty(scope, "MyKnowledgeStorage", {
    value: scope.MogledgeStorage,
    configurable: false,
    writable: false,
  });
})(globalThis);
