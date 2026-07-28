/**
 * Leveled log sink for the add-on.
 *
 * ★ v0.25.0. Before this, `log_level` was DEAD CONFIG: the option was declared
 *   in config.yaml, given a translation, exported by the run script as
 *   `LOG_LEVEL`, and parsed into `config.logLevel` — and then read by nobody.
 *   Setting it to `warning` to quiet a chatty add-on did precisely nothing,
 *   which is worse than not offering the knob, because the operator believes
 *   they turned the volume down.
 *
 * The sink is deliberately CALLABLE. Every subsystem takes its logger as a
 * plain `(msg: string) => void`, so making the logger an object with `.warn()`
 * would have meant changing every one of those signatures. A callable object
 * satisfies the existing structural type unchanged: `log(msg)` still means
 * "informational", and the handful of sites that genuinely carry severity opt
 * into `log.warn` / `log.error`.
 *
 * Levels are bashio's, so the option's values mean the same thing to the
 * operator as they do everywhere else in Home Assistant. A message prints when
 * its own severity is at or above the configured threshold — so `warning`
 * silences the operational chatter while still surfacing the login-gate
 * warning and any error.
 */

/** bashio's ladder, least to most severe. Index = severity. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'notice', 'warning', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type Logger = ((msg: string) => void) & {
  /** Below the default threshold — only visible at `debug`/`trace`. */
  debug: (msg: string) => void;
  /** Survives `log_level: warning`. */
  warn: (msg: string) => void;
  /** Survives `log_level: error`. */
  error: (msg: string) => void;
  /** The resolved threshold (after unknown-value fallback). */
  readonly level: LogLevel;
};

/**
 * Resolve a configured level to a known one.
 *
 * An unrecognised value falls back to `info` rather than throwing or silencing
 * everything: a typo in the add-on options must never be able to blind the
 * operator to errors, which is what treating it as "most severe" would do.
 */
export function normalizeLevel(raw: string | undefined | null): LogLevel {
  const v = (raw ?? '').trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v) ? (v as LogLevel) : 'info';
}

export function createLogger(
  rawLevel: string | undefined | null,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Logger {
  const level = normalizeLevel(rawLevel);
  const threshold = LOG_LEVELS.indexOf(level);

  // bashio already prefixes add-on lines; keep one flat sink so the data layer,
  // provider and transports all funnel through the same place.
  const emit = (severity: LogLevel, msg: string): void => {
    if (LOG_LEVELS.indexOf(severity) < threshold) return;
    write(`[zwave-tui] ${msg}\n`);
  };

  const log = ((msg: string) => emit('info', msg)) as Logger;
  log.debug = (msg: string) => emit('debug', msg);
  log.warn = (msg: string) => emit('warning', msg);
  log.error = (msg: string) => emit('error', msg);
  Object.defineProperty(log, 'level', { value: level, enumerable: true });
  return log;
}
