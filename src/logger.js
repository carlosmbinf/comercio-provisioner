const cleanLogValue = (value, maxLength = 800) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, maxLength);

const sanitizeCommandDiagnostic = (value) => cleanLogValue(value, 600)
  .replace(/https?:\/\/[^\s]+/gi, (candidate) => {
    const punctuation = candidate.match(/[.,;:!?)]*$/)?.[0] || "";
    const rawUrl = candidate.slice(0, candidate.length - punctuation.length);
    try {
      const url = new URL(rawUrl);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return `${url.origin}${url.pathname}${punctuation}`;
    } catch (_error) {
      return `[URL omitida]${punctuation}`;
    }
  })
  .replace(/\b((?:authorization|token|secret|password|api[_-]?key)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/gi, "$1[redactado]");

const createLogger = (context = {}, sink = console) => {
  const write = (level, message) => {
    const timestamp = new Date().toISOString();
    const fields = [
      ["worker", context.workerId],
      ["request", context.requestId],
      ["slug", context.slug],
      ["host", context.hostname],
      ["flow", context.flow],
      ["stage", context.stage],
    ].filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}=${cleanLogValue(value, 128)}`);
    const line = `${timestamp} ${level.toUpperCase()} [comercio-provisioner]${fields.length ? ` ${fields.join(" ")}` : ""} ${cleanLogValue(message)}`;
    sink[level]?.call(sink, line);
  };

  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
    child: (overrides = {}) => createLogger({ ...context, ...overrides }, sink),
  };
};

module.exports = { cleanLogValue, createLogger, sanitizeCommandDiagnostic };
