// 旅伴帳 網頁版 — mirrors the Android app's cloud sharing (tw.tripbook.cloud.Cloud / OwnerSync / SharedView).
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, linkWithPopup, signInWithCredential, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, doc, getDoc, collection, query,
  where, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, setDoc, deleteField, FieldPath,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './config.js';
import {
  summary, transfers, balances, pendingOf, displayCode, normalizeCode, itemName, expenseTitle, money,
  parseTrip, parseExpense, parseItem, parseInbox, sortItems, paidBy, isBought,
  resolve, repaidOf, repaidTag, repaidLine,
} from './logic.js';

// ---------- Firebase ----------
const fb = initializeApp(firebaseConfig);
const auth = getAuth(fb);
let db;
try { db = initializeFirestore(fb, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch (_) { db = getFirestore(fb); }

let authReadyResolve;
const authReady = new Promise(r => (authReadyResolve = r));
onAuthStateChanged(auth, () => { authReadyResolve(); if (location.hash === '' || location.hash === '#/' || location.hash.startsWith('#/owner')) route(); });
getRedirectResult(auth).catch(e => console.warn('redirect', e));

const isGoogle = () => !!auth.currentUser?.providerData?.some(p => p.providerId === 'google.com');
const googleEmail = () => auth.currentUser?.providerData?.find(p => p.providerId === 'google.com')?.email || '';
async function ensureSignedIn() { await authReady; return auth.currentUser || (await signInAnonymously(auth)).user; }

/** 主帳號 Google sign-in; an anonymous identity on this browser is upgraded (same uid), like Cloud.signInGoogle. */
async function signInGoogle() {
  await authReady;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cur = auth.currentUser;
  try {
    if (cur && cur.isAnonymous) {
      try { return (await linkWithPopup(cur, provider)).user; }
      catch (e) {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if ((e.code === 'auth/credential-already-in-use' || e.code === 'auth/email-already-in-use') && cred) return (await signInWithCredential(auth, cred)).user;
        throw e;
      }
    }
    return (await signInWithPopup(auth, provider)).user;
  } catch (e) {
    if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider); return null;
    }
    throw e;
  }
}

const tripRef = id => doc(db, 'trips', id);
const sub = (id, name) => collection(db, 'trips', id, name);

// ---------- Cloud writes (same fields as Cloud.kt) ----------
const Cloud = {
  addItem: (tripId, memberId, memberName, name, photo) => {
    const now = Date.now();
    return addDoc(sub(tripId, 'shopping'), {
      ownerUid: auth.currentUser.uid, memberId, memberName, name, qty: 1, note: '', photo: photo || '',
      done: false, amount: 0, method: 'CASH', helpers: {}, createdAt: now, updatedAt: now,
    });
  },
  updateItem: (tripId, itemId, fields) => updateDoc(doc(db, 'trips', tripId, 'shopping', itemId), { ...fields, updatedAt: Date.now() }),
  deleteItem: (tripId, itemId) => deleteDoc(doc(db, 'trips', tripId, 'shopping', itemId)),
  setHelp: (tripId, itemId, name, status) => updateDoc(doc(db, 'trips', tripId, 'shopping', itemId),
    new FieldPath('helpers', auth.currentUser.uid), status == null ? deleteField() : { name, status }, 'updatedAt', Date.now()),
  /** Cloud.companionBuy — also used for the owner on the web, so the Android 主帳號 phone records the expense. */
  buy: async (tripId, item, memberName, title, amount, method) => {
    await Cloud.updateItem(tripId, item.id, { done: true, amount, method });
    await addDoc(sub(tripId, 'inbox'), {
      byUid: auth.currentUser.uid, memberId: item.memberId, memberName, itemId: item.id,
      type: 'buy', title, amount, method, at: Date.now(),
    });
  },
  /** Cloud.companionUnbuy */
  unbuy: async (tripId, item, memberName) => {
    await Cloud.updateItem(tripId, item.id, { done: false, amount: 0 });
    await addDoc(sub(tripId, 'inbox'), {
      byUid: auth.currentUser.uid, memberId: item.memberId, memberName, itemId: item.id,
      type: 'unbuy', title: item.name, amount: 0, method: item.method, at: Date.now(),
    });
  },
  /** Cloud.helperBuy: I pay for someone else's item; the Android 主帳號 phone records it as my expense shared only by them. */
  helperBuy: async (tripId, item, myMemberId, myName, title, amount, method) => {
    const uid = auth.currentUser.uid;
    await updateDoc(doc(db, 'trips', tripId, 'shopping', item.id),
      new FieldPath('helpers', uid), { name: myName, status: 'PAID', amount, method, memberId: myMemberId }, 'updatedAt', Date.now());
    await addDoc(sub(tripId, 'inbox'), {
      byUid: uid, memberId: myMemberId, memberName: myName, forMemberId: item.memberId,
      itemId: item.id, type: 'buy', title, amount, method, at: Date.now(),
    });
  },
  /** Cloud.helperUnbuy */
  helperUnbuy: async (tripId, item, myMemberId, myName) => {
    const uid = auth.currentUser.uid;
    await updateDoc(doc(db, 'trips', tripId, 'shopping', item.id), new FieldPath('helpers', uid), deleteField(), 'updatedAt', Date.now());
    await addDoc(sub(tripId, 'inbox'), {
      byUid: uid, memberId: myMemberId, memberName: myName, forMemberId: item.memberId,
      itemId: item.id, type: 'unbuy', title: item.name, amount: 0, method: 'CASH', at: Date.now(),
    });
  },
  helperRepay: async (tripId, item, myName, repayMethod) => {
    const uid = auth.currentUser.uid;
    const entry = Object.entries(item.helpers || {}).find(([, h]) => h.status === 'PAID');
    if (!entry) return;
    const [hUid, h] = entry;
    await updateDoc(doc(db, 'trips', tripId, 'shopping', item.id),
      new FieldPath('helpers', hUid), {
        name: h.name, status: 'PAID', amount: h.amount, method: h.method, memberId: h.memberId,
        repaid: true, repaidMethod: repayMethod,
      }, 'updatedAt', Date.now());
    await addDoc(sub(tripId, 'inbox'), {
      byUid: uid, memberId: h.memberId, memberName: myName, forMemberId: item.memberId,
      itemId: item.id, type: 'repay', title: expenseTitle(item.name, item.qty),
      amount: h.amount, method: repayMethod, at: Date.now(),
    });
  },
  helperUnrepay: async (tripId, item, myName) => {
    const uid = auth.currentUser.uid;
    const entry = Object.entries(item.helpers || {}).find(([, h]) => h.status === 'PAID');
    if (!entry) return;
    const [hUid, h] = entry;
    await updateDoc(doc(db, 'trips', tripId, 'shopping', item.id),
      new FieldPath('helpers', hUid), {
        name: h.name, status: 'PAID', amount: h.amount, method: h.method, memberId: h.memberId,
        repaid: false, repaidMethod: '',
      }, 'updatedAt', Date.now());
    await addDoc(sub(tripId, 'inbox'), {
      byUid: uid, memberId: h.memberId, memberName: myName, forMemberId: item.memberId,
      itemId: item.id, type: 'unrepay', title: expenseTitle(item.name, item.qty),
      amount: h.amount, method: h.method, at: Date.now(),
    });
  },
  lookupInvite: async code => {
    const inv = await getDoc(doc(db, 'invites', code));
    const tid = inv.exists() ? inv.data().tripId : null;
    if (!tid) return null;
    const t = await getDoc(tripRef(tid));
    return t.exists() ? parseTrip(t.id, t.data()) : null;
  },
  join: (t, memberId, name) => setDoc(doc(db, 'trips', t.id, 'joins', auth.currentUser.uid), { memberId, name, code: t.inviteCode, at: Date.now() }),
};

