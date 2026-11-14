import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_PROFILE_ID,
  ProfileStore,
  partitionFor,
  redactProfile,
} from "../dist/profile-store.js";

async function openStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ego-shell-store-"));
  const file = path.join(directory, "profiles.json");
  return { file, store: await ProfileStore.open(file) };
}

const BRAZIL = {
  name: "Shop BR",
  proxy: {
    scheme: "socks5",
    host: "proxy.example",
    port: "1080",
    username: "shop-user",
    password: "s3cret-pass",
  },
  fingerprint: { locale: "pt-br", timezone: "America/Sao_Paulo" },
};

test("a new store starts with a direct default profile", async () => {
  const { store } = await openStore();
  const [profile] = store.list();
  assert.equal(profile.id, DEFAULT_PROFILE_ID);
  assert.deepEqual(profile.proxy, { scheme: "none" });
  assert.equal(redactProfile(profile).isDefault, true);
});

test("created profiles persist with their own seed and storage partition", async () => {
  const { file, store } = await openStore();
  const first = await store.create(BRAZIL);
  const second = await store.create({ ...BRAZIL, name: "Shop MX" });

  assert.equal(first.proxy.port, 1080);
  assert.equal(first.fingerprint.locale, "pt-BR");
  assert.match(first.fingerprint.seed, /^[0-9a-f]{32}$/);
  assert.notEqual(first.fingerprint.seed, second.fingerprint.seed);
  assert.notEqual(partitionFor(first.id), partitionFor(second.id));
  assert.equal(partitionFor(first.id), `persist:profile-${first.id}`);

  const reopened = await ProfileStore.open(file);
  assert.deepEqual(reopened.get(first.id), first);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("redaction keeps the password inside the store", async () => {
  const { store } = await openStore();
  const redacted = redactProfile(await store.create(BRAZIL));
  assert.equal(redacted.proxy.hasPassword, true);
  assert.doesNotMatch(JSON.stringify(redacted), /s3cret-pass/);
});

test("an edit keeps the seed, and keeps the password when none is sent", async () => {
  const { store } = await openStore();
  const created = await store.create(BRAZIL);
  const { password, ...proxyWithoutPassword } = BRAZIL.proxy;

  const renamed = await store.update(created.id, {
    ...BRAZIL,
    name: "Shop BR 2",
    proxy: proxyWithoutPassword,
  });
  assert.equal(renamed.name, "Shop BR 2");
  assert.equal(renamed.fingerprint.seed, created.fingerprint.seed);
  assert.equal(renamed.proxy.password, password);

  const moved = await store.update(created.id, {
    ...BRAZIL,
    proxy: { ...proxyWithoutPassword, host: "other.example" },
  });
  assert.equal(
    moved.proxy.password,
    undefined,
    "a password must not follow the profile to a different proxy endpoint",
  );
});

test("invalid input is rejected before anything is written", async () => {
  const { file, store } = await openStore();
  const before = await readFile(file, "utf8");
  const invalid = [
    [{ ...BRAZIL, name: " " }, /name is required/],
    [{ ...BRAZIL, proxy: { ...BRAZIL.proxy, port: 70000 } }, /proxy\.port/],
    [
      { ...BRAZIL, proxy: { ...BRAZIL.proxy, scheme: "socks4" } },
      /proxy\.scheme/,
    ],
    [
      { ...BRAZIL, proxy: { ...BRAZIL.proxy, host: "user@host" } },
      /proxy\.host/,
    ],
    [{ ...BRAZIL, fingerprint: { timezone: "Mars/Olympus" } }, /timezone/],
    [{ ...BRAZIL, fingerprint: { locale: "not a locale" } }, /locale/],
    [{ ...BRAZIL, kernel: "firefox" }, /kernel/],
  ];
  for (const [input, message] of invalid) {
    await assert.rejects(store.create(input), message);
  }
  assert.equal(await readFile(file, "utf8"), before);
});

test("the default profile cannot be removed, others can", async () => {
  const { store } = await openStore();
  const created = await store.create(BRAZIL);
  await assert.rejects(store.remove(DEFAULT_PROFILE_ID), /cannot be removed/);
  await store.remove(created.id);
  assert.equal(store.get(created.id), undefined);
});

test("a profile runs on electron unless it asks for the apostate kernel", async () => {
  const { store } = await openStore();
  const plain = await store.create(BRAZIL);
  const patched = await store.create({ ...BRAZIL, kernel: "apostate" });
  assert.equal(plain.kernel, "electron");
  assert.equal(patched.kernel, "apostate");
  const back = await store.update(patched.id, {
    ...BRAZIL,
    kernel: "electron",
  });
  assert.equal(back.kernel, "electron");
});

test("a profiles file written before kernels existed loads as electron", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ego-shell-store-"));
  const file = path.join(directory, "profiles.json");
  const legacy = {
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: "Default",
        proxy: { scheme: "none" },
        fingerprint: { seed: "a".repeat(32), locale: "en-US", timezone: "UTC" },
      },
    ],
  };
  const text = JSON.stringify(legacy);
  await writeFile(file, text);
  const store = await ProfileStore.open(file);
  assert.equal(store.get(DEFAULT_PROFILE_ID).kernel, "electron");
  assert.equal(await readFile(file, "utf8"), text);
});
