const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

const COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < current) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tag = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  const head = useColor ? `${COLOR[level]}${tag}${RESET}` : tag;
  if (extra === undefined) console.log(`${head} ${msg}`);
  else console.log(`${head} ${msg}`, typeof extra === 'object' ? JSON.stringify(extra) : extra);
}

/** Logger nomme par module, pour distinguer les flux dans la console. */
export function logger(scope) {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
  };
}
