import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, updatePassword, signOut,
  deleteUser, reauthenticateWithCredential, reauthenticateWithPopup, EmailAuthProvider
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, addDoc, collection, query, where, orderBy, limit,
  onSnapshot, writeBatch, serverTimestamp, arrayUnion, arrayRemove, deleteDoc, getDocs
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getMessaging, getToken, isSupported } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';

/* ================= setup ================= */
const CFG = self.BB_CONFIG || {};
const FB = CFG.firebase || {};
const configured = !!FB.apiKey && !/YOUR_/i.test(FB.apiKey);
const $app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = 864e5;
const rs = p => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const ms = t => (t && t.toMillis) ? t.toMillis() : (typeof t === 'number' ? t : Date.now());
const dt = t => new Date(ms(t)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const normPhone = v => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d; else if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  return /^\d{11,15}$/.test(d) ? d : '';
};
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

let app, auth, db;
if (configured) { app = initializeApp(FB); auth = getAuth(app); db = getFirestore(app); }

/* ================= state ================= */
const st = {
  user: null, authReady: false, profile: null, profLoaded: false, priv: null,
  friendships: [], rooms: [], roomsLoaded: false,
  bills: {}, shares: {}, exits: {}, inbox: [], users: {}
};
const ui = { tab: 'rooms', sub: 'pending', room: null, modal: null, mode: 'welcome', emode: 'login', toast: '', fmsg: '', busy: false, deleting: false, friend: null, };
let D = {};
let subs = [], roomSubs = {}, askedUsers = new Set(), toastT, deferredInstall = null;

/* ================= helpers ================= */
const me = () => st.user && st.user.uid;
const U = id => st.users[id];
const nm = id => (U(id) && U(id).name) || '…';
const friendIds = () => st.friendships.filter(f => f.status === 'accepted').map(f => f.members.find(m => m !== me()));
const sharesOf = rid => st.shares[rid] || [];
const billsOf = rid => (st.bills[rid] || []).slice().sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
const roomDone = r => { const s = sharesOf(r.id); return s.length > 0 && s.every(x => x.status === 'confirmed'); };
const outstanding = r => sharesOf(r.id).filter(x => x.status !== 'confirmed').reduce((a, x) => a + x.amt, 0);
const net = (r, uid) => { let n = 0; sharesOf(r.id).forEach(x => { if (x.status === 'confirmed') return; if (x.payer === uid) n += x.amt; if (x.debtor === uid) n -= x.amt; }); return n; };
const hasOpen = (r, uid) => sharesOf(r.id).some(x => x.status !== 'confirmed' && (x.debtor === uid || x.payer === uid));
const initial = n => esc(((n || '?').trim()[0] || '?')).toUpperCase();
const upiLink = (p, amt, note, scheme = 'upi://pay') => `${scheme}?pa=${encodeURIComponent(p.upi)}&pn=${encodeURIComponent(p.name)}&am=${(amt / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}`;
const PAY_APPS = [
  { n: 'Google Pay', i: '🟦', s: 'tez://upi/pay' }, { n: 'PhonePe', i: '🟪', s: 'phonepe://pay' },
  { n: 'Paytm', i: '🟦', s: 'paytmmp://pay' }, { n: 'CRED', i: '⬛', s: 'credpay://upi/pay' },
  { n: 'BHIM / Other', i: '🇮🇳', s: 'upi://pay' }
];
const THEMES = [['purple', 'Purple', '#5b4bdb', '#8b6cff'], ['ocean', 'Ocean', '#0a7bd8', '#19c2d6'], ['sunset', 'Sunset', '#e2552d', '#f59e0b'], ['forest', 'Forest', '#0f9a6a', '#5bc97a'], ['rose', 'Rose', '#d6336c', '#ff7aa8']];

function toast(t) { ui.toast = t; render(); clearTimeout(toastT); toastT = setTimeout(() => { ui.toast = ''; render(); }, 3000); }
const friendly = e => {
  const c = (e && e.code) || '';
  const map = {
    'auth/invalid-credential': 'Wrong email or password', 'auth/wrong-password': 'Wrong email or password', 'auth/user-not-found': 'No account with that mobile number',
    'auth/email-already-in-use': 'This mobile number already has an account – try logging in', 'auth/weak-password': 'Password must be at least 6 characters',
    'auth/invalid-email': 'Enter a valid mobile number','auth/requires-recent-login': 'Please log out, log in again and retry', 'auth/too-many-requests': 'Too many attempts. Please wait a bit and retry',
    'auth/unauthorized-domain': 'This website address is not authorised in Firebase (Authentication → Settings → Authorized domains)',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase yet', 'auth/network-request-failed': 'No internet connection',
    'auth/invalid-verification-code': 'Wrong OTP', 'auth/code-expired': 'OTP expired – request a new one',
    'permission-denied': 'Not allowed (check Firestore rules are published)', 'unavailable': 'No internet connection'
  };
  return map[c] || (e && e.message) || 'Something went wrong';
};
async function run(fn) {
  if (ui.busy) return;
  ui.busy = true; render();
  try { await fn(); }
  catch (e) {
    console.error(e);
    if (e && (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request')) { /* user closed */ }
    else toast(friendly(e));
  } finally { ui.busy = false; render(); }
}

/* ================= live data ================= */
function endSession() {
  subs.forEach(f => f()); subs = [];
  Object.values(roomSubs).forEach(a => a.forEach(f => f())); roomSubs = {};
  Object.assign(st, { user: null, profile: null, profLoaded: false, priv: null, friendships: [], rooms: [], roomsLoaded: false, bills: {}, shares: {}, exits: {}, inbox: [], users: {} });
  askedUsers = new Set();
}
const quiet = e => console.warn('listener', e && e.code);
function startSession(u) {
  endSession(); st.user = u; const uid = u.uid;
  subs.push(onSnapshot(doc(db, 'users', uid), s => {
    st.profile = s.exists() ? { id: uid, ...s.data() } : null; st.profLoaded = true;
    if (st.profile) { st.users[uid] = st.profile; processInvite(); refreshPush(); }
    render();
  }, e => { st.profLoaded = true; render(); toast(friendly(e)); }));
  subs.push(onSnapshot(doc(db, 'users', uid, 'private', 'me'), s => { st.priv = s.exists() ? s.data() : null; render(); }, quiet));
  subs.push(onSnapshot(query(collection(db, 'friendships'), where('members', 'array-contains', uid)), s => {
    st.friendships = s.docs.map(d => ({ id: d.id, ...d.data() }));
    needUsers(st.friendships.flatMap(f => f.members)); render();
  }, quiet));
  subs.push(onSnapshot(query(collection(db, 'rooms'), where('members', 'array-contains', uid)), s => {
    st.rooms = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
    st.roomsLoaded = true; syncRooms(); render();
  }, quiet));
  subs.push(onSnapshot(query(collection(db, 'users', uid, 'inbox'), orderBy('createdAt', 'desc'), limit(60)), s => {
    st.inbox = s.docs.map(d => ({ id: d.id, ...d.data() })); render();
  }, quiet));
}
function syncRooms() {
  const ids = new Set(st.rooms.map(r => r.id));
  for (const id of Object.keys(roomSubs)) {
    if (!ids.has(id)) { roomSubs[id].forEach(f => f()); delete roomSubs[id]; delete st.bills[id]; delete st.shares[id]; delete st.exits[id]; }
  }
  for (const r of st.rooms) {
    if (roomSubs[r.id]) continue;
    const id = r.id, col = n => collection(db, 'rooms', id, n);
    const list = s => s.docs.map(d => ({ id: d.id, ...d.data() }));
    roomSubs[id] = [
      onSnapshot(col('bills'), s => { st.bills[id] = list(s); render(); }, quiet),
      onSnapshot(col('shares'), s => { st.shares[id] = list(s); render(); }, quiet),
      onSnapshot(col('exits'), s => { st.exits[id] = list(s); render(); }, quiet)
    ];
  }
  needUsers(st.rooms.flatMap(r => r.members));
}
function needUsers(ids) {
  ids.filter(i => i && !st.users[i] && !askedUsers.has(i)).forEach(i => {
    askedUsers.add(i);
    getDoc(doc(db, 'users', i)).then(s => { st.users[i] = s.exists() ? { id: i, ...s.data() } : { id: i, name: 'Deleted user', username: '', upi: '' }; render(); }).catch(() => askedUsers.delete(i));
  });
}
async function notify(to, roomId, type, text) {
  try { await addDoc(collection(db, 'users', to, 'inbox'), { from: me(), roomId, type, text, read: false, createdAt: serverTimestamp() }); }
  catch (e) { console.warn('notify failed', e && e.code); }
}

/* ================= auth actions ================= */
async function googleLogin() {
  const p = new GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, p); }
  catch (e) { if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) await signInWithRedirect(auth, p); else throw e; }
}
const MOBILE_DOMAIN = '@mobile.billbhai.app';
const mobileEmail = d => d + MOBILE_DOMAIN;
async function mobileGo() {
  const d = normPhone(D.mobile), pw = D.password || '';
  if (!d) return toast('Enter a valid 10-digit mobile number');
  if (!pw) return toast('Enter your password');
  if (ui.emode === 'signup') {
    if (pw.length < 6) return toast('Password must be at least 6 characters');
    if (pw !== D.password2) return toast('Passwords do not match');
    await createUserWithEmailAndPassword(auth, mobileEmail(d), pw);
  } else await signInWithEmailAndPassword(auth, mobileEmail(d), pw);
}
async function createProfile() {
  const user = st.user, uid = user.uid;
  const name = (D.name || '').trim(), un = (D.username || '').trim().toLowerCase();
  const fromMobile = (user.email || '').endsWith(MOBILE_DOMAIN);
  const mobile = fromMobile ? user.email.slice(0, -MOBILE_DOMAIN.length) : normPhone(D.mobile);
  const upi = (D.upi || '').trim();
  if (!name) return toast('Enter your name');
  if (!/^[a-z0-9_]{3,20}$/.test(un)) return toast('Username: 3–20 characters, a-z, 0-9, _');
  if (!mobile) return toast('Enter a valid 10-digit mobile number');
  if (upi && !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi)) return toast('Enter a valid UPI ID (name@bank)');
  if ((await getDoc(doc(db, 'usernames', un))).exists()) return toast('That username is already taken');
  if ((await getDoc(doc(db, 'phones', mobile))).exists()) return toast('That mobile number is already registered');
  const b = writeBatch(db);
  b.set(doc(db, 'usernames', un), { uid });
  b.set(doc(db, 'phones', mobile), { uid });
  b.set(doc(db, 'users', uid), { name, username: un, usernameLower: un, photoURL: user.photoURL || '', upi, createdAt: serverTimestamp() });
  b.set(doc(db, 'users', uid, 'private', 'me'), { mobile, email: fromMobile ? '' : (user.email || '') });
  await b.commit();
  D = {}; toast('Welcome to BillBhai 🎉');
}
async function changePassword() {
  const pw = D.newpw || '';
  if (pw.length < 6) return toast('Password must be at least 6 characters');
  if (pw !== D.newpw2) return toast('Passwords do not match');
  await updatePassword(auth.currentUser, pw); ui.modal = null; D = {}; toast('Password changed ✅');
}

