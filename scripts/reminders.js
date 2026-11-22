const admin = require('firebase-admin');

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!sa.project_id) { console.error('FIREBASE_SERVICE_ACCOUNT secret is missing'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const DAY = 864e5;
const AFTER = Number(process.env.REMIND_AFTER_DAYS || 7) * DAY;
const APP_URL = process.env.APP_URL || './';
const rs = p => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function pushTo(uid, title, body) {
  const toks = await db.collection('users').doc(uid).collection('tokens').get();
  let sent = 0;
  for (const t of toks.docs) {
    try {
      await admin.messaging().send({ token: t.id, data: { title, body, url: APP_URL }, webpush: { headers: { Urgency: 'high' } } });
      sent++;
    } catch (e) {
      if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') await t.ref.delete();
      else console.warn('push failed', e.code);
    }
  }
  return sent;
}

(async () => {
  const now = Date.now();
  const nameCache = {};
  const nameOf = async uid => {
    if (!nameCache[uid]) { const s = await db.collection('users').doc(uid).get(); nameCache[uid] = s.exists ? s.data().name : 'a friend'; }
    return nameCache[uid];
  };
  let count = 0;
  const rooms = await db.collection('rooms').get();
  for (const room of rooms.docs) {
    const rd = room.data();
    const shares = await room.ref.collection('shares').where('status', '==', 'pending').get();
    for (const s of shares.docs) {
      const d = s.data();
      const created = d.createdAt ? d.createdAt.toMillis() : now;
      if (now - created < AFTER) continue;
      if (d.lastRemind && now - d.lastRemind.toMillis() < 20 * 3600 * 1000) continue;
      if (!(rd.members || []).includes(d.debtor)) continue;
      const payer = await nameOf(d.payer);
      const text = `⏰ Reminder: you have a pending payment of ${rs(d.amt)} to ${payer} for "${d.title}" (${rd.name}).`;
      await db.collection('users').doc(d.debtor).collection('inbox').add({
        from: 'system', roomId: room.id, type: 'reminder', text, read: false, createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await pushTo(d.debtor, 'Pending payment', text.replace('⏰ ', ''));
      await s.ref.update({ lastRemind: admin.firestore.Timestamp.now() });
      count++;
    }
  }
  console.log(`Reminders sent: ${count}`);
})().catch(e => { console.error(e); process.exit(1); });
