self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || 'خفيف', {
    body: d.body || 'رسالة جديدة',
    dir: 'rtl', lang: 'ar', icon: '/icon-192.png', badge: '/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) return c.focus();
    return clients.openWindow('/');
  }));
});