/* ================= friends ================= */
async function sendRequest(other) {
  if (other === me()) return toast("That's you 🙂");
  if (st.friendships.some(f => f.members.includes(other))) return toast('Already friends or a request is pending');
  const m = [me(), other].sort();
  await setDoc(doc(db, 'friendships', m.join('_')), { members: m, requester: me(), status: 'pending', createdAt: serverTimestamp() });
  needUsers([other]);
}
async function addFriend() {
  const raw = (D.fq || '').trim();
  if (!raw) return toast('Enter a username or mobile number');
  const ph = /^[+\d][\d\s+-]{8,}$/.test(raw) ? normPhone(raw) : '';
  const key = ph || raw.toLowerCase().replace(/^@/, '');
  const s = await getDoc(doc(db, ph ? 'phones' : 'usernames', key));
  if (!s.exists()) { ui.fmsg = 'No user found with that ' + (ph ? 'mobile number' : 'username') + ' yet. Invite them 👇'; return; }
  ui.fmsg = ''; await sendRequest(s.data().uid); D.fq = ''; toast('Friend request sent ✅');
}
let inviteBusy = false;
async function processInvite() {
  const un = lsGet('bb_invite', ''); if (!un || inviteBusy || !st.profile) return;
  inviteBusy = true; lsSet('bb_invite', '');
  try {
    const s = await getDoc(doc(db, 'usernames', un));
    if (s.exists() && s.data().uid !== me()) { await sendRequest(s.data().uid); toast('Friend request sent to @' + un); }
  } catch (e) { console.warn(e); } finally { inviteBusy = false; }
}

