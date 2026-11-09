'use strict';

// Parse canonical positive decimal route identifiers without Number() coercion.
function parsePositiveRouteId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value);
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

module.exports = { parsePositiveRouteId };
