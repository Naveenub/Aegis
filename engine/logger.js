import pino from 'pino';

export const logger = {
  info(data, msg) {
    console.log(JSON.stringify({
      level: 'info',
      msg,
      ...data,
      time: new Date().toISOString()
    }));
  },

  error(data, msg) {
    console.error(JSON.stringify({
      level: 'error',
      msg,
      ...data,
      time: new Date().toISOString()
    }));
  },

  warn(data, msg) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg,
      ...data,
      time: new Date().toISOString()
    }));
  }
};
