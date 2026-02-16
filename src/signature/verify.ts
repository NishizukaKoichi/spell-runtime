import { createPublicKey, verify } from "node:crypto";
import { SpellBundleManifest } from "../types";
import { SpellError } from "../util/errors";
import { computeBundleDigest } from "./bundleDigest";
import { readSignatureFile } from "./signatureFile";
import { loadPublisherTrust, publisherFromId } from "./trustStore";

export type SignatureStatus = "verified" | "unsigned" | "untrusted" | "invalid";

export interface SignatureVerificationResult {
  ok: boolean;
  status: SignatureStatus;
  publisher: string;
  key_id?: string;
  digest?: string;
  message: string;
}

export async function verifyBundleSignature(
  manifest: SpellBundleManifest,
  bundlePath: string
): Promise<SignatureVerificationResult> {
  const publisher = publisherFromId(manifest.id);

  const sig = await readSignatureFile(bundlePath);
  if (!sig) {
    return {
      ok: false,
      status: "unsigned",
      publisher,
      message: "spell.sig.json not found"
    };
  }

  if (sig.publisher !== publisher) {
    return {
      ok: false,
      status: "invalid",
      publisher,
      key_id: sig.key_id,
      digest: sig.digest.value,
      message: `signature publisher mismatch: expected '${publisher}', got '${sig.publisher}'`
    };
  }

  const trust = await loadPublisherTrust(publisher);
  if (!trust) {
    return {
      ok: false,
      status: "untrusted",
      publisher,
      key_id: sig.key_id,
      digest: sig.digest.value,
      message: `no trusted key for publisher: ${publisher}`
    };
  }

  const key = trust.keys.find((entry) => entry.key_id === sig.key_id);
  if (!key) {
    return {
      ok: false,
      status: "untrusted",
      publisher,
      key_id: sig.key_id,
      digest: sig.digest.value,
      message: `trusted key_id not found: ${sig.key_id}`
    };
  }

  const digest = await computeBundleDigest(bundlePath);
  if (digest.valueHex !== sig.digest.value) {
    return {
      ok: false,
      status: "invalid",
      publisher,
      key_id: sig.key_id,
      digest: digest.valueHex,
      message: "digest mismatch"
    };
  }

  const signatureBytes = decodeBase64Url(sig.signature, "spell.sig.json.signature");
  const publicKeyDer = decodeBase64Url(key.public_key, "trust public_key");

  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  } catch (error) {
    return {
      ok: false,
      status: "untrusted",
      publisher,
      key_id: sig.key_id,
      digest: digest.valueHex,
      message: `invalid trusted public key: ${(error as Error).message}`
    };
  }

  const ok = verify(null, digest.value, publicKey, signatureBytes);
  if (!ok) {
    return {
      ok: false,
      status: "invalid",
      publisher,
      key_id: sig.key_id,
      digest: digest.valueHex,
      message: "signature verification failed"
    };
  }

  return {
    ok: true,
    status: "verified",
    publisher,
    key_id: sig.key_id,
    digest: digest.valueHex,
    message: "verified"
  };
}

export function enforceSignatureOrThrow(result: SignatureVerificationResult): void {
  if (result.ok) return;

  if (result.status === "unsigned") {
    throw new SpellError("signature required: spell.sig.json not found");
  }

  if (result.status === "untrusted") {
    throw new SpellError(`signature required: ${result.message}`);
  }

  throw new SpellError(`signature required: ${result.message}`);
}

function decodeBase64Url(value: string, label: string): Buffer {
  try {
    return Buffer.from(value, "base64url");
  } catch (error) {
    throw new SpellError(`invalid base64url for ${label}: ${(error as Error).message}`);
  }
}

