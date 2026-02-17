import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadManifestFromDir } from "../bundle/manifest";
import { SpellError } from "../util/errors";
import { sanitizeIdForFilename } from "../util/idKey";
import { computeBundleDigest } from "./bundleDigest";
import { publisherFromId } from "./trustStore";

interface KeygenOptions {
  publisher: string;
  keyId: string;
  outDir: string;
}

export interface KeygenResult {
  publisher: string;
  keyId: string;
  privateKeyPath: string;
  publicKeyPath: string;
  publicKeyBase64Url: string;
}

interface SignBundleOptions {
  bundlePath: string;
  privateKeyPath: string;
  keyId: string;
  publisher?: string;
}

export interface SignBundleResult {
  signaturePath: string;
  digestHex: string;
  publisher: string;
  keyId: string;
}

export async function generateSigningKeypair(options: KeygenOptions): Promise<KeygenResult> {
  validateSimpleToken(options.publisher, "publisher");
  validateSimpleToken(options.keyId, "key id");

  const outDir = path.resolve(options.outDir);
  const safePublisher = sanitizeIdForFilename(options.publisher);
  const safeKeyId = sanitizeIdForFilename(options.keyId);

  await mkdir(outDir, { recursive: true });

  const privateKeyPath = path.join(outDir, `${safePublisher}__${safeKeyId}.private.pem`);
  const publicKeyPath = path.join(outDir, `${safePublisher}__${safeKeyId}.public.b64url.txt`);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;

  await writeFile(privateKeyPath, privatePem, { encoding: "utf8", mode: 0o600 });
  await writeFile(publicKeyPath, `${publicDer.toString("base64url")}\n`, "utf8");

  return {
    publisher: options.publisher,
    keyId: options.keyId,
    privateKeyPath,
    publicKeyPath,
    publicKeyBase64Url: publicDer.toString("base64url")
  };
}

export async function signBundleFromPrivateKey(options: SignBundleOptions): Promise<SignBundleResult> {
  validateSimpleToken(options.keyId, "key id");

  const bundlePath = path.resolve(options.bundlePath);
  const { manifest } = await loadManifestFromDir(bundlePath);
  const derivedPublisher = publisherFromId(manifest.id);
  const publisher = options.publisher?.trim() || derivedPublisher;
  if (publisher !== derivedPublisher) {
    throw new SpellError(`publisher mismatch: manifest expects '${derivedPublisher}', got '${publisher}'`);
  }

  const privateKeyRaw = await readFile(path.resolve(options.privateKeyPath), "utf8").catch(() => {
    throw new SpellError(`private key file not found: ${options.privateKeyPath}`);
  });

  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(privateKeyRaw);
  } catch (error) {
    throw new SpellError(`failed to parse private key: ${(error as Error).message}`);
  }

  const digest = await computeBundleDigest(bundlePath);
  const signature = sign(null, digest.value, privateKey).toString("base64url");

  const signaturePath = path.join(bundlePath, "spell.sig.json");
  const payload = {
    version: "v1",
    publisher,
    key_id: options.keyId,
    algorithm: "ed25519",
    digest: {
      algorithm: "sha256",
      value: digest.valueHex
    },
    signature
  } as const;

  await writeFile(signaturePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  return {
    signaturePath,
    digestHex: digest.valueHex,
    publisher,
    keyId: options.keyId
  };
}

function validateSimpleToken(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new SpellError(`${label} must not be empty`);
  }
  if (/[\x00-\x1F\x7F]/.test(value)) {
    throw new SpellError(`${label} must not contain control characters`);
  }
}
