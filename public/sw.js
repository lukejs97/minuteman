// Minuteman's service worker: shows the alerts the server pushes
// (web/src/push.ts, reminders.ts), also while Minuteman isn't open. On an
// iPhone that's the Home Screen app. Tapping one opens Minuteman.
self.addEventListener("push", (event) => {
  let alert = { title: "Minuteman", body: "", tag: "minuteman" };
  try {
    alert = { ...alert, ...event.data.json() };
  } catch {
    // Not one of ours: a plain notice.
  }
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      tag: alert.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => "focus" in w);
      return open ? open.focus() : self.clients.openWindow("/");
    }),
  );
});
