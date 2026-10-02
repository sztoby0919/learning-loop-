export class BackupError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}
