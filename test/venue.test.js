import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/src/db.js';
import { Venue } from '../server/src/venue.js';
import { MINUTE } from '../server/src/util.js';

let clock;
let venue;
let zone;
let pc;

beforeEach(() => {
  clock = 1_700_000_000_000;
  venue = new Venue(openDb(), { now: () => clock });
  zone = venue.createZone({ name: 'Standard', hourlyRate: 300 });
  pc = venue.createStation({ name: 'PC 01', zoneId: zone.id });
});

const advance = (minutes) => { clock += minutes * MINUTE; };

test('admin setup, login and token auth', () => {
  assert.equal(venue.needsSetup(), true);
  venue.createAdmin({ username: 'owner', password: 'secret123' });
  assert.equal(venue.needsSetup(), false);
  assert.throws(() => venue.login({ username: 'owner', password: 'nope' }), /Wrong username or password/);
  const { token } = venue.login({ username: 'owner', password: 'secret123' });
  assert.equal(venue.authenticate(token).username, 'owner');
  advance(13 * 60);
  assert.equal(venue.authenticate(token), null, 'tokens expire after 12 hours');
});

test('prepaid session charges upfront and expires on tick', () => {
  const s = venue.startSession(pc.id, { mode: 'prepaid', minutes: 30, method: 'cash' });
  assert.equal(s.charged, 150); // 30 min at 300/hr
  assert.equal(venue.snapshot().stations[0].status, 'in_use');

  advance(29);
  assert.equal(venue.tick().length, 0);
  advance(1);
  const [ended] = venue.tick();
  assert.equal(ended.end_reason, 'expired');
  assert.equal(venue.activeSession(pc.id), null);
  assert.equal(venue.report({ from: 0, to: clock + 1 }).cashIn, 150);
});

test('adding time to a prepaid session extends it and charges', () => {
  venue.startSession(pc.id, { mode: 'prepaid', minutes: 60, method: 'cash' });
  const s = venue.addTime(pc.id, { minutes: 30, method: 'card' });
  assert.equal(s.charged, 450);
  assert.equal(s.ends_at - s.started_at, 90 * MINUTE);
  const r = venue.report({ from: 0, to: clock + 1 });
  assert.deepEqual([r.byMethod.cash, r.byMethod.card], [300, 150]);
});

test('pause stops the clock and resume shifts the end time', () => {
  venue.startSession(pc.id, { mode: 'prepaid', minutes: 30, method: 'cash' });
  advance(10);
  venue.pause(pc.id);
  advance(20);
  assert.equal(venue.tick().length, 0, 'paused sessions never expire');
  venue.resume(pc.id);
  advance(19);
  assert.equal(venue.tick().length, 0);
  advance(1);
  assert.equal(venue.tick().length, 1);
});

test('open session bills per started minute at the end', () => {
  venue.startSession(pc.id, { mode: 'open' });
  clock += 61 * MINUTE + 5_000; // 61 min 5 s -> 62 billable minutes
  assert.equal(venue.quote(pc.id).due, 310);
  const ended = venue.endSession(pc.id, { method: 'card' });
  assert.equal(ended.charged, 310);
  assert.equal(venue.report({ from: 0, to: clock + 1 }).byMethod.card, 310);
});

test('member session runs on balance, top up extends, end deducts', () => {
  const m = venue.createCustomer({ name: 'Ali Raza', username: 'Ali', pin: '1234' });
  assert.equal(m.username, 'ali');
  assert.equal(m.pin_hash, undefined, 'PIN hash is never exposed');
  assert.throws(() => venue.memberLogin(pc.id, { username: 'ali', pin: '1234' }), /needs at least/);

  venue.topUp(m.id, { amount: 100, method: 'cash' }); // 20 minutes at 300/hr
  const s = venue.memberLogin(pc.id, { username: 'ali', pin: '1234' });
  assert.equal(s.ends_at - s.started_at, 20 * MINUTE);

  advance(10);
  venue.topUp(m.id, { amount: 50, method: 'cash' }); // +10 minutes while playing
  assert.equal(venue.activeSession(pc.id).ends_at - s.started_at, 30 * MINUTE);

  advance(5);
  const ended = venue.memberLogout(pc.id);
  assert.equal(ended.charged, 75); // 15 minutes
  assert.equal(venue.getCustomer(m.id).balance, 75);

  const r = venue.report({ from: 0, to: clock + 1 });
  assert.equal(r.cashIn, 150, 'top ups are cash in');
  assert.equal(r.byMethod.balance, 75, 'session paid from balance is not new cash');
});

