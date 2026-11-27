"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

const subscribeNetwork = (callback: () => void) => {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
};
const isOffline = () => !navigator.onLine;
const subscribeInstallState = (callback: () => void) => {
  const media = window.matchMedia("(display-mode: standalone)");
  media.addEventListener("change", callback);
  window.addEventListener("appinstalled", callback);
  return () => {
    media.removeEventListener("change", callback);
    window.removeEventListener("appinstalled", callback);
  };
};
const isInstalled = () => window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent);

export default function PwaStatus() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const offline = useSyncExternalStore(subscribeNetwork, isOffline, () => false);
  const installed = useSyncExternalStore(subscribeInstallState, isInstalled, () => false);
  const ios = useSyncExternalStore(() => () => undefined, isIOS, () => false);

  useEffect(() => {
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => {
        const cacheLoadedResources = () => {
          const urls = performance.getEntriesByType("resource").map((entry) => new URL(entry.name).pathname).filter((path) => path.startsWith("/_next/static/"));
          registration.active?.postMessage({ type: "CACHE_APP_RESOURCES", urls });
        };
        if (registration.active) cacheLoadedResources();
        else void navigator.serviceWorker.ready.then(cacheLoadedResources);
      }).catch(() => undefined);
    } else if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
        const appRegistration = registrations.find((registration) => registration.active?.scriptURL === `${window.location.origin}/sw.js`);
        if (appRegistration) {
          await appRegistration.unregister();
          const cacheNames = await caches.keys();
          await Promise.all(cacheNames.filter((name) => name.startsWith("atmasutra-offline-")).map((name) => caches.delete(name)));
          window.location.reload();
        }
      });
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {offline && <span role="status" className="rounded-full bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100">Offline · saved copy; edits need connection</span>}
      {installed && <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">Installed app</span>}
      {!installed && installPrompt && <button type="button" onClick={() => void install()} className="min-h-10 rounded-full border border-gray-300 px-3 py-1.5 text-xs font-semibold hover:bg-gray-100 dark:border-gray-700 dark:hover:bg-gray-900">Install app</button>}
      {!installed && !installPrompt && ios && <span className="max-w-56 text-right text-xs text-gray-600 dark:text-gray-300">Install: Share, then Add to Home Screen</span>}
      {!installed && !installPrompt && !ios && <span className="max-w-56 text-right text-xs text-gray-600 dark:text-gray-300">Install from your browser menu</span>}
    </div>
  );
}
