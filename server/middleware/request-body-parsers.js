'use strict';

function createRequestBodyParsers(express) {
  const jsonParser = express.json({ limit: '2mb' });
  const urlencodedParser = express.urlencoded({
    extended: true,
    parameterLimit: 1000,
    limit: '1mb'
  });

  return [
    (req, res, next) => {
      // The backup-import route owns its larger, route-specific JSON parser.
      if (req.path === '/api/super/backup/import') return next();
      return jsonParser(req, res, next);
    },
    urlencodedParser
  ];
}

module.exports = { createRequestBodyParsers };