/** Cloud.photoToBase64: shrink to 720px JPEG quality 70, base64 without prefix. */
async function photoToBase64(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 720 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.floor(img.naturalWidth * scale)), hgt = Math.max(1, Math.floor(img.naturalHeight * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = hgt;
    c.getContext('2d').drawImage(img, 0, 0, w, hgt);
    return c.toDataURL('image/jpeg', 0.7).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}

// ---------- local store (ShareStore.joined) ----------
const JKEY = 'tripbook.joined';
const joined = () => { try { return JSON.parse(localStorage.getItem(JKEY) || '[]'); } catch { return []; } };
const addJoined = j => localStorage.setItem(JKEY, JSON.stringify([...joined().filter(x => x.cloudId !== j.cloudId), j]));
const removeJoined = id => localStorage.setItem(JKEY, JSON.stringify(joined().filter(x => x.cloudId !== id)));

// ---------- tiny UI helpers ----------
const $app = document.getElementById('app');
const $dlg = document.getElementById('dlg');
const $toast = document.getElementById('toast');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imgSrc = b64 => (/^[A-Za-z0-9+/=\r\n]+$/.test(b64 || '') ? `data:image/jpeg;base64,${b64.replace(/\s/g, '')}` : '');
const fmtMD = at => new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric', timeZone: 'Asia/Taipei' }).format(new Date(at)).replace('月', '/').replace('日', '');
const methodLabel = m => ({ CASH: '現金', CARD: '刷卡', TRANSFER: '轉帳', POOL: '公款' }[m] || '');
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let toastTimer;
function toast(msg) { $toast.textContent = msg; $toast.classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.classList.add('hidden'), 2600); }
function openDialog(html, bind) {
  $dlg.innerHTML = html; $dlg.classList.remove('hidden');
  $dlg.onclick = e => { if (e.target === $dlg) closeDialog(); };
  bind && bind($dlg);
}
function closeDialog() { $dlg.classList.add('hidden'); $dlg.innerHTML = ''; }
function confirmRemoveJoined(id, name) {
  openDialog(`<div class="sheet"><h2>刪除這趟旅行${name ? `「${esc(name)}」` : ''}？</h2>
    <div class="muted">確定要從你的清單刪除這趟旅行？不會影響主帳號和其他旅伴的資料，之後可用邀請碼重新加入。</div>
    <div class="btns"><button class="btn ghost" id="keep">保留</button><button class="btn peach" id="un">刪除這趟旅行</button></div></div>`, d => {
    d.querySelector('#keep').onclick = closeDialog;
    d.querySelector('#un').onclick = () => { closeDialog(); removeJoined(id); toast('已從清單刪除'); if (location.hash === '#/' || location.hash === '' || location.hash === '#') route(); else go('#/'); };
  });
}
function viewPhoto(b64) {
  openDialog(`<div class="viewer"><img src="${imgSrc(b64)}" alt="商品照片"><div>點一下關閉</div></div>`, d => { d.querySelector('.viewer').onclick = closeDialog; });
}
function pickFile() {
  return new Promise(res => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*';
    i.onchange = () => res(i.files && i.files[0] ? i.files[0] : null);
    i.click();
  });
}
const NET_ERR = '沒有連上網路或沒有權限，請再試一次';

// ---------- router ----------
let cleanups = [];
let gen = 0; // bumps on every route so late async work from an old page is dropped
function cleanup() { cleanups.forEach(f => { try { f(); } catch { } }); cleanups = []; closeDialog(); }
window.addEventListener('hashchange', route);
function go(h) { if (location.hash === h) route(); else location.hash = h; }

async function route() {
  cleanup();
  gen++;
  const parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === 'join') return viewJoin(parts[1] || '');
    if (parts[0] === 't' && parts[1]) return viewCompanion(parts[1], parts[2] === 'me' ? 1 : parts[2] === 'split' ? 2 : 0);
    if (parts[0] === 'owner') return viewOwnerHome();
    if (parts[0] === 'o' && parts[1]) return viewOwnerTrip(parts[1], parts[2] || 'invite');
    return viewHome();
  } catch (e) { console.error(e); $app.innerHTML = `<div class="body"><div class="card">出錯了：${esc(e.message)}</div><a class="btn" href="#/">回首頁</a></div>`; }
}

// ---------- Home ----------
async function viewHome() {
  const js = joined();
  $app.innerHTML = `
    <div class="top"><div class="t"><div class="brand">旅伴帳</div><div class="sub">旅伴共享 · 網頁版</div></div></div>
    <div class="body">
      ${isIOS && !standalone ? `<div class="note peach">📱 iPhone：先按 Safari 下方的「分享」→「加入主畫面」，再從主畫面的旅伴帳打開並輸入邀請碼。<br><span class="small">主畫面和 Safari 的身分是分開的，在哪裡加入就要在哪裡用。</span></div>` : ''}
      <div class="sec">旅伴分享給我的</div>
      ${js.length ? js.map(j => `
        <div class="card tap row" data-go="#/t/${encodeURIComponent(j.cloudId)}">
          <div class="grow"><div class="iname">${esc(j.tripName || '共享旅程')}</div><div class="muted small">我是${esc(j.memberName)}</div></div>
          <button class="icon-del" data-rm="${esc(j.cloudId)}" data-name="${esc(j.tripName || '共享旅程')}" aria-label="刪除這趟旅行">🗑</button>
          <span class="chip">打開 ›</span>
        </div>`).join('') : `<div class="muted">還沒有加入旅程。拿到主帳號給的邀請碼後按下面加入。</div>`}
      <a class="btn" href="#/join">＋ 輸入邀請碼加入</a>
      <div class="sec" style="margin-top:18px">主帳號</div>
      <div class="card" id="ownerBox"><div class="muted">讀取中…</div></div>
    </div>`;
  $app.querySelectorAll('[data-go]').forEach(el => (el.onclick = () => go(el.dataset.go)));
  $app.querySelectorAll('[data-rm]').forEach(el => (el.onclick = ev => {
    ev.stopPropagation(); ev.preventDefault();
    confirmRemoveJoined(el.dataset.rm, el.dataset.name);
  }));
  const g = gen;
  await authReady;
  if (g !== gen) return;
  const box = $app.querySelector('#ownerBox'); if (!box) return;
  if (isGoogle()) {
    box.innerHTML = `<div class="muted small">已用 Google 登入：${esc(googleEmail())}</div><div style="height:10px"></div>
      <a class="btn ghost" href="#/owner">我的共享旅程 ›</a><button class="link red" id="so">登出</button>`;
    box.querySelector('#so').onclick = async () => {
      if (!confirm('登出 Google？登出後這個瀏覽器加入的旅程需要重新輸入邀請碼。')) return;
      await signOut(auth); route();
    };
  } else {
    box.innerHTML = `<div class="muted">開旅程的人（主帳號）用 Google 登入，可以看邀請碼、大家的我要買和分帳。旅伴不用登入。</div><div style="height:10px"></div>
      <button class="btn ghost" id="gl">用 Google 登入</button>`;
    box.querySelector('#gl').onclick = async e => {
      e.target.disabled = true; e.target.textContent = '登入中…';
      try { const u = await signInGoogle(); if (u) go('#/owner'); }
      catch (err) { console.warn(err); toast('Google 登入沒有完成，請再試一次'); e.target.disabled = false; e.target.textContent = '用 Google 登入'; }
    };
  }
}