/* ================= rooms & bills ================= */
async function createRoom() {
  const name = (D.rname || '').trim(); if (!name) return toast('Enter a room name');
  const inv = friendIds().filter(id => D['f_' + id]);
  const ref = doc(collection(db, 'rooms'));
  await setDoc(ref, { name, creator: me(), members: [me(), ...inv], createdAt: serverTimestamp() });
  await Promise.all(inv.map(id => notify(id, ref.id, 'room_invite', `${st.profile.name} added you to the room "${name}". If this was a mistake, you can request to leave.`)));
  ui.modal = null; ui.tab = 'rooms'; ui.room = ref.id;
}
async function addMembers() {
  const r = st.rooms.find(x => x.id === ui.room);
  const add = friendIds().filter(id => !r.members.includes(id) && D['f_' + id]);
  if (!add.length) return toast('Select a friend');
  await updateDoc(doc(db, 'rooms', r.id), { members: arrayUnion(...add) });
  await Promise.all(add.map(id => notify(id, r.id, 'room_invite', `${st.profile.name} added you to the room "${r.name}". If this was a mistake, you can request to leave.`)));
  ui.modal = null; toast('Members added');
}
async function addBill() {
  const r = st.rooms.find(x => x.id === ui.room);
  const title = (D.title || '').trim(), total = Math.round(parseFloat(D.amount) * 100);
  if (!title || !(total > 0)) return toast('Enter a bill name and a valid amount');
  const sel = r.members.filter(id => D['s_' + id] !== false);
  if (!sel.length) return toast('Select at least 1 person to split with');
  const parts = {};
  if (D.mode === 'cu') {
    let sum = 0; sel.forEach(id => { parts[id] = Math.round((parseFloat(D['c_' + id]) || 0) * 100); sum += parts[id]; });
    if (sum !== total) return toast(`Amounts are ${rs(Math.abs(sum - total))} ${sum > total ? 'over' : 'short of'} the total ${rs(total)}`);
  } else {
    const n = sel.length, base = Math.floor(total / n); let rem = total - base * n;
    sel.forEach(id => { parts[id] = base + (rem-- > 0 ? 1 : 0); });
  }
  const debtors = sel.filter(id => id !== me() && parts[id] > 0);
  if (!debtors.length) return toast('Add at least one other person besides yourself');
  const bref = doc(collection(db, 'rooms', r.id, 'bills')), b = writeBatch(db);
  b.set(bref, { title, amount: total, payer: me(), createdAt: serverTimestamp() });
  debtors.forEach(id => b.set(doc(db, 'rooms', r.id, 'shares', bref.id + '_' + id), {
    billId: bref.id, title, debtor: id, payer: me(), amt: parts[id], status: 'pending', createdAt: serverTimestamp(), lastRemind: null
  }));
  await b.commit();
  await Promise.all(debtors.map(id => notify(id, r.id, 'bill', `${st.profile.name} added "${title}" (${rs(total)}) in ${r.name}. Your share: ${rs(parts[id])}.` + (st.profile.upi ? ` Pay to UPI: ${st.profile.upi}` : ''))));
  ui.modal = null; toast('Bill added – everyone has been notified ✅');
}
const shareRef = (rid, sid) => doc(db, 'rooms', rid, 'shares', sid);
const findShare = (rid, sid) => sharesOf(rid).find(x => x.id === sid);
async function claimPaid(rid, sid) {
  const s = findShare(rid, sid), r = st.rooms.find(x => x.id === rid); if (!s || s.status !== 'pending') return;
  await updateDoc(shareRef(rid, sid), { status: 'claimed', claimedAt: serverTimestamp() });
  await notify(s.payer, rid, 'claim', `${st.profile.name} says they paid ${rs(s.amt)} ("${s.title}" – ${r.name}). Please confirm.`);
  ui.modal = null; toast('Request sent – waiting for the payer to confirm');
}
async function decideShare(rid, sid, ok) {
  const s = findShare(rid, sid), r = st.rooms.find(x => x.id === rid); if (!s) return;
  await updateDoc(shareRef(rid, sid), { status: ok ? 'confirmed' : 'pending', decidedAt: serverTimestamp() });
  await notify(s.debtor, rid, ok ? 'accepted' : 'rejected', ok ? `${nm(s.payer)} confirmed your ${rs(s.amt)} payment ("${s.title}").` : `${nm(s.payer)} did not receive your ${rs(s.amt)} payment ("${s.title}"). Please check and try again.`);
  if (ok && sharesOf(rid).every(x => x.id === sid || x.status === 'confirmed')) {
    await Promise.all(r.members.filter(m => m !== me()).map(m => notify(m, rid, 'settled', `🎉 All payments in "${r.name}" are settled!`)));
  }
  toast(ok ? 'Payment confirmed ✅' : 'Marked as not received');
}
async function remindInApp(rid, sid) {
  const s = findShare(rid, sid), r = st.rooms.find(x => x.id === rid);
  await updateDoc(shareRef(rid, sid), { lastRemind: serverTimestamp() });
  await notify(s.debtor, rid, 'reminder', `⏰ ${st.profile.name} is reminding you: ${rs(s.amt)} is pending ("${s.title}" – ${r.name}).`);
  ui.modal = null; toast('Reminder sent 🔔');
}
async function remindFriendRoom(rid, fid) {
  const r = st.rooms.find(x => x.id === rid);
  const list = sharesOf(rid).filter(x => x.payer === me() && x.debtor === fid && x.status === 'pending');
  if (!r || !list.length) return;
  await Promise.all(list.map(x => updateDoc(shareRef(rid, x.id), { lastRemind: serverTimestamp() })));
  const tot = list.reduce((a, x) => a + x.amt, 0);
  await notify(fid, rid, 'reminder', `⏰ ${st.profile.name} is reminding you: you owe ${rs(tot)} in "${r.name}".`);
  toast('Reminder sent 🔔');
}
async function reqExit(rid) {
  const r = st.rooms.find(x => x.id === rid);
  if (r.creator === me()) return toast('The creator cannot leave the room');
  if (hasOpen(r, me())) return toast('Settle your dues first, then leave');
  const cur = (st.exits[rid] || []).find(e => e.id === me());
  if (cur && cur.status === 'pending') return toast('Request is already pending');
  const ref = doc(db, 'rooms', rid, 'exits', me());
  if (cur) await updateDoc(ref, { status: 'pending' }); else await setDoc(ref, { status: 'pending', createdAt: serverTimestamp() });
  await notify(r.creator, rid, 'exit', `🚪 ${st.profile.name} wants to leave "${r.name}". Approve?`);
  toast('Confirmation request sent to the creator');
}
async function decideExit(rid, uid, ok) {
  const r = st.rooms.find(x => x.id === rid);
  await updateDoc(doc(db, 'rooms', rid, 'exits', uid), { status: ok ? 'approved' : 'denied' });
  await notify(uid, rid, 'exit_result', ok ? `✅ Your exit from "${r.name}" was approved.` : `❌ The creator denied your exit from "${r.name}".`);
  if (ok) await updateDoc(doc(db, 'rooms', rid), { members: arrayRemove(uid) });
  toast(ok ? 'Exit approved' : 'Exit denied');
}
async function deleteRoom(rid) {
  const r = st.rooms.find(x => x.id === rid);
  if (!r || r.creator !== me()) return toast('Only the creator can delete the room');
  if (sharesOf(rid).some(x => x.status !== 'confirmed')) return toast('Some payments are still pending. Settle them first (the payer can Accept or tap “Got cash”), then delete.');
  await Promise.all(r.members.filter(m => m !== me()).map(m => notify(m, rid, 'room_deleted', `🗑 The room "${r.name}" was deleted by its creator.`)));
  const b = writeBatch(db);
  sharesOf(rid).forEach(x => b.delete(doc(db, 'rooms', rid, 'shares', x.id)));
  (st.bills[rid] || []).forEach(x => b.delete(doc(db, 'rooms', rid, 'bills', x.id)));
  (st.exits[rid] || []).forEach(x => b.delete(doc(db, 'rooms', rid, 'exits', x.id)));
  b.delete(doc(db, 'rooms', rid));
  await b.commit();
  ui.modal = null; ui.room = null; toast('Room deleted');
}
async function deleteAccount() {
  const uid = me(), user = auth.currentUser, p = st.profile;
  if ((D.delconfirm || '').trim() !== 'DELETE') return toast('Type DELETE to confirm');
  if (st.rooms.some(r => hasOpen(r, uid))) return toast('Some payments are still pending. Settle all payments first, then delete your account.');
  const mine = st.rooms.filter(r => r.creator === uid);
  if (mine.length) return toast(`You created ${mine.length} room(s). Delete them first (open the room → Delete room).`);
  const isMobile = (user.email || '').endsWith(MOBILE_DOMAIN);
  if (isMobile) {
    if (!D.delpw) return toast('Enter your password to confirm');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, D.delpw));
  } else await reauthenticateWithPopup(user, new GoogleAuthProvider());
  ui.deleting = true; render();
  try {
    const mobile = (st.priv || {}).mobile, others = st.rooms.filter(r => r.creator !== uid), fr = st.friendships.slice();
    const [inb, toks] = await Promise.all([getDocs(collection(db, 'users', uid, 'inbox')), getDocs(collection(db, 'users', uid, 'tokens'))]);
    subs.forEach(f => f()); subs = [];
    Object.values(roomSubs).forEach(a => a.forEach(f => f())); roomSubs = {};
    for (const r of others) await updateDoc(doc(db, 'rooms', r.id), { members: arrayRemove(uid) });
    const refs = [...fr.map(f => doc(db, 'friendships', f.id)), ...inb.docs.map(d => d.ref), ...toks.docs.map(d => d.ref)];
    for (let i = 0; i < refs.length; i += 400) { const b = writeBatch(db); refs.slice(i, i + 400).forEach(r => b.delete(r)); await b.commit(); }
    const b = writeBatch(db);
    b.delete(doc(db, 'users', uid, 'private', 'me'));
    b.delete(doc(db, 'usernames', p.usernameLower));
    if (mobile) b.delete(doc(db, 'phones', mobile));
    b.delete(doc(db, 'users', uid));
    await b.commit();
    await deleteUser(user);
    ui.modal = null; ui.tab = 'rooms'; ui.room = null; ui.friend = null; ui.mode = 'welcome'; D = {};
    toast('Account deleted. You can sign up again anytime.');
  } catch (e) { if (auth.currentUser) startSession(auth.currentUser); throw e; }
  finally { ui.deleting = false; }
}
async function saveProfile() {
  const upi = (D.myupi ?? st.profile.upi ?? '').trim(), name = (D.myname ?? st.profile.name).trim();
  if (!name) return toast('Enter your name');
  if (upi && !/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(upi)) return toast('Enter a valid UPI ID (name@bank)');
  await updateDoc(doc(db, 'users', me()), { name, upi, username: st.profile.username, usernameLower: st.profile.usernameLower });
  toast('Profile saved ✅');
}
async function getPushToken() {
  const reg = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
  const token = await getToken(getMessaging(app), { vapidKey: CFG.vapidKey, serviceWorkerRegistration: reg });
  if (token) await setDoc(doc(db, 'users', me(), 'tokens', token), { createdAt: serverTimestamp(), ua: navigator.userAgent.slice(0, 120) });
  return token;
}
async function enablePush() {
  if (!(await isSupported())) return toast('Notifications are not supported here. On iPhone, first add the app to your Home Screen.');
  if (!CFG.vapidKey) return toast('Push key (vapidKey) is not set in firebase-config.js');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notification permission was not granted');
  if (!(await getPushToken())) return toast('Could not enable notifications');
  lsSet('bb_push', '1'); toast('Notifications enabled 🔔');
}
// silently keep this device registered if permission was already given
async function refreshPush() {
  try {
    if (!CFG.vapidKey || typeof Notification === 'undefined' || Notification.permission !== 'granted' || !(await isSupported())) return;
    await getPushToken(); lsSet('bb_push', '1');
  } catch (e) { /* ignore */ }
}
const pushNeeded = () => typeof Notification !== 'undefined' && Notification.permission !== 'denied' && lsGet('bb_push', '') !== '1' && !!CFG.vapidKey;
async function markInboxRead() {
  const un = st.inbox.filter(n => !n.read); if (!un.length) return;
  const b = writeBatch(db); un.slice(0, 400).forEach(n => b.update(doc(db, 'users', me(), 'inbox', n.id), { read: true })); await b.commit();
}
function copy(t) {
  try { navigator.clipboard.writeText(t).then(() => toast('Copied ✅'), () => toast('Could not copy – please copy manually')); } catch (e) { toast('Could not copy – please copy manually'); }
}

