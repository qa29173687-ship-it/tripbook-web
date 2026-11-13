import assert from 'node:assert/strict';
import { summary, transfers, displayCode, normalizeCode, newInviteCode, expenseTitle, itemName, money, pendingOf, sortItems } from '../logic.js';

const ms = [
  { id: '1', name: '宏威', start: 50000, cash: 47000, owner: true },
  { id: '2', name: '小美', start: 30000, cash: 28400, owner: false },
  { id: '3', name: '阿明', start: 30000, cash: 27500, owner: false },
];
const es = [
  { id: 'a', title: 'EVE ×2', amount: 1600, payerId: '2', method: 'CASH', at: 3, shares: { '2': 1600 } },
  { id: 'b', title: '一蘭拉麵', amount: 3600, payerId: '1', method: 'CASH', at: 2, shares: { '1': 1200, '2': 1200, '3': 1200 } },
  { id: 'c', title: 'Skyliner', amount: 7500, payerId: '3', method: 'CASH', at: 1, shares: { '1': 2500, '2': 2500, '3': 2500 } },
];
const pend = [{ memberId: '2', title: '抹茶粉', amount: 500, method: 'CASH', at: 4 }, { memberId: '3', title: 'x', amount: 100, method: 'CASH', at: 5 }];
const s = summary('2', ms, es, pend);
assert.equal(s.remainingCash, 27900);
assert.equal(s.spent, 1600 + 1200 + 2500 + 500);
assert.equal(s.spent, 5800);
assert.equal(s.related.length, 3);
assert.deepEqual(s.related.map(e => e.id), ['a', 'b', 'c']);
assert.equal(s.pending.length, 1);
assert.equal(s.transfers.filter(t => t.fromId === '2').reduce((a, t) => a + t.amount, 0), 3700);
assert.equal(displayCode('ABCDEF'), 'ABCD-EF');
assert.equal(normalizeCode('abcd-ef '), 'ABCDEF');
assert.equal(newInviteCode().length, 6);
// transfers all members: nets 1: 3600-3700=-100, 2: 1600-5300=-3700, 3: 7500-3700=+3800
assert.deepEqual(transfers(ms, es), [{ fromId: '2', toId: '3', amount: 3700 }, { fromId: '1', toId: '3', amount: 100 }]);
assert.equal(expenseTitle('  ', 1), '購物');
assert.equal(expenseTitle('抹茶粉', 3), '抹茶粉 ×3');
assert.equal(itemName('', true), '照片裡的東西');
assert.equal(itemName('', false), '要買的東西');
assert.equal(money(12345), 'NT$12,345');
assert.equal(money(500, 'JPY'), '¥500');
assert.equal(pendingOf([{ type: 'unbuy', memberId: '2', amount: 0 }, { type: 'buy', memberId: '2', title: 't', amount: 5, method: 'CASH', at: 1 }]).length, 1);
assert.deepEqual(sortItems([
  { id: 'x', memberId: '3', memberName: '阿明', done: false, createdAt: 1 },
  { id: 'y', memberId: '2', memberName: '小美', done: true, createdAt: 1 },
  { id: 'z', memberId: '2', memberName: '小美', done: false, createdAt: 2 },
], '2').map(i => i.id), ['z', 'y', 'x']);
console.log('logic tests: all passed (remaining 27900, spent 5800, owes 3700)');
import { balances } from '../logic.js';
assert.deepEqual(balances(ms, es).map(b => [b.id, b.paid, b.share, b.net]), [['1', 3600, 3700, -100], ['2', 1600, 5300, -3700], ['3', 7500, 3700, 3800]]);
console.log('balances test passed');
// v1.1.2 helper-pays (我幫你買)
{
  const { summary, transfers, pendingOf, paidBy, isBought, parseInbox, parseItem } = await import('../logic.js');
  const m2 = [{ id: '1', name: 'A', start: 1000, cash: 1000, owner: true }, { id: '2', name: 'B', start: 1000, cash: 1000, owner: false }];
  const pp = [{ memberId: '1', title: 'x', amount: 800, method: 'CASH', at: 1, forId: '2' }];
  const s1 = summary('1', m2, [], pp), s2 = summary('2', m2, [], pp);
  assert.equal(s1.remainingCash, 1000 - 800); assert.equal(s1.spent, 0); assert.equal(s1.pending.length, 1);
  assert.equal(s2.remainingCash, 1000); assert.equal(s2.spent, 800); assert.equal(s2.pending.length, 1);
  assert.deepEqual(transfers(m2, [{ id: 'e', title: 'x', amount: 800, payerId: '1', method: 'CASH', at: 1, shares: { '2': 800 } }]), [{ fromId: '2', toId: '1', amount: 800 }]);
  assert.deepEqual(pendingOf([parseInbox('i', { memberId: '1', forMemberId: '2', type: 'buy', amount: 800, method: 'CASH', title: 'x', at: 1 }), parseInbox('j', { memberId: '3', type: 'buy', amount: 5 })]).map(p => p.forId), ['2', '3']);
  const it = parseItem('a', { done: false, helpers: { u1: { name: 'A', status: 'PAID', amount: 800, method: 'CASH', memberId: '1' }, u2: { name: 'C', status: 'FIND' } } });
  assert.equal(paidBy(it).amount, 800); assert.equal(isBought(it), true);
  assert.equal(isBought(parseItem('b', { done: false, helpers: { u2: { name: 'C', status: 'SEEN' } } })), false);
  console.log('helper-pays tests passed');
}

