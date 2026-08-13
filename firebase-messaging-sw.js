importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBYEQQMbfR_YHq5nISaFRgZ0SOuAHWHWWU",
  projectId: "dukaflyer-ea62e",
  messagingSenderId: "149788171032",
  appId: "1:149788171032:web:2ddeb453162284eed8dc6d"
});

const messaging = firebase.messaging();

// Note: `silent: true` and `vibrate` are mutually exclusive per the Notifications
// spec — a silent notification suppresses vibration too. Since the whole point of
// Duka Live is a felt buzz in the merchant's pocket, we don't set `silent`.
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: '/favicon/icon-192.png',
    badge: '/favicon/favicon-32.png',
    tag: data.type || 'dukaflyer',       // collapse rapid duplicates into one notification
    renotify: true,
    vibrate: [40],
    data: { url: data.url || '/dashboard.html' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/dashboard.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('dashboard.html') && 'focus' in client) {
          client.postMessage({ type: 'duka-live-notification-click', url });
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Minimal fetch passthrough — required by some browsers' PWA installability
// checks (a "fetch" handler must be registered), but we deliberately don't
// cache anything here since Duka Live depends on always-fresh data.
self.addEventListener('fetch', () => {});