/* ================= views ================= */
const inp = (k, ph, type = 'text', extra = '') => `<input data-k="${k}" type="${type}" placeholder="${ph}" value="${esc(D[k] ?? '')}" ${extra}>`;
const statusChip = s => s === 'confirmed' ? '<span class="chip c-ok">✅ Received</span>' : s === 'claimed' ? '<span class="chip c-wa">Awaiting confirmation</span>' : '<span class="chip c-pe">Pending</span>';
const hero = () => `<div class="hero"><div class="tile">🧾</div><h1>Bill<b>Bhai</b></h1><p class="mut">Split expenses with friends, keep accounts clear, and pay straight through UPI.</p></div>`;

function setupView() {
  return `${hero()}<div class="card"><h3>One-time setup needed</h3><p class="mut">This app is not connected to Firebase yet. Open <b>docs/firebase-config.js</b> and paste your Firebase web-app config, then reload. The full step-by-step guide is in <b>SETUP.md</b>.</p></div>`;
}
function authView() {
  if (ui.mode === 'mobile') {
    const m = ui.emode;
    return `<div class="top"><button class="ghost sm" data-a="authmode" data-x="welcome">← Back</button><span class="logo">${m === 'signup' ? 'Create account' : 'Log in'}</span><span></span></div>
    <div class="card"><label>Mobile number</label>${inp('mobile', '10-digit mobile number', 'tel', 'autocomplete="tel" maxlength="14"')}
    <label>Password</label>${inp('password', '••••••', 'password', 'autocomplete="current-password"')}
    ${m === 'signup' ? `<label>Confirm password</label>${inp('password2', '••••••', 'password')}<div class="note" style="margin-bottom:8px">Remember this password – without OTP it cannot be reset. You can change it later in Profile.</div>` : ''}
    <button class="full" data-a="mobilego">${m === 'signup' ? 'Create account' : 'Log in'}</button>
    <div class="row sp" style="margin-top:10px">${m === 'login' ? '<button class="link" data-a="emode" data-x="signup">New here? Create account</button>' : '<button class="link" data-a="emode" data-x="login">Already have an account? Log in</button>'}<span></span></div></div>`;
  }
  return `${hero()}<div class="pad stack">
    <button class="full" data-a="authmode" data-x="mobile" data-e="signup">📱 Sign up with mobile number</button>
    <button class="full sec" data-a="authmode" data-x="mobile" data-e="login">Log in with mobile number</button>
    <button class="full gbtn" data-a="google">🇬 Continue with Google</button>
    <p class="note" style="text-align:center">Free forever. Your friends’ payment details stay private.</p></div>`;
}
function onboardingView() {
  const u = st.user, fromMobile = (u.email || '').endsWith(MOBILE_DOMAIN);
  if (D.name === undefined) D.name = fromMobile ? '' : (u.displayName || '');
  return `<div class="top"><span class="logo">Set up your profile</span><button class="ghost sm" data-a="logout">Log out</button></div>
  <div class="card"><div class="mut" style="margin-bottom:6px">Signed in as ${esc(fromMobile ? '+' + u.email.slice(0, -MOBILE_DOMAIN.length) : (u.email || u.displayName || u.uid))}</div>
  <label>Full name</label>${inp('name', 'e.g. Rahul Sharma')}
  <label>Username (friends can find you with this)</label>${inp('username', 'rahul_s', 'text', 'autocapitalize="none"')}
  ${fromMobile ? '' : `<label>Mobile number</label>${inp('mobile', '10-digit mobile number', 'tel')}`}
  <label>UPI ID (so friends can pay you)</label>${inp('upi', 'name@bank')}
  <button class="full" style="margin-top:10px" data-a="saveprofile">Create profile</button></div>`;
}
function roomCard(r) {
  const done = roomDone(r), n = net(r, me()), bc = (st.bills[r.id] || []).length;
  return `<div class="card${done ? ' done' : ''}" data-a="openroom" data-r="${r.id}" style="cursor:pointer">
  <div class="row sp"><h3>${esc(r.name)}</h3>${done ? '<span class="chip c-ok">✅ Completed</span>' : '<span class="chip c-wa">Pending</span>'}</div>
  <div class="mut">${r.members.map(nm).map(esc).join(', ')}</div>
  <div class="row sp" style="margin-top:6px"><span class="mut">${bc} bill${bc === 1 ? '' : 's'}${done || !bc ? '' : ' • pending ' + rs(outstanding(r))}</span>
  <b class="${n > 0 ? 'ok' : n < 0 ? 'bad' : 'mut'}">${n > 0 ? 'You get ' + rs(n) : n < 0 ? 'You owe ' + rs(-n) : done ? 'All settled' : bc ? '—' : 'No bills yet'}</b></div></div>`;
}
function roomsTab() {
  const pend = st.rooms.filter(r => !roomDone(r)), comp = st.rooms.filter(roomDone);
  const list = ui.sub === 'pending' ? pend : comp;
  const banner = pushNeeded() ? `<div class="card" style="border-color:var(--pri)"><b>🔔 Turn on notifications</b><div class="mut" style="margin:4px 0 8px">Get alerts for new bills, payments and daily reminders for pending payments.</div><button class="sm" data-a="push">Enable notifications</button></div>` : '';
  return `${banner}<div class="row sp" style="padding:0 16px"><h2 style="margin-left:0">Rooms</h2><button class="sm" data-a="modal" data-x="newroom">+ New Room</button></div>
  <div class="tabs"><button class="${ui.sub === 'pending' ? '' : 'sec'}" data-a="sub" data-x="pending">⏳ Pending (${pend.length})</button><button class="${ui.sub === 'completed' ? '' : 'sec'}" data-a="sub" data-x="completed">✅ Completed (${comp.length})</button></div>
  ${list.length ? list.map(roomCard).join('') : `<div class="empty">${!st.roomsLoaded ? 'Loading…' : ui.sub === 'pending' ? 'No pending rooms.<br>Create a room and add a bill!' : 'No room completed yet.'}</div>`}`;
}
function roomView(r) {
  const isC = r.creator === me(), done = roomDone(r), exits = st.exits[r.id] || [];
  const reqs = isC ? exits.filter(e => e.status === 'pending') : [], myReq = exits.find(e => e.id === me() && e.status === 'pending');
  const bills = billsOf(r.id);
  return `<div class="top"><button class="ghost sm" data-a="back">← Rooms</button>${done ? '<span class="chip c-ok">✅ Completed</span>' : '<span class="chip c-wa">Pending</span>'}</div>
  <h2>${esc(r.name)}</h2>
  <div class="card"><div class="mut" style="margin-bottom:8px">Members (${r.members.length})</div>
    <div class="row" style="flex-wrap:wrap">${r.members.map(m => `<span class="chip c-in">${esc(nm(m))}${m === r.creator ? ' 👑' : ''}</span>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="grow" data-a="modal" data-x="bill">+ Add Bill</button>${isC ? '<button class="sec" data-a="modal" data-x="member">+ Member</button>' : ''}</div></div>
  ${reqs.map(e => `<div class="card" style="border-color:var(--warn)"><b>${esc(nm(e.id))}</b> wants to leave the room.<div class="row" style="margin-top:8px"><button class="ok sm" data-a="exitok" data-r="${r.id}" data-u="${e.id}">Approve</button><button class="bd sm" data-a="exitno" data-r="${r.id}" data-u="${e.id}">Deny</button></div></div>`).join('')}
  ${bills.length ? bills.map(b => billCard(r, b)).join('') : '<div class="empty">No bills yet.<br>Start with “+ Add Bill”.</div>'}
  <div class="card"><div class="mut">Added by mistake? Leaving the room needs the creator’s confirmation.</div>
  ${isC ? `<div class="mut" style="margin-top:6px">You are the creator of this room 👑</div><button class="bd full" style="margin-top:8px" data-a="modal" data-x="delroom" data-r="${r.id}">🗑 Delete room</button>` : myReq ? '<div class="warn" style="margin-top:6px">⏳ Exit request is waiting for the creator’s approval</div>' : `<button class="ghost full" style="margin-top:8px" data-a="reqexit" data-r="${r.id}">🚪 Leave room (needs creator approval)</button>`}</div>`;
}
function billCard(r, b) {
  const isPayer = b.payer === me(), shares = sharesOf(r.id).filter(s => s.billId === b.id);
  return `<div class="card"><div class="row sp"><h3>${esc(b.title)}</h3><b>${rs(b.amount)}</b></div>
  <div class="mut">${esc(nm(b.payer))} paid • ${dt(b.createdAt)}</div>
  ${shares.map(s => `<div class="share"><div class="row sp"><span><b>${esc(nm(s.debtor))}</b> ${s.debtor === me() ? '(you)' : ''} – ${rs(s.amt)}</span>${statusChip(s.status)}</div>
    <div class="row" style="margin-top:6px;flex-wrap:wrap">
    ${s.debtor === me() && s.status === 'pending' ? `<button class="sm" data-a="pay" data-r="${r.id}" data-s="${s.id}">💸 Pay Online</button><button class="sm sec" data-a="claim" data-r="${r.id}" data-s="${s.id}">✔ I have paid</button>` : ''}
    ${s.debtor === me() && s.status === 'claimed' ? '<span class="mut">Waiting for the payer to confirm…</span>' : ''}
    ${isPayer && s.status === 'claimed' ? `<button class="ok sm" data-a="accept" data-r="${r.id}" data-s="${s.id}">Accept</button><button class="bd sm" data-a="reject" data-r="${r.id}" data-s="${s.id}">Reject</button>` : ''}
    ${isPayer && s.status === 'pending' ? `<button class="sm ghost" data-a="inapp" data-r="${r.id}" data-s="${s.id}">🔔 Remind</button><button class="sm ghost" data-a="accept" data-r="${r.id}" data-s="${s.id}">💵 Got cash</button>` : ''}
    </div></div>`).join('')}</div>`;
}
function friendBal(fid) {
  let n = 0;
  st.rooms.forEach(r => sharesOf(r.id).forEach(x => { if (x.status === 'confirmed') return; if (x.payer === me() && x.debtor === fid) n += x.amt; if (x.debtor === me() && x.payer === fid) n -= x.amt; }));
  return n;
}
function friendView(fid) {
  const f = st.friendships.find(q => q.status === 'accepted' && q.members.includes(fid));
  if (!f) { ui.friend = null; return friendsTab(); }
  const bal = friendBal(fid);
  const rooms = st.rooms.filter(r => r.members.includes(fid)).map(r => ({ r, list: sharesOf(r.id).filter(x => x.status !== 'confirmed' && ((x.payer === me() && x.debtor === fid) || (x.payer === fid && x.debtor === me()))) }));
  const open = rooms.filter(x => x.list.length);
  const head = bal > 0 ? `<div class="warn" style="margin-top:10px">💰 You will get <b>${rs(bal)}</b> from ${esc(nm(fid))}</div>` : bal < 0 ? `<div class="warn" style="margin-top:10px">You owe <b>${rs(-bal)}</b> to ${esc(nm(fid))}</div>` : `<div class="mut" style="margin-top:10px">✅ All settled with ${esc(nm(fid))}</div>`;
  return `<div class="row" style="margin-bottom:8px"><button class="ghost sm" data-a="back">‹ Back</button></div>
  <div class="card"><div class="row"><span class="av">${initial(nm(fid))}</span><div class="grow"><h3>${esc(nm(fid))}</h3><div class="mut">@${esc((U(fid) || {}).username || '')}</div></div></div>
  <div class="mut" style="margin-top:8px">🤝 Friends since ${f.createdAt ? new Date(ms(f.createdAt)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</div>${head}</div>
  ${open.map(({ r, list }) => {
    const get = list.filter(x => x.payer === me()), owe = list.filter(x => x.debtor === me());
    const g = get.reduce((a, x) => a + x.amt, 0), o = owe.reduce((a, x) => a + x.amt, 0);
    return `<div class="card"><div class="row sp"><h3>🏠 ${esc(r.name)}</h3><span class="mut" data-a="openroom" data-r="${r.id}" style="cursor:pointer">Open ›</span></div>
    ${get.length ? `<div class="row sp" style="margin-top:6px"><span>${esc(nm(fid))} owes you</span><b>${rs(g)}</b></div>${get.map(x => `<div class="mut">• ${esc(x.title)} – ${rs(x.amt)} ${x.status === 'claimed' ? '(says paid, confirm in room)' : ''}</div>`).join('')}
    ${get.some(x => x.status === 'pending') ? `<button class="full" style="margin-top:8px" data-a="remindfr" data-r="${r.id}" data-u="${fid}">🔔 Send reminder</button>` : ''}` : ''}
    ${owe.length ? `<div class="row sp" style="margin-top:6px"><span>You owe ${esc(nm(fid))}</span><b>${rs(o)}</b></div>${owe.map(x => `<div class="row sp" style="margin-top:4px"><span class="mut">• ${esc(x.title)} – ${rs(x.amt)}</span>${x.status === 'pending' ? `<button class="sm" data-a="pay" data-r="${r.id}" data-s="${x.id}">💸 Pay</button>` : '<span class="mut">waiting…</span>'}</div>`).join('')}` : ''}</div>`;
  }).join('') || '<div class="empty">No pending payments with this friend.</div>'}`;
}
function friendsTab() {
  if (ui.friend) return friendView(ui.friend);
  const inc = st.friendships.filter(f => f.status === 'pending' && f.requester !== me()), out = st.friendships.filter(f => f.status === 'pending' && f.requester === me());
  const fr = friendIds();
  const other = f => f.members.find(m => m !== me());
  return `<h2>Friends</h2>
  <div class="card"><label>Add a friend by username or mobile number</label>${inp('fq', '@username or mobile number', 'text', 'autocapitalize="none"')}
  <button class="full" data-a="addfriend">+ Send friend request</button>
  ${ui.fmsg ? `<div class="warn" style="margin-top:8px">${esc(ui.fmsg)}</div>` : ''}
  <button class="sec full" style="margin-top:8px" data-a="modal" data-x="share">📤 Invite to the app</button></div>
  ${inc.map(f => `<div class="card row"><span class="av">${initial(nm(other(f)))}</span><div class="grow"><b>${esc(nm(other(f)))}</b><div class="mut">wants to be your friend</div></div><button class="ok sm" data-a="acceptfr" data-f="${f.id}">Accept</button><button class="ghost sm" data-a="declinefr" data-f="${f.id}">✕</button></div>`).join('')}
  ${out.map(f => `<div class="card row"><span class="av">${initial(nm(other(f)))}</span><div class="grow"><b>${esc(nm(other(f)))}</b><div class="mut">request sent</div></div><button class="ghost sm" data-a="declinefr" data-f="${f.id}">Cancel</button></div>`).join('')}
  ${fr.length ? fr.map(id => { const b = friendBal(id); return `<div class="card row" data-a="openfriend" data-u="${id}" style="cursor:pointer"><span class="av">${initial(nm(id))}</span><div class="grow"><b>${esc(nm(id))}</b><div class="mut">@${esc((U(id) || {}).username || '')}</div></div>${b > 0 ? `<span class="chip c-in">gets ${rs(b)}</span>` : b < 0 ? `<span class="chip">owes ${rs(-b)}</span>` : ''}<span class="mut">›</span></div>`; }).join('') : '<div class="empty">No friends yet. Add one above.</div>'}`;
}
function actionItems() {
  const items = [];
  st.friendships.filter(f => f.status === 'pending' && f.requester !== me()).forEach(f => items.push(`<div class="card" style="border-color:var(--pri)"><div>👋 <b>${esc(nm(f.requester))}</b> sent you a friend request.</div><div class="row" style="margin-top:8px"><button class="ok sm" data-a="acceptfr" data-f="${f.id}">Accept</button><button class="ghost sm" data-a="declinefr" data-f="${f.id}">Decline</button></div></div>`));
  st.rooms.forEach(r => {
    sharesOf(r.id).filter(s => s.payer === me() && s.status === 'claimed').forEach(s => items.push(`<div class="card" style="border-color:var(--warn)"><div>💸 <b>${esc(nm(s.debtor))}</b> says they paid <b>${rs(s.amt)}</b> for "${esc(s.title)}" (${esc(r.name)}).</div><div class="row" style="margin-top:8px"><button class="ok sm" data-a="accept" data-r="${r.id}" data-s="${s.id}">Accept</button><button class="bd sm" data-a="reject" data-r="${r.id}" data-s="${s.id}">Reject</button></div></div>`));
    if (r.creator === me()) (st.exits[r.id] || []).filter(e => e.status === 'pending').forEach(e => items.push(`<div class="card" style="border-color:var(--warn)"><div>🚪 <b>${esc(nm(e.id))}</b> wants to leave "${esc(r.name)}".</div><div class="row" style="margin-top:8px"><button class="ok sm" data-a="exitok" data-r="${r.id}" data-u="${e.id}">Approve exit</button><button class="bd sm" data-a="exitno" data-r="${r.id}" data-u="${e.id}">Deny</button></div></div>`));
  });
  return items;
}
const badgeCount = () => actionItems().length + st.inbox.filter(n => !n.read).length;
function alertsTab() {
  const a = actionItems();
  return `<h2>Alerts</h2>${a.join('')}
  ${st.inbox.length ? st.inbox.map(n => `<div class="card"><div>${esc(n.text)}</div><div class="mut">${dt(n.createdAt)}</div></div>`).join('') : (a.length ? '' : '<div class="empty">No alerts 🎈</div>')}`;
}
function profileTab() {
  const p = st.profile, pv = st.priv || {};
  if (D.myname === undefined) D.myname = p.name;
  if (D.myupi === undefined) D.myupi = p.upi || '';
  const theme = lsGet('bb_theme', 'purple'), mode = lsGet('bb_mode', 'auto');
  const canPw = (st.user.email || '').endsWith(MOBILE_DOMAIN);
  return `<h2>Profile</h2><div class="card stack">
  <div class="row"><span class="av" style="width:48px;height:48px;font-size:20px">${initial(p.name)}</span><div><b>${esc(p.name)}</b><div class="mut">@${esc(p.username)}${pv.mobile ? ' • +' + esc(pv.mobile) : ''}</div></div></div>
  <div><label>Name</label>${inp('myname', 'Your name')}
  <label>My UPI ID (shown to friends when I am the bill payer)</label>${inp('myupi', 'name@bank')}
  <button class="sec full" data-a="saveprof">Save profile</button></div>
  <button class="sec full" data-a="push">🔔 Enable payment reminder notifications</button>
  ${deferredInstall ? '<button class="sec full" data-a="install">📲 Install app</button>' : '<div class="note">To install: Android Chrome → menu → “Install app”. iPhone Safari → Share → “Add to Home Screen”.</div>'}
  ${canPw ? '<button class="sec full" data-a="modal" data-x="password">🔑 Change password</button>' : ''}
  <div><label>🌗 Display mode</label><div class="tabs" style="margin:4px 0 0">${[['auto', '🌓 Auto'], ['light', '☀️ Light'], ['dark', '🌙 Dark']].map(m => `<button class="${mode === m[0] ? '' : 'sec'}" data-a="dmode" data-x="${m[0]}">${m[1]}</button>`).join('')}</div></div>
  <div><label>🎨 Colour theme</label><div class="themes">${THEMES.map(t => `<button class="${theme === t[0] ? 'on' : ''}" data-a="theme" data-x="${t[0]}" title="${t[1]}" style="background:linear-gradient(135deg,${t[2]},${t[3]})"></button>`).join('')}</div></div>
  <button class="sec full" data-a="modal" data-x="share">📤 Share app</button>
  <button class="ghost full" data-a="modal" data-x="logout">Log out</button>
  <button class="ghost full bad" data-a="modal" data-x="delacct">🗑 Delete my account</button></div>`;
}
function inviteText() {
  const link = `${location.origin}${location.pathname}?u=${st.profile.username}`;
  return { link, text: `Hey! Join me on BillBhai – the easiest way to split expenses with friends. Tap to add me: ${link}` };
}
function modalView() {
  const m = ui.modal; if (!m) return ''; let h = '';
  if (m.t === 'newroom') {
    const fr = friendIds();
    h = `<h3>New Room</h3><label>Room name</label>${inp('rname', 'e.g. Goa Trip, Flat Rent')}
    <label>Invite friends</label>${fr.length ? fr.map(id => `<label class="row" style="font-weight:400;color:var(--ink)"><input type="checkbox" data-c="f_${id}" ${D['f_' + id] ? 'checked' : ''} style="width:auto;margin:0"> ${esc(nm(id))} <span class="mut">@${esc((U(id) || {}).username || '')}</span></label>`).join('') : '<div class="mut">Add friends from the Friends tab first (you can also invite later).</div>'}
    <button class="full" style="margin-top:12px" data-a="createroom">Create room</button>`;
  } else if (m.t === 'member') {
    const r = st.rooms.find(x => x.id === ui.room), fr = friendIds().filter(id => !r.members.includes(id));
    h = `<h3>Add members</h3>${fr.length ? fr.map(id => `<label class="row" style="font-weight:400;color:var(--ink)"><input type="checkbox" data-c="f_${id}" ${D['f_' + id] ? 'checked' : ''} style="width:auto;margin:0"> ${esc(nm(id))}</label>`).join('') + '<button class="full" style="margin-top:12px" data-a="addmembers">Add</button>' : '<div class="mut">All your friends are already in this room. Add new friends from the Friends tab.</div>'}`;
  } else if (m.t === 'bill') {
    const r = st.rooms.find(x => x.id === ui.room), cu = D.mode === 'cu';
    h = `<h3>Add Bill</h3><div class="mut">Payer: <b>${esc(st.profile.name)}</b> (you)</div>
    <label>Bill name</label>${inp('title', 'e.g. Dinner, Petrol')}
    <label>Total amount (₹)</label>${inp('amount', '0', 'number', 'inputmode="decimal"')}
    <div class="tabs" style="margin:6px 0"><button class="${cu ? 'sec' : ''}" data-a="mode" data-x="eq">Equal</button><button class="${cu ? '' : 'sec'}" data-a="mode" data-x="cu">Custom amounts</button></div>
    <label>Split between</label>
    ${r.members.map(id => `<div class="row" style="margin-bottom:6px"><input type="checkbox" data-c="s_${id}" ${D['s_' + id] !== false ? 'checked' : ''} style="width:auto;margin:0"><span class="grow">${esc(nm(id))}${id === me() ? ' (you)' : ''}</span>${cu && D['s_' + id] !== false ? `<input data-k="c_${id}" type="number" inputmode="decimal" placeholder="₹" value="${esc(D['c_' + id] ?? '')}" style="width:100px;margin:0">` : ''}</div>`).join('')}
    ${st.profile.upi ? '' : '<div class="demo">You have not added a UPI ID – add it in Profile so friends see the Pay Online option.</div>'}
    <button class="full" style="margin-top:10px" data-a="addbill">Add bill & notify everyone</button>`;
  } else if (m.t === 'pay') {
    const s = findShare(m.r, m.s); if (!s) return ''; const p = U(s.payer) || {};
    h = `<h3>Pay Online</h3><p>Pay <b>${rs(s.amt)}</b> to ${esc(nm(s.payer))} – "${esc(s.title)}"</p>
    ${p.upi ? `<div class="qr" id="qr"></div><div class="card" style="margin:8px 0"><div class="mut">UPI ID</div><div class="row sp"><b>${esc(p.upi)}</b><button class="sm sec" data-a="copy" data-x="${esc(p.upi)}">Copy</button></div></div>
    <div style="margin:10px 0 6px"><b>Which app do you want to pay with?</b></div>
    <a class="btn full" style="margin-bottom:8px" href="${esc(upiLink(p, s.amt, s.title))}">📲 Show all UPI apps on my phone</a>
    <div class="row" style="flex-wrap:wrap;margin-bottom:6px">${PAY_APPS.map(a => `<a class="btn sec sm" href="${esc(upiLink(p, s.amt, s.title, a.s))}">${a.i} ${a.n}</a>`).join('')}</div>
    <div class="mut" style="margin:8px 0">“Show all UPI apps” lets your phone list every UPI app you have installed. Or scan the QR with any app. After paying, tap below.</div>
    <button class="ok full" data-a="claim" data-r="${m.r}" data-s="${m.s}">✔ I have paid</button>`
      : `<div class="demo">${esc(nm(s.payer))} has not added a UPI ID yet. Pay them directly, then tap “I have paid”.</div><button class="ok full" data-a="claim" data-r="${m.r}" data-s="${m.s}">✔ I have paid</button>`}`;
  } else if (m.t === 'delacct') {
    const mobileAcc = (st.user.email || '').endsWith(MOBILE_DOMAIN);
    h = `<h3>Delete your account?</h3><p class="mut">Your profile, friends and notifications will be removed and you will leave your rooms. Your username and mobile number become free, so you can sign up again with the same number. This cannot be undone.</p>
    <p class="mut">You can delete your account only when no payment is pending and you have no rooms you created (delete those first).</p>
    ${mobileAcc ? `<label>Password</label>${inp('delpw', '••••••', 'password')}` : '<div class="note">You will be asked to sign in with Google again to confirm.</div>'}
    <label>Type DELETE to confirm</label>${inp('delconfirm', 'DELETE', 'text', 'autocapitalize="characters"')}
    <button class="bd full" data-a="delacctgo">Delete my account</button>`;
  } else if (m.t === 'delroom') {
    const r = st.rooms.find(x => x.id === ui.room); if (!r) return '';
    h = `<h3>Delete “${esc(r.name)}”?</h3><p class="mut">This removes the room, all its bills and history for everyone. It cannot be undone. A room can only be deleted when no payment is pending.</p><button class="bd full" data-a="delroomgo" data-r="${r.id}">Yes, delete room</button>`;
  } else if (m.t === 'logout') {
    h = `<h3>Log out?</h3><p class="mut">You will need your password (or Google) to sign in again. Remember your password – it cannot be reset.</p><div class="row"><button class="ghost grow" data-a="close">Cancel</button><button class="bd grow" data-a="logout">Yes, log out</button></div>`;
  } else if (m.t === 'password') {
    h = `<h3>Change password</h3><label>New password</label>${inp('newpw', '••••••', 'password')}<label>Confirm new password</label>${inp('newpw2', '••••••', 'password')}<button class="full" data-a="changepw">Save password</button>`;
  } else if (m.t === 'share') {
    const { text } = inviteText();
    h = `<h3>Share app</h3><div class="card" style="margin:8px 0">${esc(text)}</div>
    <div class="stack"><a class="btn full" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">💬 Send on WhatsApp</a>
    <a class="btn sec full" href="sms:?&body=${encodeURIComponent(text)}">✉️ Send SMS</a>
    <button class="sec full" data-a="copy" data-x="${esc(text)}">📋 Copy message</button></div>
    <div class="mut">When your friend opens the link and signs up, a friend request is sent to you automatically.</div>`;
  }
  return `<div class="ov" data-a="closebg"><div class="sheet">${h}<button class="ghost full" style="margin-top:12px" data-a="close">Close</button></div></div>`;
}
function appView() {
  const un = badgeCount(); let body;
  if (ui.tab === 'rooms' && ui.room && st.rooms.find(r => r.id === ui.room)) body = roomView(st.rooms.find(r => r.id === ui.room));
  else body = { rooms: roomsTab, friends: friendsTab, alerts: alertsTab, me: profileTab }[ui.tab]();
  const tb = (t, i, l, b) => `<button class="${ui.tab === t ? 'on' : ''}" data-a="tab" data-x="${t}"><span>${i}</span>${l}${b ? `<i class="badge">${b}</i>` : ''}</button>`;
  return `<div class="top"><span class="logo">Bill<b>Bhai</b></span><span class="row"><span class="mut">${esc(st.profile.name)}</span><span class="av">${initial(st.profile.name)}</span></span></div>${body}
  <nav><div>${tb('rooms', '🏠', 'Rooms')}${tb('friends', '👥', 'Friends')}${tb('alerts', '🔔', 'Alerts', un || '')}${tb('me', '👤', 'Profile')}</div></nav>`;
}

/* Back button: Android/browser back goes one level up instead of leaving the app */
let histDepth = 0, skipPops = 0;
const navDepth = () => st.user ? ((ui.tab !== 'rooms' ? 1 : 0) + (ui.friend ? 1 : 0) + (ui.room ? 1 : 0) + (ui.modal ? 1 : 0)) : (ui.mode === 'mobile' ? 1 : 0);
function syncHistory() {
  const d = navDepth();
  while (histDepth < d) { try { history.pushState({ bb: histDepth + 1 }, ''); } catch (e) { break; } histDepth++; }
  if (histDepth > d) { const n = histDepth - d; skipPops++; histDepth = d; try { history.go(-n); } catch (e) { skipPops--; } }
}
window.addEventListener('popstate', () => {
  if (skipPops > 0) { skipPops--; return; }
  histDepth = Math.max(0, histDepth - 1);
  if (!st.user) { if (ui.mode === 'mobile') ui.mode = 'welcome'; }
  else if (ui.modal) ui.modal = null;
  else if (ui.friend) ui.friend = null;
  else if (ui.room) ui.room = null;
  else if (ui.tab !== 'rooms') ui.tab = 'rooms';
  render();
});

function render() {
  syncHistory();
  const de = document.documentElement, theme = lsGet('bb_theme', 'purple'), mode = lsGet('bb_mode', 'auto');
  de.dataset.theme = theme;
  de.dataset.mode = (mode === 'dark' || (mode === 'auto' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)) ? 'dark' : 'light';
  const act = document.activeElement, key = act && act.dataset ? act.dataset.k : null;
  let body;
  if (!configured) body = setupView();
  else if (ui.deleting) body = '<div class="empty" style="padding-top:30vh">Deleting your account…</div>';
  else if (!st.authReady || (st.user && !st.profLoaded)) body = '<div class="empty" style="padding-top:30vh">Loading…</div>';
  else if (!st.user) body = authView();
  else if (!st.profile) body = onboardingView();
  else body = appView();
  $app.innerHTML = `<div class="${ui.busy ? 'spin' : ''}">${body}</div>` + (st.profile && !ui.deleting ? modalView() : '') + (ui.toast ? `<div class="toast">${esc(ui.toast)}</div>` : '');
  if (ui.modal && ui.modal.t === 'pay') {
    try {
      const s = findShare(ui.modal.r, ui.modal.s), p = s && U(s.payer), el = document.getElementById('qr');
      if (el && p && p.upi && window.QRCode) new QRCode(el, { text: upiLink(p, s.amt, s.title), width: 180, height: 180 });
    } catch (e) { /* ignore */ }
  }
  if (key) { const el = $app.querySelector(`[data-k="${key}"]`); if (el && !el.disabled) { el.focus(); try { const l = el.value.length; el.setSelectionRange(l, l); } catch (e) { /* ignore */ } } }
}

/* ================= events ================= */
document.addEventListener('input', e => { const t = e.target; if (t.dataset && t.dataset.k) D[t.dataset.k] = t.value; });
document.addEventListener('change', e => { const t = e.target; if (t.dataset && t.dataset.c) { D[t.dataset.c] = t.checked; render(); } });
document.addEventListener('click', e => {
  const el = e.target.closest('[data-a]'); if (!el || el.tagName === 'INPUT') return;
  const a = el.dataset.a, x = el.dataset.x, r = el.dataset.r, s = el.dataset.s, u = el.dataset.u, f = el.dataset.f;
  if (a === 'closebg') { if (e.target !== el) return; ui.modal = null; return render(); }
  switch (a) {
    case 'google': return run(googleLogin);
    case 'authmode': ui.mode = x; if (el.dataset.e) ui.emode = el.dataset.e; D = {}; return render();
    case 'emode': ui.emode = x; return render();
    case 'mobilego': return run(mobileGo);
    case 'changepw': return run(changePassword);
    case 'logout': if (!ui.modal && !confirm('Log out of BillBhai?')) return; return run(async () => { await signOut(auth); ui.mode = 'welcome'; ui.tab = 'rooms'; ui.room = null; ui.friend = null; ui.modal = null; D = {}; });
    case 'saveprofile': return run(createProfile);
    case 'tab': ui.tab = x; ui.room = null; ui.friend = null; ui.fmsg = ''; render(); if (x === 'alerts') markInboxRead().catch(() => {}); return;
    case 'sub': ui.sub = x; return render();
    case 'openroom': ui.tab = 'rooms'; ui.friend = null; ui.room = r; return render();
    case 'back': if (ui.friend) ui.friend = null; else ui.room = null; return render();
    case 'openfriend': ui.friend = u; return render();
    case 'remindfr': return run(() => remindFriendRoom(r, u));
    case 'modal': D = x === 'bill' ? { mode: 'eq' } : {}; ui.modal = { t: x, r, s }; return render();
    case 'close': ui.modal = null; return render();
    case 'mode': D.mode = x; return render();
    case 'pay': ui.modal = { t: 'pay', r, s }; return render();
    case 'addfriend': return run(addFriend);
    case 'acceptfr': return run(async () => { await updateDoc(doc(db, 'friendships', f), { status: 'accepted' }); toast('Friend added ✅'); });
    case 'declinefr': return run(async () => { const fr = st.friendships.find(q => q.id === f); await deleteDoc(doc(db, 'friendships', f)); toast(fr && fr.requester === me() ? 'Request cancelled' : 'Request declined'); });
    case 'createroom': return run(createRoom);
    case 'delroomgo': return run(() => deleteRoom(r));
    case 'delacctgo': return run(deleteAccount);
    case 'addmembers': return run(addMembers);
    case 'addbill': return run(addBill);
    case 'claim': return run(() => claimPaid(r, s));
    case 'accept': return run(() => decideShare(r, s, true));
    case 'reject': return run(() => decideShare(r, s, false));
    case 'inapp': return run(() => remindInApp(r, s));
    case 'reqexit': return run(() => reqExit(r));
    case 'exitok': return run(() => decideExit(r, u, true));
    case 'exitno': return run(() => decideExit(r, u, false));
    case 'saveprof': return run(saveProfile);
    case 'push': return run(enablePush);
    case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } return render();
    case 'copy': return copy(x);
    case 'theme': lsSet('bb_theme', x); return render();
    case 'dmode': lsSet('bb_mode', x); return render();
  }
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; render(); });
try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (lsGet('bb_mode', 'auto') === 'auto') render(); }); } catch (e) { /* ignore */ }

/* ================= boot ================= */
try { const u = new URLSearchParams(location.search).get('u'); if (u) { lsSet('bb_invite', u.toLowerCase().replace(/[^a-z0-9_]/g, '')); history.replaceState(null, '', location.pathname); } } catch (e) { /* ignore */ }
if ('serviceWorker' in navigator && configured) navigator.serviceWorker.register('./firebase-messaging-sw.js').catch(() => {});
if (configured) {
  getRedirectResult(auth).catch(e => toast(friendly(e)));
  onAuthStateChanged(auth, u => { st.authReady = true; if (u) startSession(u); else endSession(); render(); });
}
render();
