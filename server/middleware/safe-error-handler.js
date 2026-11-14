'use strict';

const { safeErrorMetadata } = require('./safe-error-metadata');

function createSafeErrorHandler({ logger = console } = {}) {
  return function safeErrorHandler(error, _req, res, next) {
    // Parser errors can contain the complete submitted body in error.body.
    // Never serialize the raw error, request, headers, or stack.
    logger.error('Request failed:', safeErrorMetadata(error));

    if (res.headersSent) return next(error);

    const status = Number(error?.statusCode || error?.status);
    if (status === 413 || error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '请求内容过大' });
    }
    if (status === 400) {
      return res.status(400).json({ error: '请求格式无效' });
    }
    return res.status(500).json({ error: '服务器内部错误' });
  };
}

module.exports = { createSafeErrorHandler };
