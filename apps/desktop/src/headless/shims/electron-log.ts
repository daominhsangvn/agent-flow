/**
 * @file electron-log.ts
 * @description Node-only stand-in for `electron-log/main.js`, aliased in by
 * the headless runner bundle. The desktop's durable file log
 * (src/main/logging/persistent-log.ts) is never initialized by the runner, so
 * every call here is a no-op: GatewayLogger already writes each entry to
 * stdout/stderr, which is where a container's logs belong.
 */

type LogFunction = (...parameters: unknown[]) => void;

const noop: LogFunction = () => undefined;

const electronLog = {
  initialize: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  transports: {
    file: {
      level: false as string | false,
      fileName: "main.log",
      maxSize: 0,
      resolvePathFn: undefined as unknown,
      archiveLogFn: undefined as unknown,
      getFile: () => ({ path: "", clear: () => true }),
    },
    console: {
      level: false as string | false,
      writeFn: noop as unknown,
    },
  },
};

export default electronLog;
