// Alerts on this device, on the website: a phone (the Home Screen app, iOS
// 16.4 or later) or a browser. The server sends them (web/src/push.ts,
// reminders.ts) even while Minuteman isn't open, and the service worker
// (public/sw.js) shows them. The desktop apps alert by themselves; both get
// them, the phone and the computer alike.
import { pushKey, pushSubscribe, pushTest, pushUnsubscribe } from "./api";
import { fromB64url } from "./b64url";

export type PushState =
  /** This browser can't (no service workers or push). */
  | "unsupported"
  /** An iPhone or iPad in Safari: alerts need the Home Screen app. */
  | "homeScreen"
  /** Notifications are blocked for the site. */
  | "blocked"
  | "off"
  | "on";

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const standalone = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia("(display-mode: standalone)").matches;

/** The service worker, registered once. */
let registration: Promise<ServiceWorkerRegistration> | null = null;
function worker(): Promise<ServiceWorkerRegistration> {
  registration ??= navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready);
  return registration;
}

/** Whether alerts are on here, or why they can't be. */
export async function pushState(): Promise<PushState> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return isIOS() && !standalone() ? "homeScreen" : "unsupported";
  }
  if (isIOS() && !standalone()) return "homeScreen";
  if (Notification.permission === "denied") return "blocked";
  const subscription = await (await worker()).pushManager.getSubscription().catch(() => null);
  return subscription && Notification.permission === "granted" ? "on" : "off";
}

/** Turns alerts on here (asks to allow notifications first). Resolves to the new state. */
export async function turnOnPush(): Promise<PushState> {
  // Asked straight away, while it's still the tap that asked (iOS needs that).
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "blocked" : "off";
  const reg = await worker();
  const key = fromB64url(await pushKey());
  const subscription =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource }));
  const json = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await pushSubscribe({ endpoint: json.endpoint, keys: json.keys }, location.origin);
  return "on";
}

export async function turnOffPush(): Promise<PushState> {
  const subscription = await (await worker()).pushManager.getSubscription();
  if (subscription) {
    await pushUnsubscribe(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
  return "off";
}

/** Sends a test alert to every device that's on. */
export const sendTestPush = () => pushTest();
