import type { Backend } from "./types";

/** At most this many errors are kept per minute (an error every frame would flood the log). */
const PER_MINUTE = 10;

/** What an error says, with where it came from (its stack) when it has one. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.stack && e.stack.includes(e.message) ? e.stack : `${e.message}\n${e.stack ?? ""}`.trim();
  return String(e);
}

/** Keeps errors in errors.log (the app's data folder), a few a minute at most. */
export function errorLogger(backend: Backend, source: string): (e: unknown, where?: string) => void {
  let minute = 0;
  let count = 0;
  return (e, where) => {
    const now = Math.floor(Date.now() / 60_000);
    if (now !== minute) {
      minute = now;
      count = 0;
    }
    if (++count > PER_MINUTE) return;
    void backend.logError(source, `${where ? `${where}: ` : ""}${describeError(e)}`).catch(() => {});
  };
}

/** A window's uncaught errors and rejected promises, into errors.log. */
export function watchErrors(backend: Backend, source: string): (e: unknown, where?: string) => void {
  const log = errorLogger(backend, source);
  window.addEventListener("error", (e) => log(e.error ?? e.message, "uncaught"));
  window.addEventListener("unhandledrejection", (e) => log(e.reason, "unhandled rejection"));
  return log;
}
