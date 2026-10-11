// Minimal dependency-free logger (avoids extra transport packages on Render)
function ts() {
  return new Date().toISOString();
}

function fmt(level, args) {
  return [`[${ts()}] [${level}]`, ...args];
}

module.exports = {
  info: (...args) => console.log(...fmt('INFO', args)),
  warn: (...args) => console.warn(...fmt('WARN', args)),
  error: (...args) => console.error(...fmt('ERROR', args)),
  debug: (...args) => {
    if (process.env.LOG_LEVEL === 'debug') console.log(...fmt('DEBUG', args));
  },
};
