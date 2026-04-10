const pino = require("pino");
const config = require("../config");

// Check if we are in a development environment
const isDev = process.env.NODE_ENV !== "production";

const logger = pino({
  level: config.log.level,
  // Only apply pino-pretty if we are NOT in production
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
});

module.exports = logger;
