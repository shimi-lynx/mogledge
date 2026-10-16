(() => {
  const descriptor = __MOGLEDGE_STORAGE_DESCRIPTOR__;
  const available = descriptor.available;
  const token = __MOGLEDGE_STORAGE_TOKEN__;
  let requested = false;
  // Existing inline adapters check availability when starting an operation,
  // not when constructing an adapter. Keep viewing and capability injection quiet.
  Object.defineProperty(descriptor, "available", {
    enumerable: true,
    get() {
      if (!requested) {
        requested = true;
        try {
          window.parent.postMessage({ type: "mogledge-storage-request-v1", token }, "*");
        } catch {
          // This advisory must never change a storage operation's result.
        }
      }
      return available;
    },
  });
  Object.freeze(descriptor);
  for (const name of ["__MOGLEDGE_STORAGE_V1__", "__MY_KNOWLEDGE_STORAGE_V1__"])
    Object.defineProperty(globalThis, name, {
      value: descriptor,
      writable: false,
      configurable: false,
    });
})();
