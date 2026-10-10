const locks = new Map<string, Promise<unknown>>();
/** Serializes mutations across editing, deletion and attachment services. */
export async function withCourseMutation<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  locks.set(key, next);
  try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
}