// ---------- Join (JoinScreen) ----------
async function viewJoin(prefill) {
  $app.innerHTML = `
    <div class="top"><button class="back" data-back>‹</button><div class="t"><h1>加入旅伴的旅程</h1></div></div>
    <div class="body" id="jb"></div>`;
  $app.querySelector('[data-back]').onclick = () => go('#/');
  const jb = $app.querySelector('#jb');
  let busy = false;
  const step1 = (err = '') => {
    jb.innerHTML = `
      <div class="muted">輸入主帳號給你的邀請碼，不用登入。</div>
      <div class="field"><span class="lbl">邀請碼</span><input id="code" type="text" autocapitalize="characters" autocomplete="off" placeholder="例如 8K3Q-TR" value="${esc(prefill ? displayCode(normalizeCode(prefill)) : '')}"></div>
      ${err ? `<div class="warn">${esc(err)}</div>` : ''}
      <button class="btn" id="next">下一步</button>`;
    const input = jb.querySelector('#code');
    input.oninput = () => { const p = input.selectionStart; input.value = input.value.toUpperCase(); input.setSelectionRange(p, p); };
    input.onkeydown = e => { if (e.key === 'Enter') jb.querySelector('#next').click(); };
    jb.querySelector('#next').onclick = async e => {
      const c = normalizeCode(input.value);
      if (c.length !== 6 || busy) { if (!busy) step1('邀請碼是 6 個英文或數字'); return; }
      busy = true; e.target.textContent = '查詢中…'; e.target.disabled = true;
      try {
        await ensureSignedIn();
        const t = await Cloud.lookupInvite(c);
        busy = false;
        if (!t) { prefill = c; step1('找不到這個邀請碼，請再確認一次'); } else step2(t);
      } catch (err) { console.warn(err); busy = false; prefill = c; step1('連不上網路，請再試一次'); }
    };
  };
  const step2 = (t, err = '') => {
    const ms = t.members.filter(m => !m.owner);
    jb.innerHTML = `
      <div class="card"><div class="iname">${esc(t.name)}</div><div class="muted">${esc(t.ownerName)} 邀請你一起記帳</div></div>
      <div style="font-weight:700">你是哪一位？</div>
      ${ms.map(m => `<button class="member" data-m="${esc(m.id)}">我是${esc(m.name)}</button>`).join('')}
      ${ms.length ? '' : `<div class="warn">主帳號還沒加旅伴，請他先在「旅伴」頁把你加進去。</div>`}
      ${err ? `<div class="warn">${esc(err)}</div>` : ''}
      <button class="link" id="again">換一個邀請碼</button>`;
    jb.querySelector('#again').onclick = () => { prefill = ''; step1(); };
    jb.querySelectorAll('[data-m]').forEach(b => (b.onclick = async () => {
      if (busy) return; busy = true;
      const m = ms.find(x => x.id === b.dataset.m);
      try {
        await ensureSignedIn();
        await Cloud.join(t, m.id, m.name);
        addJoined({ cloudId: t.id, memberId: m.id, memberName: m.name, tripName: t.name });
        go(`#/t/${encodeURIComponent(t.id)}`);
      } catch (e) { console.warn(e); busy = false; step2(t, '加入失敗，請再試一次'); }
    }));
  };
  step1();
}

// ---------- live data for a trip ----------
function liveTrip(tripId, want, onChange, onDenied) {
  const S = { trip: undefined, items: [], expenses: [], inbox: [], joins: [] };
  const err = e => { console.warn(e); if (e.code === 'permission-denied') onDenied && onDenied(); };
  cleanups.push(onSnapshot(tripRef(tripId), s => { S.trip = s.exists() ? parseTrip(s.id, s.data()) : null; onChange('trip'); }, err));
  if (want.includes('items')) cleanups.push(onSnapshot(query(sub(tripId, 'shopping'), orderBy('createdAt')), s => { S.items = s.docs.map(d => parseItem(d.id, d.data())); onChange('items'); }, err));
  if (want.includes('expenses')) cleanups.push(onSnapshot(sub(tripId, 'expenses'), s => { S.expenses = s.docs.map(d => parseExpense(d.id, d.data())); onChange('expenses'); }, err));
  if (want.includes('inbox')) cleanups.push(onSnapshot(sub(tripId, 'inbox'), s => { S.inbox = s.docs.map(d => parseInbox(d.id, d.data())); onChange('inbox'); }, err));
  if (want.includes('joins')) cleanups.push(onSnapshot(sub(tripId, 'joins'), s => { S.joins = s.docs.map(d => ({ uid: d.id, memberId: d.data().memberId || '', name: d.data().name || '' })); onChange('joins'); }, err));
  return S;
}