test('member session expires when balance runs out and never goes negative', () => {
  const m = venue.createCustomer({ name: 'Sara', username: 'sara', pin: '9999' });
  venue.topUp(m.id, { amount: 50, method: 'cash' }); // 10 minutes
  venue.startSession(pc.id, { mode: 'member', customerId: m.id });
  clock += 10 * MINUTE + 900; // ticked a little late
  const [ended] = venue.tick();
  assert.equal(ended.end_reason, 'expired');
  assert.equal(venue.getCustomer(m.id).balance, 0);
});

test('member PIN lockout after repeated failures', () => {
  const m = venue.createCustomer({ name: 'Bilal', username: 'bilal', pin: '4321' });
  venue.topUp(m.id, { amount: 500, method: 'cash' });
  for (let i = 0; i < 5; i++) {
    assert.throws(() => venue.memberLogin(pc.id, { username: 'bilal', pin: '0000' }), /Wrong username or PIN/);
  }
  assert.throws(() => venue.memberLogin(pc.id, { username: 'bilal', pin: '4321' }), /Too many wrong PINs/);
  advance(3);
  assert.ok(venue.memberLogin(pc.id, { username: 'bilal', pin: '4321' }));
});

test('a member cannot play on two stations at once', () => {
  const pc2 = venue.createStation({ name: 'PC 02', zoneId: zone.id });
  const m = venue.createCustomer({ name: 'Hina', username: 'hina', pin: '1111' });
  venue.topUp(m.id, { amount: 500, method: 'cash' });
  venue.startSession(pc.id, { mode: 'member', customerId: m.id });
  assert.throws(() => venue.startSession(pc2.id, { mode: 'member', customerId: m.id }), /already playing/);
});

test('guards: double start, delete with history, zone in use, remote commands', () => {
  venue.startSession(pc.id, { mode: 'maintenance' });
  assert.throws(() => venue.startSession(pc.id, { mode: 'open' }), /already has an active session/);
  assert.throws(() => venue.deleteStation(pc.id), /End the active session/);
  venue.endSession(pc.id);
  assert.equal(venue.getSession(1).charged, 0, 'staff sessions are free');
  assert.throws(() => venue.deleteStation(pc.id), /session history/);
  assert.throws(() => venue.deleteZone(zone.id), /Move or delete the stations/);
  assert.throws(() => venue.command(pc.id, { action: 'message', text: 'hi' }), /offline/);

  venue.online.set(pc.id, { hostname: 'X' });
  const sent = [];
  venue.on('command', (id, cmd) => sent.push([id, cmd]));
  venue.command(pc.id, { action: 'message', text: 'Your food is ready' });
  assert.deepEqual(sent, [[pc.id, { action: 'message', text: 'Your food is ready' }]]);
});

test('report groups by zone and counts hours', () => {
  const vip = venue.createZone({ name: 'VIP', hourlyRate: 600 });
  const pc2 = venue.createStation({ name: 'VIP 01', zoneId: vip.id });
  venue.startSession(pc.id, { mode: 'prepaid', minutes: 60, method: 'cash' });
  venue.startSession(pc2.id, { mode: 'open' });
  advance(60);
  venue.tick();
  venue.endSession(pc2.id, { method: 'cash' });
  const r = venue.report({ from: 0, to: clock + 1 });
  assert.equal(r.sessionsCount, 2);
  assert.equal(r.minutesPlayed, 120);
  assert.deepEqual(r.byZone.map((z) => [z.zone, z.revenue]), [['VIP', 600], ['Standard', 300]]);
});
