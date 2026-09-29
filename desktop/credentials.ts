import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { Vault } from "../server/store";

export async function desktopVault(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error(
      "can't use the macos keychain. unlock it and reopen the app.",
    );
  const path = join(directory, "vault-key.enc");
  let key: Buffer;
  let save = false;
  if (existsSync(path)) {
    const decoded = await safeStorage.decryptStringAsync(readFileSync(path));
    key = Buffer.from(decoded.result, "base64");
    save = decoded.shouldReEncrypt;
  } else {
    if (existsSync(join(directory, "secrets.enc")))
      throw new Error(
        "the credential key is missing. restore the data folder, or start fresh and import a backup.",
      );
    key = randomBytes(32);
    save = true;
  }
  if (key.length !== 32)
    throw new Error("the credential key is invalid");
  if (save) {
    const encrypted = await safeStorage.encryptStringAsync(
      key.toString("base64"),
    );
    writeFileSync(`${path}.tmp`, encrypted, { mode: 0o600 });
    chmodSync(`${path}.tmp`, 0o600);
    renameSync(`${path}.tmp`, path);
  }
  return new Vault(directory, key);
}