// ---------- Shared 我要買 pane (SharedShoppingPane) ----------
// ctx: { tripId, S, me(): {memberId, name}, canEditAll, onBuy(item, amount, method), onUnbuy(item) }
function mountShopping(container, ctx) {
  let filter = 'me', pendingPhoto = null, busy = false, error = '';
  container.innerHTML = `<div class="body" id="shopList"></div>
    <div class="composer">
      <button class="cam" id="cam" aria-label="加照片">📷</button>
      <input id="newName" type="text" placeholder="寫下我要買的東西" enterkeyhint="done">
      <button class="add" id="add" aria-label="新增">＋</button>
    </div>`;
  const list = container.querySelector('#shopList');
  const cam = container.querySelector('#cam');
  const nameInput = container.querySelector('#newName');
  const run = async fn => { busy = true; try { await fn(); } catch (e) { console.warn(e); error = NET_ERR; render(); } busy = false; };

  const renderCam = () => {
    if (pendingPhoto) { cam.style.backgroundImage = `url(${imgSrc(pendingPhoto)})`; cam.innerHTML = '<span class="x">✕</span>'; nameInput.placeholder = '名稱（可留白）'; }
    else { cam.style.backgroundImage = ''; cam.textContent = '📷'; nameInput.placeholder = '寫下我要買的東西'; }
  };
  cam.onclick = async () => {
    if (pendingPhoto) { pendingPhoto = null; renderCam(); return; }
    const f = await pickFile(); if (!f) return;
    try { pendingPhoto = await photoToBase64(f); renderCam(); } catch { toast('這張照片讀不到，換一張試試'); }
  };
  const doAdd = () => {
    const raw = nameInput.value;
    if ((!raw.trim() && !pendingPhoto) || busy) return;
    const me = ctx.me(); if (!me) return;
    const n = itemName(raw, !!pendingPhoto), p = pendingPhoto;
    nameInput.value = ''; pendingPhoto = null; filter = 'me'; renderCam(); render();
    run(() => Cloud.addItem(ctx.tripId, me.memberId, me.name, n, p));
  };
  container.querySelector('#add').onclick = doAdd;
  nameInput.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) doAdd(); };

  function render() {
    const me = ctx.me();
    const S = ctx.S, cur = S.trip?.currency || 'TWD';
    if (!me) { list.innerHTML = `<div class="muted">讀取中…</div>`; return; }
    const uid = auth.currentUser?.uid;
    const members = S.trip?.members || [];
    const sum = summary(me.memberId, members, S.expenses, pendingOf(S.inbox), repaidOf(S.items));
    const mine = S.items.filter(i => i.memberId === me.memberId);
    const shown = sortItems(filter === 'me' ? mine : filter === 'all' ? S.items : S.items.filter(i => i.memberId === filter), me.memberId);
    const others = members.filter(m => m.id !== me.memberId);
    let lastOwner = null, rows = '';
    for (const it of shown) {
      const own = it.memberId === me.memberId;
      if (filter === 'all' && it.memberId !== lastOwner) {
        lastOwner = it.memberId;
        rows += `<div class="sec">${own ? '我的清單' : `${esc(it.memberName)}的清單${ctx.canEditAll ? '' : '（只能看，可以幫找）'}`}</div>`;
      }
      const myHelp = uid ? it.helpers[uid]?.status : null;
      const bought = isBought(it), pb = paidBy(it);
      const helpers = Object.entries(it.helpers).filter(([k, h]) => k !== uid && h.status !== 'PAID').map(([, h]) =>
        `<div class="helper">${h.status === 'SEEN' ? `👀 ${esc(h.name)} 看到了` : `🔍 ${esc(h.name)} 在幫找`}</div>`).join('');
      rows += `<div class="card item" data-edit="${esc(it.id)}">
        <div class="check ${bought ? 'done' : ''} ${own && !pb ? '' : 'dis'}" data-check="${esc(it.id)}">${bought ? '✓' : ''}</div>
        ${it.photo ? `<div class="thumb" data-photo="${esc(it.id)}" style="background-image:url(${imgSrc(it.photo)})"></div>` : ''}
        <div class="grow">
          <div class="iname ${bought ? 'done' : ''}">${esc(it.qty > 1 ? `${it.name} ×${it.qty}` : it.name)}</div>
          ${own ? '' : `<div class="muted small">${esc(it.memberName)} 要的</div>`}
          ${it.note.trim() ? `<div class="muted small">${esc(it.note)}</div>` : ''}
          ${pb ? `<div class="paid">💰 ${myHelp === 'PAID' ? '我' : esc(pb.name)} 幫${own ? '你' : esc(it.memberName)}買了 ${money(pb.amount, cur)}（${pb.method === 'CASH' ? '現金' : '信用卡'}）${pb.repaid ? ' · ' + repaidTag(pb.repaidMethod) : ' · 分帳自動算'}</div>` : ''}
          ${it.done && !pb && it.amount > 0 ? `<div class="paid">${it.method === 'CASH' ? `現金 ${money(it.amount, cur)}${own ? ' · 已扣剩餘現金' : ''}` : `信用卡 ${money(it.amount, cur)}`}</div>` : ''}
          ${helpers}
        </div>
        ${(() => {
          const canRepay = !!pb && (ctx.canEditAll || own || myHelp === 'PAID');
          if (canRepay) {
            return `<div class="tags">${pb.repaid
              ? `<button class="tag" data-unrepay="${esc(it.id)}">取消已還</button>`
              : `<button class="tag" data-repay="${esc(it.id)}">已當場還錢</button>`}
              ${myHelp === 'PAID' ? `<button class="tag" data-payfor="${esc(it.id)}">取消幫買</button>` : ''}</div>`;
          }
          if (!own && !bought) return `<div class="tags">
          <button class="tag ${myHelp === 'FIND' ? 'on' : ''}" data-help="FIND" data-id="${esc(it.id)}">我幫你找</button>
          <button class="tag ${myHelp === 'SEEN' ? 'on' : ''}" data-help="SEEN" data-id="${esc(it.id)}">我看到了</button>
          <button class="tag" data-payfor="${esc(it.id)}">我幫你買</button></div>`;
          return '';
        })()}
      </div>`;
    }
    list.innerHTML = `
      <div class="card row">
        <div class="grow"><div class="lbl">💵 我的剩餘現金</div><div style="font-size:26px;font-weight:900">${money(sum.remainingCash, cur)}</div><div class="muted small">初始 ${money(sum.startCash, cur)}</div></div>
        <div style="text-align:right"><div class="lbl">我已買</div><div style="font-size:22px;font-weight:900;color:var(--mintDeep)">${mine.filter(i => i.done).length} / ${mine.length}</div></div>
      </div>
      <div class="pills">
        <button class="pill ${filter === 'me' ? 'on' : ''}" data-f="me">我的</button>
        ${others.map(m => `<button class="pill ${filter === m.id ? 'on' : ''}" data-f="${esc(m.id)}">${esc(m.name)}的</button>`).join('')}
        <button class="pill ${filter === 'all' ? 'on' : ''}" data-f="all">全部</button>
      </div>
      ${error ? `<div class="warn" id="err">${esc(error)}</div>` : ''}
      ${shown.length ? rows : `<div class="muted" style="padding:8px">${filter === 'me' ? '把想買的東西寫在這裡，可以拍照。旅伴都看得到，可以幫你找。' : '這裡還沒有東西。'}</div>`}`;
    list.querySelectorAll('[data-f]').forEach(b => (b.onclick = () => { filter = b.dataset.f; render(); }));
    const e = list.querySelector('#err'); if (e) e.onclick = () => { error = ''; render(); };
    const byId = id => S.items.find(i => i.id === id);
    list.querySelectorAll('[data-photo]').forEach(el => (el.onclick = ev => { ev.stopPropagation(); const it = byId(el.dataset.photo); it && viewPhoto(it.photo); }));
    list.querySelectorAll('[data-help]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation(); const it = byId(el.dataset.id); if (!it) return;
      const curS = it.helpers[uid]?.status; const st = el.dataset.help;
      run(() => Cloud.setHelp(ctx.tripId, it.id, me.name, curS === st ? null : st));
    }));
    list.querySelectorAll('[data-check]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation(); const it = byId(el.dataset.check);
      if (!it || it.memberId !== me.memberId || paidBy(it) || busy) return;
      if (it.done) confirmUntick(it); else boughtDialog(it, sum.remainingCash, cur);
    }));
    list.querySelectorAll('[data-payfor]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation(); const it = byId(el.dataset.payfor); if (!it || busy) return;
      if (uid && it.helpers[uid]?.status === 'PAID') confirmHelperUntick(it, me);
      else boughtDialog(it, sum.remainingCash, cur, it.memberName, (a, m) => Cloud.helperBuy(ctx.tripId, it, me.memberId, me.name, expenseTitle(it.name, it.qty), a, m));
    }));
    list.querySelectorAll('[data-repay]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation(); const it = byId(el.dataset.repay); if (!it || busy) return;
      repayDialog(it, me, cur);
    }));
    list.querySelectorAll('[data-unrepay]').forEach(el => (el.onclick = ev => {
      ev.stopPropagation(); const it = byId(el.dataset.unrepay); if (!it || busy) return;
      confirmUnrepay(it, me);
    }));
    list.querySelectorAll('[data-edit]').forEach(el => (el.onclick = () => {
      const it = byId(el.dataset.edit); if (!it) return;
      if (it.memberId === me.memberId || ctx.canEditAll) editDialog(it);
    }));
  }

  function boughtDialog(item, remaining, cur, forName = null, onConfirm = null) {
    let method = 'CASH';
    openDialog(`<div class="sheet">
      <h2>${forName != null ? `幫${esc(forName)}買到了！` : '買到了！'}${esc(item.qty > 1 ? `${item.name} ×${item.qty}` : item.name)}</h2>
      ${forName != null ? `<div class="muted small">你先付，這筆算在${esc(forName)}身上，分帳會自動算他要還你</div>` : ''}
      ${item.photo ? `<div class="thumb" style="width:96px;height:96px;background-image:url(${imgSrc(item.photo)})"></div>` : ''}
      <div class="field"><span class="lbl">實付金額</span><input id="amt" type="number" inputmode="numeric" pattern="[0-9]*" min="1"></div>
      <div class="lbl">付款方式</div>
      <div class="pills"><button class="pill on" data-m="CASH">現金</button><button class="pill" data-m="CARD">信用卡</button></div>
      <div id="hint"></div>
      <div class="btns"><button class="btn ghost" id="cancel">取消</button><button class="btn" id="ok" disabled>打勾並記帳</button></div>
    </div>`, d => {
      const amt = d.querySelector('#amt'), ok = d.querySelector('#ok'), hint = d.querySelector('#hint');
      const val = () => Math.max(0, parseInt(amt.value, 10) || 0);
      const upd = () => {
        const a = val(); ok.disabled = a <= 0;
        hint.innerHTML = method === 'CASH'
          ? `<div style="color:var(--mintDeep);font-weight:700;font-size:14px">剩餘現金 ${money(remaining, cur)} → 扣完剩 ${money(remaining - a, cur)}</div>`
          : `<div class="muted">信用卡只記進支出，不扣現金</div>`;
        d.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === method));
      };
      d.querySelectorAll('[data-m]').forEach(b => (b.onclick = () => { method = b.dataset.m; upd(); }));
      amt.oninput = upd; upd(); setTimeout(() => amt.focus(), 50);
      d.querySelector('#cancel').onclick = closeDialog;
      ok.onclick = () => { const a = val(); if (a <= 0) return; closeDialog(); run(() => (onConfirm ? onConfirm(a, method) : ctx.onBuy(item, a, method))); };
    });
  }

  function confirmHelperUntick(item, me) {
    openDialog(`<div class="sheet"><h2>取消幫買？</h2>
      <div class="muted">會刪掉這筆幫${esc(item.memberName)}代墊的支出。</div>
      <div class="btns"><button class="btn ghost" id="keep">保留</button><button class="btn peach" id="un">取消幫買</button></div></div>`, d => {
      d.querySelector('#keep').onclick = closeDialog;
      d.querySelector('#un').onclick = () => { closeDialog(); run(() => Cloud.helperUnbuy(ctx.tripId, item, me.memberId, me.name)); };
    });
  }

  function repayDialog(item, me, cur) {
    const pb = paidBy(item);
    const a = pb && pb.memberId === me.memberId ? '你' : (pb?.name || '代墊的人');
    const b = item.memberId === me.memberId ? '你' : item.memberName;
    const amt = money(pb?.amount || item.amount, cur);
    let method = 'CASH';
    openDialog(`<div class="sheet">
      <h2>已當場還錢？</h2>
      <div>「${esc(item.name)}」${amt}，${esc(b)}已經還給${esc(a)}了？選還錢方式：</div>
      <div class="pills" style="margin-top:10px"><button class="pill on" data-m="CASH">現金</button><button class="pill" data-m="TRANSFER">其他如轉帳</button></div>
      <div id="hint"></div>
      <div class="btns"><button class="btn ghost" id="cancel">取消</button><button class="btn" id="ok">已當場還錢</button></div>
    </div>`, d => {
      const hint = d.querySelector('#hint');
      const upd = () => {
        hint.innerHTML = method === 'CASH'
          ? `<div style="color:var(--mintDeep);font-weight:700;font-size:13px">${esc(a)}的剩餘現金會加回，${esc(b)} 的剩餘現金會扣掉，分帳不再算欠款</div>`
          : `<div class="muted">分帳不再算欠款。用轉帳還的話，兩人剩餘現金不變（當初付現的話，代墊的現金維持已扣）</div>`;
        d.querySelectorAll('[data-m]').forEach(b => b.classList.toggle('on', b.dataset.m === method));
      };
      d.querySelectorAll('[data-m]').forEach(el => (el.onclick = () => { method = el.dataset.m; upd(); }));
      upd();
      d.querySelector('#cancel').onclick = closeDialog;
      d.querySelector('#ok').onclick = () => { closeDialog(); run(() => Cloud.helperRepay(ctx.tripId, item, me.name, method)); };
    });
  }

  function confirmUnrepay(item, me) {
    const pb = paidBy(item);
    const a = pb && pb.memberId === me.memberId ? '你' : (pb?.name || '代墊的人');
    const b = item.memberId === me.memberId ? '你' : item.memberName;
    openDialog(`<div class="sheet"><h2>取消已還？</h2>
      <div class="muted">會恢復成分帳裡${esc(b)}欠${esc(a)}，現金也改回去。</div>
      <div class="btns"><button class="btn ghost" id="keep">保留</button><button class="btn peach" id="un">取消已還</button></div></div>`, d => {
      d.querySelector('#keep').onclick = closeDialog;
      d.querySelector('#un').onclick = () => { closeDialog(); run(() => Cloud.helperUnrepay(ctx.tripId, item, me.name)); };
    });
  }

  function confirmUntick(item) {
    openDialog(`<div class="sheet"><h2>取消「${esc(item.name)}」的打勾？</h2>
      <div class="muted">會一併刪除這筆支出，付現的金額會加回剩餘現金。</div>
      <div class="btns"><button class="btn ghost" id="keep">保留</button><button class="btn peach" id="un">取消打勾</button></div></div>`, d => {
      d.querySelector('#keep').onclick = closeDialog;
      d.querySelector('#un').onclick = () => { closeDialog(); run(() => ctx.onUnbuy(item)); };
    });
  }

  function editDialog(item) {
    let newPhoto = null, removed = false;
    openDialog(`<div class="sheet"><h2>編輯要買的東西${item.memberId !== ctx.me().memberId ? `（${esc(item.memberName)}的）` : ''}</h2>
      <div class="row"><button class="cam" id="ph" style="width:72px;height:72px"></button><div class="muted small grow" id="phHint"></div></div>
      <div class="field"><span class="lbl">東西</span><input id="n" type="text" value="${esc(item.name)}"></div>
      <div class="field"><span class="lbl">數量</span><input id="q" type="number" inputmode="numeric" pattern="[0-9]*" min="1" value="${item.qty}"></div>
      <div class="field"><span class="lbl">備註（選填）</span><input id="note" type="text" placeholder="例如：要藍色的" value="${esc(item.note)}"></div>
      <button class="link red" id="del" style="text-align:left">刪除這項</button>
      <div class="btns"><button class="btn ghost" id="cancel">取消</button><button class="btn" id="save">儲存</button></div></div>`, d => {
      const ph = d.querySelector('#ph'), hint = d.querySelector('#phHint'), n = d.querySelector('#n'), save = d.querySelector('#save');
      const hasPhoto = () => newPhoto != null || (item.photo != null && !removed);
      const upd = () => {
        const show = newPhoto || (!removed ? item.photo : null);
        ph.style.backgroundImage = show ? `url(${imgSrc(show)})` : ''; ph.textContent = show ? '' : '📷';
        hint.textContent = show ? '點照片可移除，再按相機換新的' : '點相機加照片';
        save.disabled = !(n.value.trim() || hasPhoto());
      };
      ph.onclick = async () => {
        if (newPhoto) { newPhoto = null; upd(); return; }
        if (item.photo && !removed) { removed = true; upd(); return; }
        const f = await pickFile(); if (!f) return;
        try { newPhoto = await photoToBase64(f); upd(); } catch { toast('這張照片讀不到，換一張試試'); }
      };
      n.oninput = upd; upd();
      d.querySelector('#cancel').onclick = closeDialog;
      d.querySelector('#del').onclick = () => {
        if (item.done) { toast('請先取消打勾，再刪除這項'); return; }
        if (!confirm(`刪除「${item.name}」？`)) return;
        closeDialog(); run(() => Cloud.deleteItem(ctx.tripId, item.id));
      };
      save.onclick = () => {
        const fields = {
          name: itemName(n.value, item.photo != null || newPhoto != null),
          qty: Math.max(1, parseInt(d.querySelector('#q').value, 10) || 1),
          note: d.querySelector('#note').value.trim(),
        };
        if (newPhoto != null) fields.photo = newPhoto; else if (removed) fields.photo = '';
        closeDialog(); run(() => Cloud.updateItem(ctx.tripId, item.id, fields));
      };
    });
  }

  return { render };
}

