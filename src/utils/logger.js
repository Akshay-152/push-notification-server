const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel() {
  const raw = (process.env.LOG_LEVEL || '').toLowerCase();
  return LEVELS[raw] ?? LEVELS.info;
}

/**
 * Tiny dependency-free logger. One line per event:
 *   2026-01-01T00:00:00.000Z INFO  [push] message {"key":"value"}
 */
export function createLogger(scope, { level = envLevel() } = {}) {
  function emit(lvl, args) {
    if (LEVELS[lvl] < level) return;
    const parts = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    });
    const line = `${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${scope}] ${parts.join(' ')}`;
    if (lvl === 'error') console.error(line);
    else if (lvl === 'warn') console.warn(line);
    else console.log(line);
  }

  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    child: (subScope) => createLogger(`${scope}:${subScope}`, { level }),
  };
}

export default createLogger('app');
