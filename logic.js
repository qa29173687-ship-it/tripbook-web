// Pure logic ported 1:1 from the Android app (domain/SharedView.kt, SplitMath.kt, ShoppingText.kt, util/Money.kt).
// Amounts are whole currency units stored as integers (named "cents" in Kotlin).

/** SplitMath.nets */
export function nets(paid, share, allIds) {
  return [...new Set(allIds)].map(id => {
    const p = paid.get(id) || 0, s = share.get(id) || 0;
    return { memberId: id, paid: p, share: s, net: p - s };
  });
}

/** SplitMath.minimizeTransfers: greedy largest debtor ↔ largest creditor (stable sort like Kotlin). */
export function minimizeTransfers(balances) {
  const creditors = balances.filter(b => b.net > 0).map(b => ({ id: b.memberId, amount: b.net })).sort((a, b) => b.amount - a.amount);
  const debtors = balances.filter(b => b.net < 0).map(b => ({ id: b.memberId, amount: -b.net })).sort((a, b) => b.amount - a.amount);
  const out = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const pay = Math.min(d.amount, c.amount);
    if (pay > 0) out.push({ from: d.id, to: c.id, amount: pay });
    d.amount -= pay; c.amount -= pay;
    if (d.amount === 0) i++;
    if (c.amount === 0) j++;
  }
  return out;
}

/** SharedView.transfers → [{fromId,toId,amount}] */
export function transfers(members, expenses) {
  const ids = members.map(m => m.id);
  const idx = new Map(ids.map((id, i) => [id, i + 1]));
  const paid = new Map(), share = new Map();
  for (const e of expenses) {
    const p = idx.get(e.payerId);
    if (p !== undefined) paid.set(p, (paid.get(p) || 0) + e.amount);
    for (const [mid, c] of Object.entries(e.shares || {})) {
      const k = idx.get(mid);
      if (k !== undefined) share.set(k, (share.get(k) || 0) + c);
    }
  }
  const back = new Map([...idx.entries()].map(([k, v]) => [v, k]));
  return minimizeTransfers(nets(paid, share, [...idx.values()]))
    .map(t => ({ fromId: back.get(t.from), toId: back.get(t.to), amount: t.amount }));
}

/** SharedView.summary — companion's read-only view. */
export function summary(meId, members, expenses, pending) {
  const me = members.find(m => m.id === meId);
  const myPending = pending.filter(p => p.memberId === meId);
  const pendingCash = myPending.filter(p => p.method === 'CASH').reduce((s, p) => s + p.amount, 0);
  const spent = expenses.reduce((s, e) => s + ((e.shares || {})[meId] || 0), 0) + myPending.reduce((s, p) => s + p.amount, 0);
  return {
    remainingCash: (me ? me.cash : 0) - pendingCash,
    startCash: me ? me.start : 0,
    spent,
    transfers: transfers(members, expenses).filter(t => t.fromId === meId || t.toId === meId),
    related: expenses.filter(e => e.payerId === meId || ((e.shares || {})[meId] || 0) > 0).slice().sort((a, b) => b.at - a.at),
    pending: myPending,
  };
}

/** Cloud.pendingOf */
export function pendingOf(inbox) {
  return inbox.filter(x => x.type === 'buy').map(x => ({ memberId: x.memberId, title: x.title, amount: x.amount, method: x.method, at: x.at }));
}

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newInviteCode() {
  const r = new Uint32Array(6); crypto.getRandomValues(r);
  return [...r].map(n => CODE_CHARS[n % CODE_CHARS.length]).join('');
}
export const displayCode = code => code.length === 6 ? code.slice(0, 4) + '-' + code.slice(4) : code;
export const normalizeCode = input => [...input.toUpperCase()].filter(ch => /[\p{L}\p{N}]/u.test(ch)).join('');

/** ShoppingText */
export function itemName(name, hasPhoto) { const n = name.trim(); return n || (hasPhoto ? '照片裡的東西' : '要買的東西'); }
export function expenseTitle(name, qty) { const n = name.trim() || '購物'; return qty > 1 ? `${n} ×${qty}` : n; }

/** Money.format */
export function money(amount, currency = 'TWD') {
  const n = Number(amount || 0).toLocaleString('zh-TW');
  switch (currency) {
    case 'TWD': case 'NTD': return `NT$${n}`;
    case 'JPY': return `¥${n}`;
    case 'USD': return `US$${n}`;
    default: return `${currency} ${n}`;
  }
}

/** Parsers mirroring Cloud.parse* (input: plain data object + id). */
const num = v => (typeof v === 'number' ? Math.trunc(v) : 0);
export function parseTrip(id, d) {
  if (!d) return null;
  return {
    id, name: d.name || '', currency: d.currency || 'TWD', ownerUid: d.ownerUid || '', ownerName: d.ownerName || '',
    inviteCode: d.inviteCode || '', startDate: d.startDate || '', endDate: d.endDate || '',
    members: (Array.isArray(d.members) ? d.members : []).map(m => ({ id: String(m.id), name: m.name || '', start: num(m.start), cash: num(m.cash), owner: m.owner === true })),
  };
}
export function parseExpense(id, d) {
  const shares = {};
  for (const [k, v] of Object.entries(d.shares || {})) shares[k] = num(v);
  return { id, title: d.title || '', amount: num(d.amount), payerId: d.payerId || '', method: d.method || 'CARD', at: num(d.at), category: d.category || '', shares };
}
export function parseItem(id, d) {
  const helpers = {};
  for (const [k, v] of Object.entries(d.helpers || {})) helpers[k] = { name: (v && v.name) || '', status: (v && v.status) || 'FIND' };
  return {
    id, ownerUid: d.ownerUid || '', memberId: d.memberId || '', memberName: d.memberName || '', name: d.name || '',
    qty: d.qty == null ? 1 : num(d.qty), note: d.note || '', photo: d.photo ? d.photo : null, done: d.done === true,
    amount: num(d.amount), method: d.method || 'CASH', expenseId: d.expenseId ?? null, helpers, createdAt: num(d.createdAt),
  };
}
export function parseInbox(id, d) {
  return { id, byUid: d.byUid || '', memberId: d.memberId || '', memberName: d.memberName || '', itemId: d.itemId || '', type: d.type || 'buy', title: d.title || '', amount: num(d.amount), method: d.method || 'CASH', at: num(d.at) };
}

/** SharedShoppingPane sort: mine first, then memberName, undone first, createdAt. */
export function sortItems(items, myMemberId) {
  return items.slice().sort((a, b) =>
    ((a.memberId !== myMemberId) - (b.memberId !== myMemberId)) ||
    (a.memberName < b.memberName ? -1 : a.memberName > b.memberName ? 1 : 0) ||
    (a.done - b.done) || (a.createdAt - b.createdAt));
}