function deniedView(msg, tripId) {
  $app.innerHTML = `<div class="top"><button class="back" onclick="location.hash='#/'">‹</button><div class="t"><h1>旅伴帳</h1></div></div>
    <div class="body"><div class="card">${esc(msg)}</div>
    ${tripId ? `<a class="btn" href="#/join">重新輸入邀請碼加入</a><button class="link red" id="rm">從清單移除這趟</button>` : `<a class="btn" href="#/">回首頁</a>`}</div>`;
  const rm = $app.querySelector('#rm'); if (rm) rm.onclick = () => confirmRemoveJoined(tripId, '');
}

// ---------- Companion trip (SharedTripScreen) ----------
async function viewCompanion(cloudId, tab) {
  const j = joined().find(x => x.cloudId === cloudId);
  if (!j) return go('#/');
  $app.innerHTML = `<div class="loading">讀取中…</div>`;
  const g = gen;
  await ensureSignedIn();
  if (g !== gen) return;
  $app.innerHTML = `
    <div class="top"><button class="back" data-back>‹</button>
      <div class="t"><h1 id="tn">${esc(j.tripName)}</h1><div class="sub" id="ts">${esc(j.memberName)}的手機</div></div>
      <span class="chip">👁 只能看支出</span></div>
    <div class="tabs"><a href="#/t/${encodeURIComponent(cloudId)}" class="${tab === 0 ? 'on' : ''}">我要買</a><a href="#/t/${encodeURIComponent(cloudId)}/me" class="${tab === 1 ? 'on' : ''}">我的花費</a><a href="#/t/${encodeURIComponent(cloudId)}/split" class="${tab === 2 ? 'on' : ''}">分帳</a></div>
    <div id="pane" style="flex:1;display:flex;flex-direction:column"></div>`;
  $app.querySelector('[data-back]').onclick = () => go('#/');
  const pane = $app.querySelector('#pane');
  let shop = null;
  const S = liveTrip(cloudId, tab === 0 ? ['items', 'expenses', 'inbox'] : ['expenses', 'inbox'], what => {
    if (S.trip === null) return deniedView('這趟旅程已經不在了（主帳號可能停止共享）。', cloudId);
    if (S.trip) {
      const ownerName = S.trip.ownerName || '主帳號';
      $app.querySelector('#tn').textContent = S.trip.name || j.tripName;
      $app.querySelector('#ts').textContent = `${j.memberName}的手機 · ${ownerName}邀請`;
      if (S.trip.name && S.trip.name !== j.tripName) addJoined({ ...j, tripName: S.trip.name });
    }
    if (tab === 0) shop && shop.render(); else if (tab === 1) renderMine(); else renderSplitTab();
  }, () => deniedView('讀不到這趟旅程：你可能是在另一個瀏覽器或主畫面 App 加入的。請在這裡重新輸入邀請碼加入。', cloudId));
  const ctx = {
    tripId: cloudId, S, canEditAll: false,
    me: () => ({ memberId: j.memberId, name: j.memberName }),
    onBuy: (item, amount, method) => Cloud.buy(cloudId, item, j.memberName, expenseTitle(item.name, item.qty), amount, method),
    onUnbuy: item => Cloud.unbuy(cloudId, item, j.memberName),
  };
  if (tab === 0) { shop = mountShopping(pane, ctx); shop.render(); }
  else pane.innerHTML = `<div class="body" id="${tab === 1 ? 'mine' : 'split'}"><div class="muted">讀取中…</div></div>`;

  function renderSplitTab() {
    const box = pane.querySelector('#split'); if (!box || !S.trip) return;
    box.innerHTML = splitHtml(S, j.memberId) +
      `<div class="muted" style="margin-top:6px">🔒 支出和分帳由${esc(S.trip.ownerName || '主帳號')}（主帳號）管理，有問題請跟他說。</div>`;
  }

  function renderMine() {
    const box = pane.querySelector('#mine'); if (!box || !S.trip) return;
    const members = S.trip.members, cur = S.trip.currency, ownerName = S.trip.ownerName || '主帳號';
    const nameOf = id => members.find(m => m.id === id)?.name || '?';
    const repaid = repaidOf(S.items);
    const sum = summary(j.memberId, members, S.expenses, pendingOf(S.inbox), repaid);
    const pay = sum.transfers.filter(t => t.fromId === j.memberId), get = sum.transfers.filter(t => t.toId === j.memberId);
    box.innerHTML = `
      <div class="hero">
        <div class="s">我的剩餘現金（帶了 ${money(sum.startCash, cur)}）</div>
        <div class="big">${money(sum.remainingCash, cur)}</div>
        <div>我總共花了 ${money(sum.spent, cur)}</div>
        ${!pay.length && !get.length ? `<div class="s" style="font-weight:400">目前不用轉帳</div>` : ''}
        ${pay.map(t => `<div class="s">要付 ${esc(nameOf(t.toId))} ${money(t.amount, cur)}</div>`).join('')}
        ${get.map(t => `<div class="s">${esc(nameOf(t.fromId))} 要給你 ${money(t.amount, cur)}</div>`).join('')}
      </div>
      ${sum.pending.length ? `<div class="warn">等${esc(ownerName)}的手機記帳（打開旅伴帳就會自動記）</div>` : ''}
      ${sum.pending.map(p => `<div class="exp pend"><div class="grow"><div style="font-weight:700">${esc(p.repaidLabel || p.title)}</div><div class="muted small">${pendText(p, j.memberId, nameOf)}</div></div><div class="amt">${money(p.amount, cur)}</div></div>`).join('')}
      <div class="sec">跟我有關的支出</div>
      ${sum.related.length ? '' : `<div class="muted">還沒有跟你有關的支出。</div>`}
      ${sum.related.map(e => {
        const mine = e.shares[j.memberId] || 0;
        const who = e.payerId === j.memberId ? '我付' : `${esc(nameOf(e.payerId))} 付`;
        return `<div class="exp"><div class="grow"><div style="font-weight:700">${esc(expTitleOf(e, repaid))}</div>
          <div class="muted small">${fmtMD(e.at)} · ${who} · ${methodLabel(e.method)} · ${Object.keys(e.shares).length === 1 && mine > 0 ? '只算我' : `我分 ${money(mine, cur)}`}</div></div>
          <div class="amt">${money(e.amount, cur)}</div></div>`;
      }).join('')}
      <div class="muted" style="margin-top:6px">🔒 支出和分帳由${esc(ownerName)}（主帳號）管理，有問題請跟他說。</div>`;
  }
}

