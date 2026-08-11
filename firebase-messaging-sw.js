importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBYEQQMbfR_YHq5nISaFRgZ0SOuAHWHWWU",
  projectId: "dukaflyer-ea62e",
  messagingSenderId: "149788171032",
  appId: "1:149788171032:web:2ddeb453162284eed8dc6d"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(payload.notification.title, {
    body: payload.notification.body,
    icon: '/favicon/apple-touch-icon.png',
    silent: true,
    vibrate: [40],
    data: { url: '/dashboard.html' }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});
