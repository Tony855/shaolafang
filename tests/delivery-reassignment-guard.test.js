'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canReassignDeliveryJob } = require('../routes/delivery');

test('delivery job can be assigned when no job exists', () => {
  assert.equal(canReassignDeliveryJob(null), true);
});

test('only an assigned job can be reassigned to another rider', () => {
  assert.equal(canReassignDeliveryJob({ status: 'assigned' }), true);
  assert.equal(canReassignDeliveryJob({ status: 'pending_assignment' }), true);
  for (const status of ['accepted', 'picked_up', 'delivering', 'delivered', 'cancelled']) {
    assert.equal(canReassignDeliveryJob({ status }), false, status);
  }
});
