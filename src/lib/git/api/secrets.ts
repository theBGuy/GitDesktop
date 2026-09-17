// The OS-keychain credential store; GitHub Actions repo secrets (`ghSecrets*`)
// live in repo-config.ts.

import { invoke } from "@/lib/tauri/invoke";
import {
  COLD_START,
  coldStartDeleteSecret,
  coldStartGetSecret,
  coldStartSetSecret,
} from "@/lib/test-mode";

// Cold-start test mode keeps API keys in an isolated sessionStorage store so
// the OS keychain (and the user's real keys) are never touched (no-op normally).
export const setSecret = (provider: string, value: string) =>
  COLD_START
    ? Promise.resolve(coldStartSetSecret(provider, value))
    : invoke<void>("set_secret", { provider, value });

export const getSecret = (provider: string) =>
  COLD_START
    ? Promise.resolve(coldStartGetSecret(provider))
    : invoke<string | null>("get_secret", { provider });

export const deleteSecret = (provider: string) =>
  COLD_START
    ? Promise.resolve(coldStartDeleteSecret(provider))
    : invoke<void>("delete_secret", { provider });

export const secretExists = (provider: string) =>
  COLD_START
    ? Promise.resolve(coldStartGetSecret(provider) !== null)
    : invoke<boolean>("secret_exists", { provider });
