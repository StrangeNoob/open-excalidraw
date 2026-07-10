import { useSyncExternalStore } from "react";

export type ConnectivityState = "online" | "offline";

export interface ConnectivitySource {
  getSnapshot(): ConnectivityState;
  subscribe(listener: () => void): () => void;
}

export const browserConnectivity: ConnectivitySource = {
  getSnapshot: () => (navigator.onLine ? "online" : "offline"),
  subscribe(listener) {
    window.addEventListener("online", listener);
    window.addEventListener("offline", listener);
    return () => {
      window.removeEventListener("online", listener);
      window.removeEventListener("offline", listener);
    };
  },
};

export const useConnectivity = (
  source: ConnectivitySource = browserConnectivity,
): ConnectivityState =>
  useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  );
