'use strict';

const { v4: uuidv4 } = require('uuid');
const { createTestDb } = require('../helpers/testDb');

describe('conversationAttributionEngine.getConversationAttribution', () => {
  let testDb, engine;

  beforeAll(async () => {
    testDb = await createTestDb();
    engine = require('../../src/services/conversationAttributionEngine');
  });

  afterAll(() => { testDb.cleanup(); });
  afterEach(() => { testDb.db.run('DELETE FROM creative_analytics'); });

  function insert(destType, spend, results, conversionRate) {
    testDb.db.run(
      `INSERT INTO creative_analytics (id, ad_account_id, meta_ad_id, meta_campaign_id, destination_type, date_since, date_until, spend, results, conversion_rate, calculated_at)
       VALUES (?, 'acct1', ?, 'camp_conv_1', ?, '2026-06-01', '2026-06-07', ?, ?, ?, ?)`,
      [uuidv4(), uuidv4(), destType, spend, results, conversionRate, new Date().toISOString()]
    );
  }

  test('includes only conversation-capable destinations (Messenger/WhatsApp/Instagram Direct), excluding Website/Lead Form', () => {
    insert('WHATSAPP', 100, 20, 15);
    insert('WEBSITE', 200, 5, 3); // not a conversation destination -- excluded

    const result = engine.getConversationAttribution('camp_conv_1', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.conversations.length).toBe(1);
    expect(result.conversations[0].destination_type).toBe('WHATSAPP');
  });

  test('computes cost_per_conversation, conversation_rate, and contribution_pct correctly', () => {
    insert('WHATSAPP', 100, 20, 15);
    insert('MESSENGER', 50, 10, 12);

    const result = engine.getConversationAttribution('camp_conv_1', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.total_conversations).toBe(30);
    const whatsapp = result.conversations.find(c => c.destination_type === 'WHATSAPP');
    expect(whatsapp.cost_per_conversation).toBeCloseTo(5, 2);
    expect(whatsapp.conversation_rate).toBe(15);
    expect(whatsapp.contribution_pct).toBeCloseTo(66.7, 0); // 20/30
  });

  test('honestly reports response_rate/first_reply_time/qualified_conversations/calls as unavailable, never fabricated', () => {
    insert('WHATSAPP', 100, 20, 15);
    const result = engine.getConversationAttribution('camp_conv_1', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.conversations[0].response_rate).toBeNull();
    expect(result.conversations[0].first_reply_time_seconds).toBeNull();
    expect(result.conversations[0].qualified_conversations).toBeNull();
    expect(result.not_available).toEqual(['response_rate', 'first_reply_time', 'qualified_conversations', 'calls']);
    expect(result.not_available_reason).toMatch(/Messenger\/WhatsApp\/Instagram Messaging Platform/);
  });

  test('returns an empty, honest result when no conversation-destination data exists', () => {
    insert('WEBSITE', 100, 10, 10);
    const result = engine.getConversationAttribution('camp_conv_1', { since: '2026-06-01', until: '2026-06-07' });
    expect(result.conversations).toEqual([]);
    expect(result.note).toBeTruthy();
  });
});
