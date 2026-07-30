import { authBackend } from "@/lib/sync/backend";

export function ensureAnonymousUser(): Promise<string> {
  return authBackend.ensureAnonymousUser();
}
