import test from 'node:test';
import assert from 'node:assert/strict';
import { format, dayPart } from '../../supabase/functions/telegram-bot/bot.js';

// Kazakhstan is UTC+5: 04:00 UTC = 09:00 local.
const at = (utc) => new Date(`2026-11-24T${utc}:00Z`);
const item = { kind: 'morning', data: { name: 'CarCity', day: '2026-11-23', stats: { orders: 0, sum: 0, shipped: 0 } } };

test('part of day follows local (UTC+5) time', () => {
  assert.equal(dayPart(at('04:00')), 'morning'); // 09:00
  assert.equal(dayPart(at('06:59')), 'morning'); // 11:59
  assert.equal(dayPart(at('07:00')), 'day');     // 12:00
  assert.equal(dayPart(at('12:59')), 'day');     // 17:59
  assert.equal(dayPart(at('13:00')), 'evening'); // 18:00
  assert.equal(dayPart(at('14:32')), 'evening'); // 19:32 — the late run from 24.11
  assert.equal(dayPart(at('22:00')), 'evening'); // 03:00 next day
  assert.equal(dayPart(at('23:00')), 'morning'); // 04:00 next day
});

test('digest greeting matches the time it is sent', () => {
  assert.match(format(item, 'ru', at('04:07')), /^☀️ Доброе утро, CarCity!/);
  assert.match(format(item, 'ru', at('09:00')), /^🌤 Добрый день, CarCity!/);
  assert.match(format(item, 'ru', at('14:32')), /^🌙 Добрый вечер, CarCity!/);
  assert.match(format(item, 'kk', at('04:07')), /^☀️ Қайырлы таң, CarCity!/);
  assert.match(format(item, 'kk', at('09:00')), /^🌤 Қайырлы күн, CarCity!/);
  assert.match(format(item, 'kk', at('14:32')), /^🌙 Қайырлы кеш, CarCity!/);
});
