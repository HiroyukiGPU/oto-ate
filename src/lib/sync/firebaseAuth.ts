// 1:1 passthrough wrapper around today's firebase/auth calls — same rationale
// as firebaseBackend.ts. This is exactly the body ensureAnonymousUser() had
// in src/lib/auth.ts before the sync/ abstraction existed.
import { onAuthStateChanged, signInAnonymously } from "firebase/auth";
import { auth } from "@/lib/firebase";
import type { AuthBackend } from "@/lib/sync/types";

export const firebaseAuthBackend: AuthBackend = {
  ensureAnonymousUser(): Promise<string> {
    if (auth.currentUser) {
      return Promise.resolve(auth.currentUser.uid);
    }

    return new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(
        auth,
        (user) => {
          if (!user) return;
          unsubscribe();
          resolve(user.uid);
        },
        (error) => {
          unsubscribe();
          reject(error);
        },
      );
      signInAnonymously(auth).catch((error) => {
        unsubscribe();
        reject(error);
      });
    });
  },
};