// v1.1.3 已當場還錢
{
  const { summary, transfers, resolve, repaidOf, repaidLine, repaidTag, parseItem } = await import('../logic.js');
  const m2 = [{ id: '1', name: '宏威', start: 10000, cash: 9200, owner: true }, { id: '2', name: '小美', start: 5000, cash: 5000, owner: false }];
  const e = { id: '9', title: '藥妝', amount: 800, payerId: '1', method: 'CASH', at: 0, shares: { '2': 800 } };
  assert.deepEqual(transfers(m2, [e]), [{ fromId: '2', toId: '1', amount: 800 }]);
  const repaidCash = [{ itemId: 'i', expenseId: '9', payerId: '1', payerName: '宏威', forId: '2', forName: '小美', title: '藥妝', amount: 800, originalMethod: 'CASH', repayMethod: 'CASH' }];
  const s1 = summary('1', m2, [e], [], repaidCash), s2 = summary('2', m2, [e], [], repaidCash);
  assert.equal(s1.remainingCash, 10000); assert.equal(s1.spent, 0); assert.equal(s1.transfers.length, 0);
  assert.equal(s2.remainingCash, 4200); assert.equal(s2.spent, 800); assert.equal(s2.transfers.length, 0);
  const books = resolve([e], [], repaidCash);
  assert.equal(books.expenses[0].payerId, '2'); assert.equal(books.expenses[0].method, 'CASH');
  assert.deepEqual(transfers(m2, books.expenses), []);
  const repaidXfer = [{ ...repaidCash[0], repayMethod: 'TRANSFER' }];
  const t1 = summary('1', m2, [e], [], repaidXfer), t2 = summary('2', m2, [e], [], repaidXfer);
  assert.equal(t1.remainingCash, 9200); assert.equal(t2.remainingCash, 5000); assert.equal(t2.spent, 800);
  assert.deepEqual(transfers(m2, resolve([e], [], repaidXfer).expenses), []);
  // before ingest
  const pre = [{ id: '1', name: '宏威', start: 10000, cash: 10000, owner: true }, { id: '2', name: '小美', start: 5000, cash: 5000, owner: false }];
  const pend = [{ memberId: '1', title: '藥妝', amount: 800, method: 'CASH', at: 0, forId: '2', itemId: 'i' }];
  const rPend = [{ itemId: 'i', expenseId: null, payerId: '1', payerName: '宏威', forId: '2', forName: '小美', title: '藥妝', amount: 800, originalMethod: 'CASH', repayMethod: 'CASH' }];
  const p1 = summary('1', pre, [], pend, rPend), p2 = summary('2', pre, [], pend, rPend);
  assert.equal(p1.remainingCash, 10000); assert.equal(p1.spent, 0);
  assert.equal(p2.remainingCash, 4200); assert.equal(p2.spent, 800);
  assert.equal(p2.pending[0].repaidLabel, '宏威 幫 小美 · 藥妝 · 已還');
  const rPendX = [{ ...rPend[0], repayMethod: 'TRANSFER' }];
  const x1 = summary('1', pre, [], pend, rPendX), x2 = summary('2', pre, [], pend, rPendX);
  assert.equal(x1.remainingCash, 9200); assert.equal(x2.remainingCash, 5000); assert.equal(x2.spent, 800);
  // card then cash repay
  const cardMs = [{ id: '1', name: '宏威', start: 10000, cash: 10000, owner: true }, { id: '2', name: '小美', start: 5000, cash: 5000, owner: false }];
  const cardE = { id: '9', title: '藥妝', amount: 800, payerId: '1', method: 'CARD', at: 0, shares: { '2': 800 } };
  const rCard = [{ itemId: 'i', expenseId: '9', payerId: '1', payerName: '宏威', forId: '2', forName: '小美', title: '藥妝', amount: 800, originalMethod: 'CARD', repayMethod: 'CASH' }];
  assert.equal(summary('1', cardMs, [cardE], [], rCard).remainingCash, 10800);
  assert.equal(summary('2', cardMs, [cardE], [], rCard).remainingCash, 4200);
  const it = parseItem('a', { name: '藥妝', qty: 1, memberId: '2', memberName: '小美', helpers: { u1: { name: '宏威', status: 'PAID', amount: 800, method: 'CASH', memberId: '1', repaid: true, repaidMethod: 'CASH' } } });
  const ro = repaidOf([it]);
  assert.equal(ro.length, 1); assert.equal(ro[0].repayMethod, 'CASH'); assert.equal(ro[0].forId, '2');
  assert.equal(repaidLine('宏威', '小美', '藥妝'), '宏威 幫 小美 · 藥妝 · 已還');
  assert.equal(repaidTag('CASH'), '已還 💵');
  console.log('repay tests passed');
}

{
  const { joinUrl, inviteShareText, displayCode, normalizeCode } = await import('../logic.js');
  assert.equal(joinUrl('abcd-ef'), 'https://qa29173687-ship-it.github.io/tripbook-web/#/join/ABCDEF');
  assert.equal(joinUrl('8K3QTR'), 'https://qa29173687-ship-it.github.io/tripbook-web/#/join/8K3QTR');
  assert.equal(normalizeCode('8k3q-tr '), '8K3QTR');
  const t = inviteShareText('東京三日遊', 'abcdef');
  assert.ok(t.includes('https://qa29173687-ship-it.github.io/tripbook-web/#/join/ABCDEF'));
  assert.ok(t.includes('邀請碼 ABCD-EF'));
  assert.ok(t.startsWith('一起用旅伴帳記「東京三日遊」！'));
  assert.ok(t.includes('點這裡加入：'));
  assert.ok(t.includes('iPhone 建議用 Safari 開'));
  assert.ok(t.includes('Android 也可以用旅伴帳 App 輸入邀請碼'));
  const plain = inviteShareText('', '8K3QTR');
  assert.ok(plain.startsWith('一起用旅伴帳記帳！'));
  assert.equal(displayCode('8K3QTR'), '8K3Q-TR');
  console.log('invite share text tests passed');
}