/** SharedTripScreen pending row text. */
function pendText(p, meId, nameOf) {
  if (p.repaidLabel) return p.method === 'CASH' ? '現金 · 已還' : '轉帳 · 已還';
  const m = p.method === 'CASH' ? '現金' : '信用卡', forId = p.forId || p.memberId;
  if (p.memberId === meId && forId === meId) return `我付 · ${m} · 只算我`;
  if (p.memberId === meId) return `我幫${esc(nameOf(forId))}付 · ${m} · 算他的`;
  return `${esc(nameOf(p.memberId))} 幫我付 · 算我的，要還他`;
}
const pendTitle = (p, nameOf) => p.repaidLabel ? esc(p.repaidLabel) : ((p.forId || p.memberId) !== p.memberId
  ? `${esc(nameOf(p.memberId))} 幫 ${esc(nameOf(p.forId))} · ${esc(p.title)}` : `${esc(nameOf(p.memberId))} · ${esc(p.title)}`);
const booksOf = S => resolve(S.expenses, pendingOf(S.inbox), repaidOf(S.items || []));
const expTitleOf = (e, repaid) => { const r = (repaid || []).find(x => x.expenseId === e.id); return r ? repaidLine(r.payerName, r.forName, e.title) : e.title; };

// ---------- read-only 分帳 (SettleScreen wording) ----------
function splitHtml(S, meId) {
  const t = S.trip, cur = t.currency, ms = t.members, ownerName = t.ownerName || '主帳號';
  const nameOf = mid => ms.find(m => m.id === mid)?.name || '?';
  const you = mid => (mid === meId ? `${esc(nameOf(mid))}（我）` : esc(nameOf(mid)));
  const repaid = repaidOf(S.items || []);
  const books = booksOf(S);
  const tr = transfers(ms, books.expenses);
  const total = books.expenses.reduce((s, e) => s + e.amount, 0);
  const pend = books.pending.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const exps = books.expenses.slice().sort((a, b) => b.at - a.at);
  const bal = balances(ms, books.expenses);
  return `
    <div class="hero"><div class="s">算清楚了！</div>
      <div class="big" style="font-size:24px">${tr.length ? `只要轉 ${tr.length} 筆就結清` : '沒有未結清的帳'}</div>
      <div class="s" style="font-weight:400">總支出 ${money(total, cur)} · ${ms.length} 人</div></div>
    <div class="sec">建議轉帳</div>
    ${tr.length ? tr.map(x => `<div class="card row" style="text-align:center">
        <div style="flex:1;font-weight:700">${you(x.fromId)}</div>
        <div style="flex:1"><div style="color:var(--mintDeep);font-weight:900;font-size:20px">${money(x.amount, cur)}</div><div class="muted small">轉給 ›</div></div>
        <div style="flex:1;font-weight:700">${you(x.toId)}</div></div>`).join('')
      : `<div class="card" style="color:var(--mintDeep);font-weight:700">目前沒有需要轉的帳，真棒！</div>`}
    <div class="sec">總消費明細</div>
    ${bal.map(b => `<div class="card row" style="padding:14px 16px"><div class="grow"><div style="font-weight:900">${you(b.id)}${b.owner ? ' 👑' : ''}</div>
        <div class="muted small">付了 ${money(b.paid, cur)} · 分攤 ${money(b.share, cur)}</div></div>
        <div style="text-align:right"><div class="amt" style="color:${b.net > 0 ? 'var(--mintDeep)' : b.net < 0 ? 'var(--peachDeep)' : 'var(--inkSoft)'}">${b.net > 0 ? '要收 ' + money(b.net, cur) : b.net < 0 ? '要付 ' + money(-b.net, cur) : '剛好'}</div></div></div>`).join('')}
    ${pend.length ? `<div class="warn">等${esc(ownerName)}的手機記帳（打開旅伴帳就會自動記）</div>` : ''}
    ${pend.map(p => `<div class="exp pend"><div class="grow"><div style="font-weight:700">${pendTitle(p, nameOf)}</div><div class="muted small">${p.repaidLabel ? methodLabel(p.method) : `${fmtMD(p.at)} · ${p.method === 'CASH' ? '現金' : '信用卡'} · 算${esc(nameOf(p.forId || p.memberId))}的`}</div></div><div class="amt">${money(p.amount, cur)}</div></div>`).join('')}
    <div class="sec">所有支出（${exps.length} 筆）</div>
    ${exps.length ? '' : `<div class="muted">還沒有支出。</div>`}
    ${exps.map(e => {
      const sh = Object.entries(e.shares).filter(([, c]) => c > 0);
      const parts = sh.map(([k, c]) => `${you(k)} ${money(c, cur)}`).join('、');
      const equal = sh.length > 0 && sh.every(([, c]) => Math.abs(c - sh[0][1]) <= 1);
      return `<div class="exp"><div class="grow"><div style="font-weight:700">${esc(expTitleOf(e, repaid))}</div>
        <div class="muted small">${fmtMD(e.at)} · ${you(e.payerId)} 付 · ${methodLabel(e.method)}</div>
        ${parts ? `<div class="muted small">分：${parts}</div>` : ''}</div>
        <div style="text-align:right"><div class="amt">${money(e.amount, cur)}</div>${equal && sh.length > 1 ? `<div class="muted small">一人 ${money(Math.floor(e.amount / sh.length), cur)}</div>` : ''}</div></div>`;
    }).join('')}`;
}

