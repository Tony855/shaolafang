'use strict';

function safeErrorMetadata(error) {
  const metadata = {
    name: typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error'
  };
  const status = Number(error?.statusCode || error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    metadata.status = status;
  }
  if (typeof error?.type === 'string') {
    metadata.type = error.type.slice(0, 80);
  }
  return metadata;
}

module.exports = { safeErrorMetadata };
