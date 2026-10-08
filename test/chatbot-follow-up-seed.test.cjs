const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
require('ts-node').register({ compilerOptions: { rootDir: '.' } });
const { DEFAULT_FOLLOW_UPS, seedChatbotFollowUps } = require('../prisma/chatbot-follow-ups');

test('default migration and seed contain the same four existing questions', () => {
  const migration = readFileSync(resolve(__dirname, '../prisma/migrations/20261008143000_chatbot_follow_up_questions/migration.sql'), 'utf8');
  assert.equal(DEFAULT_FOLLOW_UPS.length, 4);
  assert.equal(new Set(DEFAULT_FOLLOW_UPS.map((row) => row.id)).size, 4);
  for (const row of DEFAULT_FOLLOW_UPS) {
    for (const field of ['id', 'text']) {
      assert.ok(migration.includes(`'${row[field].replaceAll("'", "''")}'`));
    }
  }
});

test('rerunning the seed inserts missing defaults and preserves admin customizations and deletions', async () => {
  const customized = { ...DEFAULT_FOLLOW_UPS[0], text: 'Customized English?', position: 99, isActive: false, deletedAt: new Date() };
  const customAdded = { id: 'admin-added', text: 'New EN?', position: 5, isActive: true };
  const stored = new Map([[customized.id, { ...customized }], [customAdded.id, { ...customAdded }]]);
  const prisma = {
    chatbotFollowUp: { upsert: async ({ where, create, update }) => {
      assert.deepEqual(update, {});
      stored.set(where.id, stored.has(where.id) ? { ...stored.get(where.id), ...update } : create);
      return stored.get(where.id);
    } },
    $transaction: (operations) => Promise.all(operations),
  };
  await seedChatbotFollowUps(prisma);
  await seedChatbotFollowUps(prisma);
  assert.equal(stored.size, 5);
  assert.deepEqual(stored.get(customized.id), customized);
  assert.deepEqual(stored.get(customAdded.id), customAdded);
});