// ---------- Owner ----------
async function requireOwner() {
  await authReady;
  if (isGoogle()) return true;
  $app.innerHTML = `<div class="top"><button class="back" onclick="location.hash='#/'">‹</button><div class="t"><h1>主帳號</h1></div></div>
    <div class="body"><div class="muted">主帳號要先用 Google 登入（跟 Android 手機上同一個帳號）。旅伴不用登入。</div><button class="btn" id="gl">用 Google 登入</button></div>`;
  $app.querySelector('#gl').onclick = async e => {
    e.target.disabled = true; e.target.textContent = '登入中…';
    try { const u = await signInGoogle(); if (u) route(); }
    catch (err) { console.warn(err); toast('Google 登入沒有完成，請再試一次'); e.target.disabled = false; e.target.textContent = '用 Google 登入'; }
  };
  return false;
}

async function viewOwnerHome() {
  const g = gen;
  if (!(await requireOwner()) || g !== gen) return;
  $app.innerHTML = `<div class="top"><button class="back" data-back>‹</button><div class="t"><h1>我的共享旅程</h1><div class="sub">${esc(googleEmail())}</div></div></div>
    <div class="body" id="ol"><div class="muted">讀取中…</div></div>`;
  $app.querySelector('[data-back]').onclick = () => go('#/');
  const ol = $app.querySelector('#ol');
  cleanups.push(onSnapshot(query(collection(db, 'trips'), where('ownerUid', '==', auth.currentUser.uid)), s => {
    const ts = s.docs.map(d => parseTrip(d.id, d.data())).sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
    ol.innerHTML = (ts.length ? ts.map(t => `
      <div class="card tap row" data-go="#/o/${encodeURIComponent(t.id)}">
        <div class="grow"><div class="iname">${esc(t.name || '未命名旅程')}</div>
        <div class="muted small">${esc([t.startDate, t.endDate].filter(Boolean).join(' – '))} · ${t.members.length} 人 · 邀請碼 ${esc(displayCode(t.inviteCode))}</div></div>
        <span class="chip">›</span></div>`).join('') : `<div class="muted">還沒有共享的旅程。</div>`) +
      `<div class="note">要開新的共享旅程，請在 Android 主帳號手機的行程裡按「共享」。網頁版用來看邀請碼、大家的我要買和分帳。</div>`;
    ol.querySelectorAll('[data-go]').forEach(el => (el.onclick = () => go(el.dataset.go)));
  }, e => { console.warn(e); ol.innerHTML = `<div class="warn">${NET_ERR}</div>`; }));
}

async function viewOwnerTrip(id, tab) {
  const g = gen;
  if (!(await requireOwner()) || g !== gen) return;
  const base = `#/o/${encodeURIComponent(id)}`;
  $app.innerHTML = `
    <div class="top"><button class="back" data-back>‹</button>
      <div class="t"><h1 id="tn">讀取中…</h1><div class="sub">主帳號 👑 網頁版</div></div></div>
    <div class="tabs"><a href="${base}/invite" class="${tab === 'invite' ? 'on' : ''}">邀請</a><a href="${base}/shop" class="${tab === 'shop' ? 'on' : ''}">我要買</a><a href="${base}/money" class="${tab === 'money' ? 'on' : ''}">分帳</a></div>
    <div id="pane" style="flex:1;display:flex;flex-direction:column"></div>`;
  $app.querySelector('[data-back]').onclick = () => go('#/owner');
  const pane = $app.querySelector('#pane');
  const want = tab === 'invite' ? ['joins'] : tab === 'shop' ? ['items', 'expenses', 'inbox'] : ['expenses', 'inbox'];
  let shop = null;
  const S = liveTrip(id, want, () => {
    if (S.trip === null) return deniedView('找不到這趟旅程。');
    if (S.trip && S.trip.ownerUid !== auth.currentUser.uid) return deniedView('這趟旅程不是這個 Google 帳號開的。');
    if (S.trip) $app.querySelector('#tn').textContent = S.trip.name || '未命名旅程';
    if (tab === 'invite') renderInvite(); else if (tab === 'shop') shop && shop.render(); else renderMoney();
  }, () => deniedView('沒有權限讀這趟旅程，請確認登入的是開旅程的 Google 帳號。'));
  const ownerMember = () => S.trip?.members.find(m => m.owner) || null;

  if (tab === 'shop') {
    shop = mountShopping(pane, {
      tripId: id, S, canEditAll: true,
      me: () => { const m = ownerMember(); return m ? { memberId: m.id, name: S.trip.ownerName || m.name } : null; },
      // Expenses live on the Android 主帳號 phone (Room is the source of truth), so the web goes through the inbox too.
      onBuy: (item, amount, method) => Cloud.buy(id, item, S.trip.ownerName || ownerMember()?.name || '', expenseTitle(item.name, item.qty), amount, method),
      onUnbuy: item => Cloud.unbuy(id, item, S.trip.ownerName || ownerMember()?.name || ''),
    });
    const note = document.createElement('div');
    note.className = 'note'; note.style.margin = '0 16px';
    note.textContent = '你打勾的東西會先送到 Android 主帳號手機，手機打開旅伴帳就會記成支出。你也可以點旅伴的項目幫他修改。';
    pane.prepend(note);
    shop.render();
  } else pane.innerHTML = `<div class="body" id="pb"><div class="muted">讀取中…</div></div>`;

  function renderInvite() {
    const pb = pane.querySelector('#pb'); if (!pb || !S.trip) return;
    const t = S.trip, code = displayCode(t.inviteCode);
    const link = `${location.origin}${location.pathname}#/join/${t.inviteCode}`;
    const shareText = `一起用旅伴帳記「${t.name}」！打開旅伴帳 → 加入旅伴的旅程 → 輸入邀請碼 ${code}\niPhone 可以用網頁版：${link}`;
    pb.innerHTML = `
      <div class="card">
        <div class="lbl">邀請碼</div>
        <div class="code">${esc(code || '—')}</div>
        <div class="btns"><button class="btn ghost" id="copy">複製邀請碼</button><button class="btn" id="share">傳給旅伴</button></div>
      </div>
      <div class="muted">旅伴輸入邀請碼就能加入，不用登入。Android 旅伴用 App；iPhone 旅伴用 Safari 打開網頁版並「加入主畫面」。</div>
      <div class="sec">誰加入了</div>
      ${t.members.map(m => {
        const ok = S.joins.some(j => j.memberId === m.id);
        return `<div class="card row" style="padding:14px 16px"><div class="grow" style="font-weight:700">${esc(m.name)}${m.owner ? '（你・主帳號 👑）' : ''}</div>
          ${m.owner ? '' : `<span class="badge ${ok ? 'y' : 'n'}">${ok ? '已加入' : '還沒加入'}</span>`}</div>`;
      }).join('')}
      <div class="note">旅伴買到東西打勾後，你的 Android 手機打開旅伴帳就會自動記成一筆支出（付款人是他），你之後可以修改。</div>`;
    pb.querySelector('#copy').onclick = async () => {
      try { await navigator.clipboard.writeText(code); toast('已複製邀請碼'); } catch { prompt('複製這個邀請碼', code); }
    };
    pb.querySelector('#share').onclick = async () => {
      if (navigator.share) { try { await navigator.share({ title: '旅伴帳邀請', text: shareText }); } catch { } }
      else { try { await navigator.clipboard.writeText(shareText); toast('已複製邀請訊息，貼到 LINE 就行'); } catch { prompt('複製這段訊息', shareText); } }
    };
  }

  function renderMoney() {
    const pb = pane.querySelector('#pb'); if (!pb || !S.trip) return;
    const t = S.trip, cur = t.currency, ms = t.members;
    const nameOf = mid => ms.find(m => m.id === mid)?.name || '?';
    const repaid = repaidOf(S.items || []);
    const books = booksOf(S);
    const pend = books.pending;
    const tr = transfers(ms, books.expenses);
    const total = books.expenses.reduce((s, e) => s + e.amount, 0);
    const exps = books.expenses.slice().sort((a, b) => b.at - a.at);
    pb.innerHTML = `
      <div class="note peach">✏️ 新增或修改支出、分帳、現金，請在 Android 主帳號手機上操作。這裡只能看。</div>
      <div class="hero"><div class="s">這趟總支出</div><div class="big">${money(total, cur)}</div>
        ${tr.length ? tr.map(x => `<div class="s">${esc(nameOf(x.fromId))} 要付 ${esc(nameOf(x.toId))} ${money(x.amount, cur)}</div>`).join('') : `<div class="s" style="font-weight:400">目前不用轉帳</div>`}
      </div>
      <div class="sec">每個人</div>
      ${ms.map(m => {
        const s = summary(m.id, ms, S.expenses, pendingOf(S.inbox), repaid);
        return `<div class="card row"><div class="grow"><div style="font-weight:900">${esc(m.name)}${m.owner ? ' 👑' : ''}</div>
          <div class="muted small">帶了 ${money(s.startCash, cur)} · 花了 ${money(s.spent, cur)}</div></div>
          <div style="text-align:right"><div class="lbl">剩餘現金</div><div class="amt">${money(s.remainingCash, cur)}</div></div></div>`;
      }).join('')}
      ${pend.length ? `<div class="warn">等 Android 主帳號手機記帳（打開旅伴帳 App 就會自動記）</div>` : ''}
      ${pend.map(p => `<div class="exp pend"><div class="grow"><div style="font-weight:700">${pendTitle(p, nameOf)}</div><div class="muted small">${esc(nameOf(p.memberId))} 付 · ${p.method === 'CASH' ? '現金' : '信用卡'}</div></div><div class="amt">${money(p.amount, cur)}</div></div>`).join('')}
      <div class="sec">所有支出（${exps.length} 筆）</div>
      ${exps.length ? '' : `<div class="muted">還沒有支出。</div>`}
      ${exps.map(e => {
        const parts = Object.entries(e.shares).filter(([, c]) => c > 0).map(([k, c]) => `${esc(nameOf(k))} ${money(c, cur)}`).join('、');
        return `<div class="exp"><div class="grow"><div style="font-weight:700">${esc(expTitleOf(e, repaid))}</div>
          <div class="muted small">${fmtMD(e.at)} · ${esc(nameOf(e.payerId))} 付 · ${methodLabel(e.method)}</div>
          ${parts ? `<div class="muted small">分：${parts}</div>` : ''}</div><div class="amt">${money(e.amount, cur)}</div></div>`;
      }).join('')}`;
  }
}

// ---------- boot ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(e => console.warn('sw', e));
route();
